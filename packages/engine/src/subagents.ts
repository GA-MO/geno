import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { z } from 'zod';
import type { Tool, ToolUseBlock } from '@anthropic-ai/sdk/resources/messages/messages';
import {
  AGENT_TOOL,
  AGENT_TOOL_DEFINITIONS,
  type AgentDefinition,
  agentMention,
  type AgentSource,
  agentToolDefinition,
  asSessionId,
  type AssistantTurn,
  builtinAgents,
  childCaps,
  childDepth,
  type ChildCaps,
  type ChildEnd,
  childEndOf,
  childEndWords,
  type ChildNote,
  type ChildOf,
  childReport,
  type ChildStart,
  childrenOf,
  findAgent,
  childSummary,
  childSystemPrompt,
  type Effort,
  DEFERRED_TOOLS_NOTE,
  FIELD_TYPES,
  type FieldValue,
  type OutputSchema,
  EXTERNAL_BACKENDS,
  forkOpening,
  forkTask,
  GENO_NOTE,
  grantsMcp,
  handedBack,
  isPartial,
  isReadOnly,
  laneSentence,
  type McpGrant,
  mergeAgents,
  MESSAGE_AGENT_TOOL,
  STOP_AND_WAIT,
  messageAgentResult,
  nextSeq,
  noticeFor,
  type ParentMoment,
  type SubagentModels,
  parseAgentDefinition,
  parseLaneName,
  type LaneName,
  readFields,
  REPORT_DELIVERED,
  reportMessageOf,
  resumeEvent,
  REPORT_TOOL,
  REPORT_TOOL_DEFINITION,
  STRUCTURED_OUTPUT_TOOL,
  structuredFields,
  structuredOutputTool,
  withFields,
  type HookContextEvent,
  type Session,
  sessionEffortOf,
  type SessionId,
  toldOf,
  toolRoster,
  type TurnEvent,
  type Waiter,
  withoutInstructions,
  WEB_TOOLS,
  ZERO_USAGE,
  configPaths,
  type ConfigHomes,
} from '@g-code/core';
import { formatCost, totalOf, type OpenSession } from './chat.js';
import type { Io } from './command.js';
import { drive, type Limits, type Mode, type Watcher } from './drive.js';
import { captureEnvironment } from './environment.js';
import { EngineError } from './errors.js';
import { DISK_FILES, type Files } from './files.js';
import { workingDiff } from './git.js';
import { settleChildLane, type LaneSession, type SettledLane } from './lanes.js';
import type { InstalledPlugin } from './plugins.js';
import { parseFrontmatter, readIfFile, shownPath, sortedEntries } from './project-context.js';
import { ExternalAgents, runExternalTurn, type KeyOf } from './external.js';
import { appendEvent, dropTornTail, readSessionLog, sessionFile, type SessionLog } from './sessions.js';
import type { Store } from './store.js';
import type { SteerInbox, Steers } from './steer.js';
import type { Wakes } from './wakes.js';
import type { McpToolset } from './mcp/hub.js';
import type { Approval } from './tools/agent.js';
import { rosterExecutors } from './tools/tool-search.js';
import { executor, ToolError, ToolRejected, type Executor } from './tools/context.js';
import type { Executors } from './tools/index.js';
import type { HookAgent, SubagentHooks, ToolHooks } from './hooks.js';

/** Each problem names its file; a file that cannot be used is reported and skipped, never thrown. */
export type AgentScan = { readonly agents: readonly AgentDefinition[]; readonly problems: readonly string[] };

type DirLoad = { readonly show: (file: string) => string; readonly problems: string[]; readonly models: SubagentModels };

async function loadAgentDir(dir: string, source: AgentSource, namespace: string, { show, problems, models }: DirLoad): Promise<AgentDefinition[]> {
  const agents: AgentDefinition[] = [];
  for (const entry of await sortedEntries(dir)) {
    if (!entry.name.endsWith('.md')) continue;
    const file = path.join(dir, entry.name);
    const raw = await readIfFile(file);
    if (raw === undefined) continue;
    const { fields, body } = parseFrontmatter(raw);
    const parsed = parseAgentDefinition(fields, body, { source, path: show(file), fallbackName: entry.name.slice(0, -'.md'.length), namespace }, models);
    if (parsed.kind === 'skipped') {
      problems.push(`${show(file)}: skipped, ${parsed.reason}`);
      continue;
    }
    for (const note of parsed.notes) problems.push(`${show(file)}: ${note}`);
    agents.push(parsed.agent);
  }
  return agents;
}

/**
 * The agents a session can start, with Claude Code plugins' agents read in place and named `<plugin>:<agent>`, and
 * each one's model resolved against `models`.
 */
export async function loadAgents(workspace: string, homes: ConfigHomes, plugins: readonly InstalledPlugin[], models: SubagentModels): Promise<AgentScan> {
  const problems: string[] = [];
  const load: DirLoad = { show: (file: string) => shownPath(workspace, file), problems, models };
  const groups = [];
  // In precedence order, as for commands: the user's folders, then the workspace's, then plugins, then the built-ins.
  for (const root of configPaths(homes, workspace, 'agents')) groups.push(await loadAgentDir(root.path, root.place === 'user' ? 'global' : 'workspace', '', load));
  for (const plugin of plugins) groups.push(await loadAgentDir(path.join(plugin.root, 'agents'), 'plugin', `${plugin.name}:`, load));
  const agents = mergeAgents([...groups, builtinAgents(models)]);
  for (const agent of groups.flat()) {
    const winner = agents.find((a) => a.name === agent.name)!;
    if (agent.source === 'workspace' && winner.source === 'global') problems.push(`${agent.path}: not loaded, because your own agent ${agent.name} (${winner.path}) has its name`);
  }
  return { agents, problems };
}

/** One child as the host shows it. */
export type ChildView = {
  readonly id: SessionId;
  readonly parentId: SessionId;
  readonly toolUseId: string;
  readonly agent: AgentDefinition;
  readonly task: string;
  readonly model: string;
  readonly effort: Effort;
  readonly caps: ChildCaps;
  readonly start: ChildStart;
  /** The child's own session log, which holds its whole transcript. */
  readonly file: string;
};

export type ChildSpent = { readonly turns: number; readonly costUsd: number | null };

/** Where children show: the terminal, or the editor over ACP. */
export type SubagentHost = {
  /** The child's session exists and is about to run; `cancel` stops it alone. Returns where its progress goes. */
  started(child: ChildView, cancel: () => void): Promise<Watcher>;
  ended(child: ChildView, end: ChildEnd, spent: ChildSpent): Promise<void>;
};

const QUIET: Watcher = { text: () => {}, toolStart: () => {}, toolEnd: () => {}, logged: () => {} };

export function terminalChildHost(io: Io): SubagentHost {
  return {
    async started(child) {
      io.out(`> ${child.agent.name} started (${child.model}, caps ${child.caps.maxTurns} turns $${child.caps.maxCostUsd}), log: ${child.file}`);
      return { ...QUIET, toolStart: (_use, title) => io.out(`  ${child.agent.name}> ${title}`) };
    },
    async ended(child, end, spent) {
      io.out(`> ${child.agent.name} ${childEndWords(end)}, turns=${spent.turns} ${formatCost(spent.costUsd)}`);
    },
  };
}

/** A lane a child works in: the lane, and its tools under an approval, whose commands a sandbox of the lane's own holds to it. */
export type ChildLane = {
  readonly lane: LaneSession;
  readonly executors: (approval: Approval) => Executors;
  /** Closes the lane's sandbox. The lane stays for the child's end to keep or remove. */
  close(): Promise<void>;
};

/** Opens the lane `name` for the child `child`: the lane of that name when there is one, else a new one. */
export type OpenChildLane = (name: LaneName, child: SessionId) => Promise<ChildLane>;

/** At most this many read-only or lane children of one parent run at once. */
export const MAX_PARALLEL_CHILDREN = 4;

export type SubagentEnv = {
  readonly io: Io;
  readonly store: Store;
  readonly parent: OpenSession;
  readonly agents: readonly AgentDefinition[];
  /** The parent run's limits. Its cost limit is also the most all its children together may spend. */
  readonly limits: Limits;
  readonly approval: Approval;
  /** A non-interactive run starts only read-only children unless this is set. */
  readonly allowWriters: boolean;
  readonly files: Files;
  readonly host: SubagentHost;
  /** Every tool a child could call, under the approval the child runs with. */
  readonly executors: (approval: Approval) => Executors;
  /** The MCP tools a child's grant takes, under the rules and the approval it runs with; undefined gives no child MCP. */
  readonly mcp?: ((approval: Approval, grant: McpGrant) => Promise<McpToolset | undefined>) | undefined;
  /** The parent's tools and system prompt, which a fork reuses so that it shares the parent's cached prefix. */
  readonly parentMode: () => Pick<Mode, 'tools' | 'system'>;
  readonly readRoots: readonly string[];
  readonly writeRoots: readonly string[];
  /** Where a child on an external agent runs its process; undefined starts one for that child alone. */
  readonly externals?: ExternalAgents | undefined;
  readonly keyOf?: KeyOf | undefined;
  /** The engine's inboxes: each child gets one, and the parent's session takes a background child's report. */
  readonly steers: Steers;
  /** What the parent's session waits on to be woken; undefined where nothing wakes it, and a turn waits for its children. */
  readonly waits?: Wakes | undefined;
  /** The calls come from a workflow, not a model, and may set each step's model and caps. */
  readonly steps?: boolean | undefined;
  /** The engine process the children run in, named in each child's start so the next engine can tell one it cut off. */
  readonly waiter?: Waiter | undefined;
  /** The tool hooks a child's calls meet, under the approval that asks for that child; undefined runs none. */
  readonly toolHooks?: ((approval: Approval, agent: HookAgent) => ToolHooks | undefined) | undefined;
  /** SubagentStart and SubagentStop for a child whose log is `transcript`; undefined runs neither. */
  readonly subagentHooks?: ((agent: HookAgent, transcript: string, approval: Approval) => SubagentHooks | undefined) | undefined;
  /** Where an isolated child, or a workflow step with a lane, works; undefined refuses them. */
  readonly lanes?: OpenChildLane | undefined;
};

/** What a workflow step sets on its child: the model, caps in place of the definition's, and the fields its report ends with. */
type StepOptions = {
  readonly model?: string | undefined;
  readonly max_turns?: number | undefined;
  readonly max_cost_usd?: number | undefined;
  readonly lane?: string | undefined;
  readonly schema?: OutputSchema | undefined;
};

type ChildEndNote = Extract<ChildNote, { kind: 'child-end' }>;

/** The model a new child runs on. A fork shares the parent's cached prefix only on the parent's model. */
const childModel = (agent: AgentDefinition, { start, step }: { readonly start: ChildStart; readonly step: StepOptions }, parentModel: string): string =>
  agent.backend !== undefined ? agent.backend : start === 'fork' ? parentModel : (step.model ?? agent.model ?? parentModel);

/** Where a new child works: a lane of its own, named after it, or the workflow run's lane that its step names. */
type LaneWant = { readonly kind: 'own' } | { readonly kind: 'named'; readonly name: string };

const ownLaneName = (agent: AgentDefinition, id: SessionId): string => {
  const slug = agent.name.toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^[^a-z0-9]+/, '').slice(0, 32);
  return `${slug === '' ? 'agent' : slug}-${id.slice(0, 8)}`;
};

// An external agent already works in a lane of its own. A step's lane is the run's, so the run's steps share it.
const laneWant = (agent: AgentDefinition, input: { readonly lane?: string | undefined; readonly isolation?: 'worktree' | undefined }, parentId: SessionId): LaneWant | undefined =>
  agent.backend !== undefined
    ? undefined
    : input.lane !== undefined
      ? { kind: 'named', name: `${input.lane}-${parentId.slice(0, 8)}` }
      : input.isolation === 'worktree' || agent.isolation === 'worktree'
        ? { kind: 'own' }
        : undefined;

/** The lane a run works in, by its raw name; undefined for the main checkout. */
const laneNameOf = (agent: AgentDefinition, run: ChildRun, id: SessionId): string | undefined =>
  run.kind === 'resume' ? run.of.lane : run.lane === undefined ? undefined : run.lane.kind === 'own' ? ownLaneName(agent, id) : run.lane.name;

const keptLaneNote = (agent: AgentDefinition, { record, files }: Extract<SettledLane, { kind: 'kept' }>): string => {
  const shown = files.length > 20 ? `${files.slice(0, 20).join(', ')} and ${files.length - 20} more` : files.join(', ');
  return [
    `${GENO_NOTE} ${agent.name}'s edits are in lane ${record.name}, on branch ${record.branch} at ${record.path}, not in your checkout.`,
    ...(files.length === 0 ? [] : [`Files changed: ${shown}.`]),
    `Read them there to review them; the user applies them from the Lanes pane or with gcode lane apply ${record.name}.`,
  ].join(' ');
};

/**
 * A child's report as its parent's tool result, its end for the parent's log, whether the child failed with nothing to
 * say, and whether it stopped on a call the user rejected.
 */
type ChildOutcome = { readonly text: string; readonly ended: ChildEndNote; readonly failed: boolean; readonly rejected: boolean };

/**
 * What a child's run starts from: a new session for its task, or the child's own log, which its parent's message
 * resumes after the report the child handed back, or after where a run that Geno's stop cut off ends.
 */
type ChildRun =
  | { readonly kind: 'spawn'; readonly task: string; readonly start: ChildStart; readonly step: StepOptions; readonly background: boolean; readonly lane: LaneWant | undefined }
  | { readonly kind: 'resume'; readonly message: string; readonly log: SessionLog; readonly of: ChildOf; readonly moment: Exclude<ParentMoment, 'working'> };

/** A child's log as its run begins: what the run's first prompt is, when the run began, and the task the user sees it on. */
type OpenedChild = { readonly log: SessionLog; readonly start: ChildStart; readonly task: string; readonly prompt: string; readonly at: string };

export type Subagents = {
  readonly tool: Tool;
  readonly executor: Executor;
  /** `message_agent`, offered with `agent` and only with it. */
  readonly message: Executor;
  /**
   * task_stop of a background child this run started: cancels it and settles with its partial report, which no other
   * message repeats. Undefined when no such child runs.
   */
  stop(childId: string): Promise<string> | undefined;
  /** Cancels the background children still running, once the parent's run ended with nobody left to take their reports. */
  stopBackground(): void;
  /** The parent's run ended and lets its background children run on: their ends go to the session with their reports. */
  detach(): void;
  /** Settles once every child started so far has ended and logged its end. */
  settled(): Promise<void>;
};

const inputSchema = z.strictObject({
  agent: z.string().min(1),
  task: z.string(),
  fork: z.boolean().optional(),
  background: z.boolean().optional(),
  model: z.string().min(1).optional(),
  max_turns: z.int().positive().optional(),
  max_cost_usd: z.number().positive().optional(),
  lane: z.string().min(1).optional(),
  isolation: z.literal('worktree').optional(),
  schema: z.record(z.string(), z.enum(FIELD_TYPES)).optional(),
});
const STEP_FIELDS = ['model', 'max_turns', 'max_cost_usd', 'lane', 'schema'] as const;
const messageSchema = z.strictObject({ agent_session: z.string().min(1), text: z.string().trim().min(1) });

/** A child's report call: it only says it went through, and the loop ends the child's run after it. */
const reportExecutor = executor({
  input: z.strictObject({ message: z.string().trim().min(1, 'the report is empty; put everything the agent that started you needs in message') }),
  concurrent: () => true,
  describe: () => REPORT_TOOL,
  run: async () => REPORT_DELIVERED,
});

/** A schema step's structured_output call: it says the fields went through, or why they did not. */
const structuredExecutor = (schema: OutputSchema): Executor =>
  executor({
    input: z.record(z.string(), z.unknown()),
    concurrent: () => true,
    describe: () => STRUCTURED_OUTPUT_TOOL,
    run: async (input) => {
      const fields = structuredFields(input, schema);
      if (!fields.ok) throw new ToolError(fields.problem);
      return 'Fields delivered to the workflow.';
    },
  });

/**
 * When a schema step's child ends with a forced structured_output call, from `GCODE_STRUCTURED_OUTPUT`: by default
 * (`on`) only when its report has no JSON block that fits the schema, `always` after every report, whose block the
 * call's fields then replace, and `off` never. The forced call's fields contradicted a fitting block in the P34 eval
 * (docs/results/p34-structured-output.md), so the block comes first by default.
 */
export type StructuredOutput = 'on' | 'always' | 'off';
export const structuredOutputOf = (env: Readonly<Record<string, string | undefined>>): StructuredOutput => {
  const raw = env['GCODE_STRUCTURED_OUTPUT'];
  return raw === 'always' || raw === 'off' ? raw : 'on';
};

/** Runs work under one key after the work already queued under it; work with no key runs at once. */
function exclusive() {
  const tails = new Map<string, Promise<unknown>>();
  return <T>(key: string | undefined, work: () => Promise<T>): Promise<T> => {
    if (key === undefined) return work();
    const done = (tails.get(key) ?? Promise.resolve()).then(work);
    const tail = done.catch(() => {});
    tails.set(key, tail);
    void tail.then(() => {
      if (tails.get(key) === tail) tails.delete(key);
    });
    return done;
  };
}

function semaphore(size: number) {
  let free = size;
  const waiting: (() => void)[] = [];
  return async <T>(work: () => Promise<T>): Promise<T> => {
    if (free > 0) free--;
    else await new Promise<void>((resolve) => waiting.push(resolve));
    try {
      return await work();
    } finally {
      const next = waiting.shift();
      if (next === undefined) free++;
      else next();
    }
  };
}

const pick = (executors: Executors, names: readonly string[]): Executors =>
  Object.fromEntries(names.flatMap((name) => (Object.hasOwn(executors, name) ? [[name, executors[name]!]] : [])));

/**
 * What a fresh child is offered: its own tools, and with MCP the tools of its grant behind tool_search, told at the
 * safe point as the parent's are. Only the MCP tools are deferred, so the report tool is always offered in full.
 */
function freshOffer(agent: AgentDefinition, tools: readonly Tool[], executors: Executors, mcp: McpToolset | undefined): Pick<Mode, 'tools' | 'system' | 'executors' | 'notice'> {
  if (mcp === undefined) return { tools, system: childSystemPrompt(agent), executors };
  const roster = toolRoster(tools, mcp.tools, Number.POSITIVE_INFINITY);
  return {
    tools: roster.offered,
    system: `${childSystemPrompt(agent)}\n\n${DEFERRED_TOOLS_NOTE}`,
    executors: rosterExecutors(roster, { ...executors, ...mcp.executors }),
    notice: async (events) => noticeFor(events, { mode: undefined, memory: toldOf(events).memory, mcp: mcp.briefing }),
  };
}

/** The abort reason of a child that task_stop stopped, so its end reads as the model's stop and not the user's. */
const MODEL_STOP = Symbol('task_stop');

const asker = (approval: Approval, name: string, sessionId: SessionId): Approval =>
  approval.kind === 'interactive' ? { ...approval, approve: (denial, classifier) => approval.approve(denial, classifier, { name, sessionId }) } : approval;

export function subagents(env: SubagentEnv): Subagents {
  const { io, store, parent, agents } = env;
  const parallel = semaphore(MAX_PARALLEL_CHILDREN);
  // The writers of one checkout, the main one or a lane, take turns; children in different checkouts run side by side.
  const checkout = exclusive();
  // Each child until its end is logged, so `settled` never returns while an end is still on its way to the log.
  const running = new Set<Promise<unknown>>();
  const track = <T>(work: Promise<T>): Promise<T> => {
    running.add(work);
    void work.finally(() => running.delete(work)).catch(() => {});
    return work;
  };
  let committed = 0;
  const byName = (name: string) => findAgent(agents, name);
  const inBackground = new Set<AbortController>();
  // The background children that run now, each by its session id, for task_stop.
  const stoppers = new Map<string, () => Promise<string>>();
  // Set once the parent's run ended with nobody left to take a report.
  let unheard = false;
  // Set once the parent's run ended and its children run on to wake the session.
  let detached = false;

  const openSpawn = async (
    agent: AgentDefinition,
    run: Extract<ChildRun, { kind: 'spawn' }>,
    use: { readonly id: string },
    id: SessionId,
    caps: ChildCaps,
    parentEvents: readonly TurnEvent[],
    started: HookContextEvent | undefined,
    place: ChildLane | undefined,
  ): Promise<OpenedChild> => {
    const parentSession = parent.log.session;
    const { start, task, step } = run;
    const header = parentEvents[0];
    const inherited = header?.kind === 'session-start' ? header.environment : undefined;
    const workspace = place?.lane.record.path ?? parentSession.workspace;
    // A fresh child in a lane is told of its lane by its own environment; a fork keeps its parent's, for the cache.
    const placed =
      place === undefined || inherited === undefined || start === 'fork' ? inherited : await captureEnvironment({ workspace, scratchpad: inherited.scratchpad, env: io.env });
    // A fork keeps all of its parent's opening, for the cache.
    const lean = agent.omitClaudeMd && start === 'fresh';
    const environment = lean && placed?.git !== undefined ? { ...placed, git: 'omitted' as const } : placed;
    const context = header?.kind === 'session-start' ? header.context : undefined;
    const session: Session = {
      id,
      createdAt: new Date().toISOString(),
      workspace,
      provider: parentSession.provider,
      model: childModel(agent, run, parentSession.model),
      effort: agent.effort ?? sessionEffortOf(parentSession, parentEvents),
      ...(agent.backend === undefined ? {} : { backend: { id: agent.backend } }),
    };
    const file = sessionFile(store, session.id);
    const opening: TurnEvent[] = [
      {
        kind: 'session-start',
        session,
        context: lean && context !== undefined ? withoutInstructions(context, agent) : context,
        memory: lean || header?.kind !== 'session-start' ? undefined : header.memory,
        // The parent's, so a child knows where it runs; it shares the parent's scratchpad.
        environment,
        child: {
          parentId: parentSession.id,
          toolUseId: use.id,
          role: agent.name,
          caps,
          start,
          depth: childDepth(header?.kind === 'session-start' ? header.child : undefined),
          ...(run.background ? { background: true } : {}),
          ...(place === undefined ? {} : { lane: place.lane.record.name }),
        },
      },
      ...(start === 'fork' ? forkOpening(parentEvents, use.id, session.createdAt) : []),
    ];
    // SubagentStart's context, just before the task the run logs first.
    if (started !== undefined) opening.push({ ...started, seq: nextSeq(opening) });
    for (const event of opening) await appendEvent(file, event);
    const log: SessionLog = { file, session, events: opening, tornLine: undefined, goodBytes: 0 };
    const lanePlace = place === undefined ? undefined : { name: place.lane.record.name, branch: place.lane.record.branch, main: place.lane.repo.main };
    const forkLane =
      lanePlace === undefined
        ? ''
        : `\n\n${GENO_NOTE} You work in lane ${laneSentence(lanePlace)} Your workspace is ${workspace}: paths in the conversation above are the main checkout's, and the same relative paths name the lane's copies.`;
    return { log, start, task, prompt: start === 'fork' ? `${forkTask(agent, task)}${forkLane}` : task, at: session.createdAt };
  };

  // One lane at a time, so that two children's `git worktree add` never race on the repository's shared git folder.
  let opening: Promise<unknown> = Promise.resolve();
  const openLane = (agent: AgentDefinition, raw: string | undefined, id: SessionId): Promise<ChildLane | undefined> => {
    if (raw === undefined) return Promise.resolve(undefined);
    const name = parseLaneName(raw);
    const open = env.lanes;
    if (name === undefined) return Promise.reject(new ToolError(`${raw} cannot name a lane: use letters, digits, dot, dash and underscore`));
    if (open === undefined) return Promise.reject(new ToolError(`${agent.name} runs in a lane, and this session cannot start one`));
    const opened = opening.then(() =>
      open(name, id).catch((error: unknown) => {
        throw error instanceof EngineError ? new ToolError(`${agent.name} runs in a lane, and ${error.message}`) : error;
      }),
    );
    opening = opened.catch(() => {});
    return opened;
  };

  // The run goes on from where the child's log ends, with the message as its parent's steer and nothing left to prompt.
  // SubagentStart's context goes in again only when the child's log does not already hold the same text, as in Claude Code.
  const openResume = async ({ log, message, of, moment }: Extract<ChildRun, { kind: 'resume' }>, started: HookContextEvent | undefined): Promise<OpenedChild> => {
    await dropTornTail(log);
    const at = new Date().toISOString();
    const events = [...log.events];
    const held = (event: TurnEvent) => event.kind === 'hook-context' && event.event === 'SubagentStart' && JSON.stringify(event.notes) === JSON.stringify(started?.notes);
    if (started !== undefined && !events.some(held)) {
      const context = { ...started, seq: nextSeq(events) };
      await appendEvent(log.file, context);
      events.push(context);
    }
    const resumed = resumeEvent(message, nextSeq(events), at, moment);
    await appendEvent(log.file, resumed);
    return { log: { ...log, events: [...events, resumed] }, start: of.start, task: message, prompt: '', at };
  };

  const runChild = async (
    agent: AgentDefinition,
    run: ChildRun,
    use: { readonly id: string },
    ctx: Parameters<Executor['run']>[1],
    id: SessionId,
    inbox: SteerInbox,
    laneName: string | undefined,
  ): Promise<ChildOutcome> => {
    // A resumed child gets its spawn's caps afresh, held like any child's to what this run has left for children.
    const asked = run.kind === 'spawn' ? { maxTurns: run.step.max_turns, maxCostUsd: run.step.max_cost_usd } : run.of.caps;
    const { provider, model } = parent.log.session;
    const on = { provider, model: run.kind === 'spawn' ? childModel(agent, run, model) : run.log.session.model };
    const caps = childCaps(agent, env.limits.maxCostUsd - committed, on, asked);
    if (caps === undefined) throw new ToolError(`the subagents of this run have spent their $${env.limits.maxCostUsd} together; finish without another one`);
    const place = await openLane(agent, laneName, id);
    try {
      return await runPlaced(agent, run, use, ctx, id, inbox, caps, place);
    } finally {
      await place?.close();
    }
  };

  /**
   * A schema step's fields, from one more call after its report, forced to structured_output with the schema as its
   * input's JSON Schema. Undefined, which leaves the report's JSON block to stand, when the step's caps are spent, the
   * provider or the model cannot force the call, or the call's input does not fit the schema.
   */
  const forceFields = async (
    schema: OutputSchema,
    childIo: Io,
    opened: OpenSession,
    mode: Mode,
    ran: readonly TurnEvent[],
    caps: ChildCaps,
    surface: Parameters<typeof drive>[6],
  ): Promise<{ readonly events: readonly TurnEvent[]; readonly fields: Readonly<Record<string, FieldValue>> | undefined } | undefined> => {
    const spent = totalOf(ran);
    const left = caps.maxCostUsd - (spent.costUsd ?? 0);
    if (spent.turns >= caps.maxTurns || left <= 0) return undefined;
    const forcedMode: Mode = {
      tools: [...mode.tools, structuredOutputTool(schema)],
      executors: { [STRUCTURED_OUTPUT_TOOL]: structuredExecutor(schema) },
      forced: STRUCTURED_OUTPUT_TOOL,
      readRoots: env.readRoots,
    };
    const result = await drive(childIo, store, opened, '', { maxTurns: 1, maxCostUsd: left }, forcedMode, surface).catch(() => undefined);
    if (result === undefined) return undefined;
    const delivered = result.events.findLast((e) => e.kind === 'tool-result' && e.name === STRUCTURED_OUTPUT_TOOL && e.status === 'ok');
    const use = delivered?.kind !== 'tool-result' ? undefined : result.events.flatMap((e) => (e.kind === 'assistant' ? e.content : [])).find((block) => block.type === 'tool_use' && block.id === delivered.toolUseId);
    const parsed = use?.type === 'tool_use' ? structuredFields(use.input, schema) : undefined;
    return { events: result.events, fields: parsed?.ok === true ? parsed.value : undefined };
  };

  const runPlaced = async (
    agent: AgentDefinition,
    run: ChildRun,
    use: { readonly id: string },
    ctx: Parameters<Executor['run']>[1],
    id: SessionId,
    inbox: SteerInbox,
    caps: ChildCaps,
    place: ChildLane | undefined,
  ): Promise<ChildOutcome> => {
    const startedAt = Date.now();
    committed += caps.maxCostUsd;
    const childApproval = asker(env.approval, agent.name, id);
    // A child on an external agent runs its turn inside that agent, where Geno has no point to add context or keep it going.
    const lifecycle = agent.backend === undefined ? env.subagentHooks?.({ id, type: agent.name }, run.kind === 'spawn' ? sessionFile(store, id) : run.log.file, childApproval) : undefined;
    const started = await lifecycle?.start();
    const { log, start, task, prompt, at } = run.kind === 'spawn' ? await openSpawn(agent, run, use, id, caps, ctx.events(), started, place) : await openResume(run, started);
    const { session, file } = log;
    const firstSeq = nextSeq(log.events);
    const view: ChildView = { id: session.id, parentId: parent.log.session.id, toolUseId: use.id, agent, task, model: session.model, effort: session.effort, caps, start, file };
    await ctx.logNote!({ kind: 'child-start', at, child: session.id, toolUseId: use.id, role: agent.name, model: session.model, effort: session.effort, caps, start, ...(env.waiter === undefined ? {} : { by: env.waiter }) });

    const controller = new AbortController();
    const cancel = () => controller.abort(ctx.signal.reason);
    if (ctx.signal.aborted) cancel();
    else ctx.signal.addEventListener('abort', cancel, { once: true });
    const shown = await env.host.started(view, cancel);
    // A report shows as the child's text, as session-replay shows it.
    const watcher: Watcher = {
      ...shown,
      toolStart: (use, title) => {
        const reported = reportMessageOf(use);
        if (reported === undefined) shown.toolStart(use, title);
        else shown.text(reported);
      },
      toolEnd: (use, status, todo) => {
        if (use.name !== REPORT_TOOL) shown.toolEnd(use, status, todo);
      },
    };
    const childIo: Io = { ...io, interrupts: () => controller.signal, out: () => {}, write: () => {}, err: (line) => io.err(`${agent.name}: ${line}`) };
    // A fork is offered its parent's tools, web_fetch and web_search among them, and runs those beside its role's own.
    const executors = pick(place?.executors(childApproval) ?? env.executors(childApproval), start === 'fork' ? [...agent.tools, ...WEB_TOOLS] : agent.tools);
    // A lane's review is its apply, so its files go to disk and never through the editor's buffers of the main checkout.
    const files = place === undefined ? env.files : DISK_FILES;
    const toolHooks = env.toolHooks?.(childApproval, { id: session.id, type: agent.name });
    const own = new Set<string>(agent.tools);
    // A fork keeps the parent's tools for the cache, so it has no report tool and its last text is its report.
    // A child starts no background command, so what arrives for it is the steers its parent or the user sends.
    const arrivals = () => env.steers.inbox.take(session.id);
    const stop = lifecycle?.stop;
    const mcp = start === 'fork' || session.backend !== undefined || !grantsMcp(agent.mcp) ? undefined : await env.mcp?.(childApproval, agent.mcp);
    const mode: Mode =
      start === 'fork'
        ? { ...env.parentMode(), fork: true, executors, readRoots: env.readRoots, writeRoots: env.writeRoots, arrivals, toolHooks, stop }
        : {
            toolHooks,
            stop,
            ...freshOffer(agent, [...AGENT_TOOL_DEFINITIONS.filter((tool) => own.has(tool.name)), REPORT_TOOL_DEFINITION], { ...executors, [REPORT_TOOL]: reportExecutor }, mcp),
            readRoots: env.readRoots,
            writeRoots: env.writeRoots,
            arrivals,
            handback: true,
          };
    const opened: OpenSession = { log, gateway: parent.gateway };

    let end: ChildEnd;
    const cancelledBy = () => (!controller.signal.aborted ? undefined : controller.signal.reason === MODEL_STOP ? 'model' : 'user');
    let events: readonly TurnEvent[] = log.events;
    const external = session.backend === undefined ? undefined : (env.externals ?? new ExternalAgents(childIo));
    try {
      const result =
        external !== undefined
          ? await runExternalTurn({
              io: childIo,
              store,
              log,
              prompt,
              approval: childApproval,
              surface: { files, watcher },
              signal: controller.signal,
              agents: external,
              keyOf: env.keyOf ?? (async () => undefined),
            })
          : await drive(childIo, store, opened, prompt, caps, mode, { files, watcher, steers: inbox });
      events = result.events;
      const error = result.events.findLast((e) => e.kind === 'error');
      end = childEndOf(result.reason, cancelledBy(), error?.kind === 'error' ? error.message : undefined);
    } catch (error) {
      end = controller.signal.aborted ? childEndOf('end_turn', cancelledBy(), undefined) : { kind: 'failed', reason: error instanceof Error ? error.message : String(error) };
    } finally {
      ctx.signal.removeEventListener('abort', cancel);
      external?.close(session.id);
    }
    // This run's events alone: a resumed child's earlier report is not its new one.
    const thisRun = (all: readonly TurnEvent[]) => all.filter((e) => e.kind !== 'session-start' && e.seq !== undefined && e.seq >= firstSeq);
    const schema = run.kind === 'spawn' ? run.step.schema : undefined;
    let fields: Readonly<Record<string, FieldValue>> | undefined;
    const forcing = structuredOutputOf(io.env);
    const fits = (fitting: OutputSchema) => readFields(handedBack(thisRun(events), false), fitting).ok;
    if (schema !== undefined && start === 'fresh' && external === undefined && end.kind === 'done' && !controller.signal.aborted && (forcing === 'always' || (forcing === 'on' && !fits(schema)))) {
      const forced = await forceFields(schema, childIo, { log: { ...log, events }, gateway: parent.gateway }, mode, thisRun(events), caps, { files, watcher, steers: inbox });
      if (forced !== undefined) {
        events = forced.events;
        fields = forced.fields;
      }
    }
    const ran = thisRun(events);
    const total = totalOf(ran);
    committed += (total.costUsd ?? 0) - caps.maxCostUsd;
    const lane = ran.findLast((e) => e.kind === 'backend-start')?.lane;
    const handed = handedBack(ran, isPartial(end));
    const report = fields === undefined ? handed : withFields(handed, fields);
    const settled =
      place === undefined
        ? undefined
        : await settleChildLane(place.lane.repo, place.lane.record).catch((error: unknown) => {
            io.err(`${agent.name}: could not settle lane ${place.lane.record.name}: ${error instanceof Error ? error.message : String(error)}`);
            return undefined;
          });
    const notes = [
      ...(lane == null ? [] : [`${GENO_NOTE} ${agent.name}'s edits are in lane ${lane}. The user applies them from the Lanes pane; they are not in the main checkout yet.`]),
      ...(settled?.kind === 'kept' ? [keptLaneNote(agent, settled)] : []),
    ];
    const summary = childSummary([report, ...notes].filter((part) => part !== '').join('\n\n'));
    const ended: ChildEndNote = { kind: 'child-end', at: new Date().toISOString(), child: session.id, toolUseId: use.id, end, turns: total.turns, costUsd: total.costUsd, summary };
    await env.host.ended(view, end, { turns: total.turns, costUsd: total.costUsd });
    const rejected = ran.some((e) => e.kind === 'tool-result' && e.status === 'rejected');
    const usage = { turns: total.turns, costUsd: total.costUsd, durationMs: Date.now() - startedAt };
    return { text: childReport(agent.name, session.id, end, report, usage, notes), ended, failed: end.kind === 'failed' && report === '' && notes.length === 0, rejected };
  };

  /**
   * Runs a child, a new one or a resumed one, under the same rules: blocking, with its report as this call's result,
   * or in the background, with its report as a message to the parent's session.
   */
  const launch = async (agent: AgentDefinition, run: ChildRun, ctx: Parameters<Executor['run']>[1], background: boolean): Promise<string> => {
    const { name } = agent;
    if (ctx.logNote === undefined) throw new ToolError('subagents start only inside an agent run');
    const readOnly = isReadOnly(agent);
    if (!readOnly && env.approval.kind === 'non-interactive' && !env.allowWriters) {
      throw new ToolError(`${name} may change files, and a non-interactive run starts only read-only subagents`);
    }
    const parentId = parent.log.session.id;
    const parentInbox = env.steers.of(parentId);
    const id = run.kind === 'spawn' ? asSessionId(randomUUID()) : run.log.session.id;
    const laneName = laneNameOf(agent, run, id);
    if (background && !readOnly && laneName === undefined) {
      throw new ToolError(`${name} may change files, so it runs in the background only in a lane of its own, away from this conversation's edits; add isolation: "worktree"`);
    }
    if (background && parentInbox === undefined) throw new ToolError('a background subagent needs a running turn to report to');
    const use = { id: ctx.toolUseId ?? `toolu_gcode_${randomUUID()}` };
    // Opened before the child waits for a slot, so a message sent meanwhile reaches its first model call.
    // An external agent's turn is one prompt with no safe point between tool rounds, so a message would wait for its end.
    const refusal = agent.backend === undefined ? undefined : `${name} runs on ${EXTERNAL_BACKENDS[agent.backend].label}, which cannot take a message mid-turn`;
    const inbox = env.steers.open(id, parentId, refusal);
    const stop = new AbortController();
    if (background) inBackground.add(stop);
    const childCtx = background ? { ...ctx, signal: AbortSignal.any([ctx.signal, stop.signal]) } : ctx;
    const writes = laneName !== undefined ? `lane ${laneName}` : readOnly ? undefined : 'main';
    const slot = readOnly || laneName !== undefined ? parallel : <T>(work: () => Promise<T>) => work();
    const child = checkout(writes, () => slot(() => runChild(agent, run, use, childCtx, id, inbox, laneName)));
    void child
      .finally(() => {
        inBackground.delete(stop);
        stoppers.delete(id);
        env.steers.release(id, inbox);
      })
      .catch(() => {});
    if (!background) {
      // Tracked until its end is logged, which can come after a stopped run answered this call.
      const { text, failed, rejected } = await track(
        child.then(async (outcome) => {
          await ctx.logNote!({ ...outcome.ended });
          return outcome;
        }),
      );
      if (failed) throw new ToolError(text);
      // The user's no to the child's call is a no to this one too, so the parent stops as well.
      if (rejected) throw new ToolRejected(`${text}\n${name} stopped because the user rejected one of its calls. ${STOP_AND_WAIT}`);
      return text;
    }
    // The report goes to the session, not to this run: it may arrive after the run ended, for a woken turn to take.
    let silent = false;
    const paid = parentInbox!.owe();
    // task_stop's: the report is its result, so the message that would carry it is silenced.
    const stopNow = async () => {
      silent = true;
      stop.abort(MODEL_STOP);
      return (await child).text;
    };
    stoppers.set(id, stopNow);
    const reported = env.waits?.child(parentId, id, {
      agent: name,
      toolUseId: use.id,
      silence: () => {
        silent = true;
        stop.abort();
      },
      stop: stopNow,
    });
    const report = async (text: string, ended: ChildEndNote | undefined) => {
      // While the parent's run goes on, its own writes log the end; once it let go of the session, the end goes with
      // the report. A silenced child's end is still logged, with no report for the model to hear.
      const heard = !silent && !unheard;
      if (ended !== undefined && !detached) await ctx.logNote!({ ...ended }).catch(() => {});
      const end = ended !== undefined && detached ? { end: ended } : {};
      if (heard || 'end' in end) env.steers.inbox.put(parentId, { kind: 'child-report', ...end, ...(heard ? { report: text } : {}) });
      paid();
      reported?.();
    };
    void track(
      child.then(
        ({ text, ended }) => report(text, ended),
        (error: unknown) => report(error instanceof Error ? error.message : String(error), undefined),
      ),
    );
    const how = run.kind === 'spawn' ? `Started ${name} in the background as subagent session ${id}. Its report arrives` : `Resumed ${name} in the background as subagent session ${id}, with your message. Its new report arrives`;
    return [
      `${how} as a message from Geno when it finishes; until then message_agent with agent_session "${id}" can steer it.`,
      'You know nothing about its results until that message arrives: do not report, assume or predict them. Go on with other work or answer the user meanwhile; if the user asks how it is going, say it is still running.',
      'Do not duplicate its work: stay off the files and questions it is working on.',
    ].join('\n');
  };

  const tool = agentToolDefinition(agents);
  const run = executor({
    input: inputSchema,
    concurrent: ({ agent, ...input }) => {
      const definition = byName(agent);
      return definition !== undefined && (isReadOnly(definition) || laneWant(definition, input, parent.log.session.id) !== undefined);
    },
    describe: ({ agent, task }) => `${AGENT_TOOL} ${agent}: ${task.split('\n')[0]}`,
    async run({ agent: name, task, fork, background, isolation, ...step }, ctx) {
      const set = STEP_FIELDS.filter((field) => step[field] !== undefined);
      if (set.length > 0 && env.steps !== true) throw new ToolError(`${set.join(', ')} ${set.length === 1 ? 'is' : 'are'} for workflow steps; leave ${set.length === 1 ? 'it' : 'them'} out`);
      const agent = byName(name);
      if (agent === undefined) throw new ToolError(`no subagent ${name}; the subagents are ${agents.map((a) => a.name).join(', ')}`);
      const lane = laneWant(agent, { lane: step.lane, isolation }, parent.log.session.id);
      return launch(agent, { kind: 'spawn', task, start: fork === true ? 'fork' : 'fresh', step, background: background === true, lane }, ctx, background === true);
    },
  });

  /**
   * The log that holds a child's runs: this session's, or, for a step of a workflow this session started, the
   * workflow's own, whose engine may have stopped with it. Undefined for a child of any other session.
   */
  const holderOf = async (of: ChildOf, events: readonly TurnEvent[]): Promise<readonly TurnEvent[] | undefined> => {
    if (of.parentId === parent.log.session.id) return events;
    const workflow = await readSessionLog(sessionFile(store, of.parentId)).catch(() => undefined);
    const head = workflow?.events[0];
    return head?.kind === 'session-start' && head.workflow?.parentId === parent.log.session.id ? workflow!.events : undefined;
  };

  /** A finished child of this session, read from its own log, which names its parent and how it was started. */
  const resumable = async (id: string, message: string, events: readonly TurnEvent[]): Promise<{ readonly agent: AgentDefinition; readonly run: Extract<ChildRun, { kind: 'resume' }> }> => {
    const notOurs = new ToolError(`no subagent ${id} of this session`);
    if (/[\\/]/.test(id)) throw notOurs;
    const log = await readSessionLog(sessionFile(store, asSessionId(id))).catch(() => undefined);
    const header = log?.events[0];
    const of = header?.kind === 'session-start' ? header.child : undefined;
    const holder = of === undefined ? undefined : await holderOf(of, events);
    if (log === undefined || of === undefined || holder === undefined) throw notOurs;
    const backend = log.session.backend;
    if (backend !== undefined) throw new ToolError(`${of.role} ran on ${EXTERNAL_BACKENDS[backend.id].label}, whose session Geno cannot resume; start a new subagent with everything it needs`);
    const agent = byName(of.role);
    if (agent === undefined) throw new ToolError(`${id} was a ${of.role} subagent, and this session has no ${of.role} now; start one of ${agents.map((a) => a.name).join(', ')}`);
    // A step this session resumed before has its newest run here, not in the workflow's log.
    const newest = childrenOf(events).find((child) => child.child === id) ?? childrenOf(holder).find((child) => child.child === id);
    const cut = newest?.status.kind === 'interrupted';
    return { agent, run: { kind: 'resume', message, log, of, moment: cut ? 'interrupted' : 'resumed' } };
  };

  // One message to a child at a time, so that two messages to a finished child cannot both resume it onto its one log.
  const messaging = new Map<string, Promise<unknown>>();
  const message = executor({
    input: messageSchema,
    concurrent: () => true,
    describe: ({ agent_session, text }) => `${MESSAGE_AGENT_TOOL} ${agent_session}: ${text.split('\n')[0]}`,
    run({ agent_session, text }, ctx) {
      const send = async (): Promise<string> => {
        const inbox = env.steers.of(agent_session);
        if (inbox?.parentId === parent.log.session.id) {
          const delivery = await inbox.push({ text, from: 'parent' });
          if (delivery !== undefined && delivery.kind !== 'next-turn') return messageAgentResult(delivery);
        }
        const { agent, run } = await resumable(agent_session, text, ctx.events());
        return launch(agent, run, ctx, run.of.background === true);
      };
      const sent = (messaging.get(agent_session) ?? Promise.resolve()).then(send);
      messaging.set(agent_session, sent.catch(() => {}));
      return sent;
    },
  });
  return {
    tool,
    executor: run,
    message,
    stop: (childId) => stoppers.get(childId)?.(),
    stopBackground: () => {
      unheard = true;
      for (const stop of inBackground) stop.abort();
    },
    detach: () => {
      detached = true;
    },
    settled: async () => {
      while (running.size > 0) await Promise.allSettled([...running]);
    },
  };
}

const REVIEW_DIFF_CHARS = 60_000;

/**
 * The tool call a prompt like `@explore where is foo defined` stands for, as the user's own call. `@review` with
 * nothing after it reviews the working tree's changes, and its diff travels with the task.
 */
export async function mentionedCall(prompt: string, agents: readonly AgentDefinition[], session: Session): Promise<AssistantTurn | undefined> {
  const mention = agentMention(prompt, agents);
  if (mention === undefined) return undefined;
  let task = mention.task;
  if (mention.agent.name === 'review') {
    const diff = await workingDiff(session.workspace).catch(() => '');
    const shown = diff.length > REVIEW_DIFF_CHARS ? `${diff.slice(0, REVIEW_DIFF_CHARS)}\n[... ${diff.length - REVIEW_DIFF_CHARS} characters cut ...]` : diff;
    task = [task === '' ? 'Review the changes in this diff.' : task, '', shown.trim() === '' ? '(git diff HEAD shows no changes.)' : `git diff HEAD:\n\`\`\`diff\n${shown}\n\`\`\``].join('\n');
  }
  if (task === '') task = `The user mentioned @${mention.agent.name} without a task. Say in one line what you can do.`;
  const use: ToolUseBlock = { type: 'tool_use', id: `toolu_gcode_${randomUUID().replaceAll('-', '')}`, name: AGENT_TOOL, input: { agent: mention.agent.name, task }, caller: { type: 'direct' } };
  return { content: [use], stopReason: 'tool_use', usage: ZERO_USAGE, costUsd: 0, latencyMs: 0, model: session.model };
}

/** Resume in Tasks: the user's own `message_agent` call to a subagent of the session, with the prompt as its message. */
export function resumeCall(agentSession: string, text: string, session: Session): AssistantTurn {
  const use: ToolUseBlock = { type: 'tool_use', id: `toolu_gcode_${randomUUID().replaceAll('-', '')}`, name: MESSAGE_AGENT_TOOL, input: { agent_session: agentSession, text }, caller: { type: 'direct' } };
  return { content: [use], stopReason: 'tool_use', usage: ZERO_USAGE, costUsd: 0, latencyMs: 0, model: session.model };
}
