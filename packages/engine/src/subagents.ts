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
  BUILTIN_AGENTS,
  childCaps,
  type ChildCaps,
  type ChildEnd,
  childEndOf,
  childEndWords,
  type ChildNote,
  type ChildOf,
  childReport,
  type ChildStart,
  childrenOf,
  childSummary,
  childSystemPrompt,
  type Effort,
  EXTERNAL_BACKENDS,
  forkOpening,
  forkTask,
  GENO_NOTE,
  handedBack,
  isPartial,
  isReadOnly,
  mergeAgents,
  MESSAGE_AGENT_TOOL,
  STOP_AND_WAIT,
  messageAgentResult,
  nextSeq,
  type ParentMoment,
  parseAgentDefinition,
  REPORT_DELIVERED,
  reportMessageOf,
  resumeEvent,
  REPORT_TOOL,
  REPORT_TOOL_DEFINITION,
  type Session,
  sessionEffortOf,
  type SessionId,
  type TurnEvent,
  type Waiter,
  ZERO_USAGE,
} from '@g-code/core';
import { formatCost, totalOf, type OpenSession } from './chat.js';
import type { Io } from './command.js';
import { drive, type Limits, type Mode, type Watcher } from './drive.js';
import type { Files } from './files.js';
import { workingDiff } from './git.js';
import type { InstalledPlugin } from './plugins.js';
import { parseFrontmatter, readIfFile, shownPath, sortedEntries } from './project-context.js';
import { ExternalAgents, runExternalTurn, type KeyOf } from './external.js';
import { appendEvent, dropTornTail, readSessionLog, sessionFile, type SessionLog } from './sessions.js';
import type { Store } from './store.js';
import type { SteerInbox, Steers } from './steer.js';
import type { Wakes } from './wakes.js';
import type { Approval } from './tools/agent.js';
import { executor, ToolError, ToolRejected, type Executor } from './tools/context.js';
import type { Executors } from './tools/index.js';
import type { Homes } from './commands.js';
import type { HookAgent, ToolHooks } from './hooks.js';

/** In precedence order, as for commands: the workspace's folders, then Geno's home, then plugins, then the built-ins. */
const AGENT_FOLDERS: readonly { readonly source: AgentSource; readonly dir: (workspace: string, homes: Homes) => string }[] = [
  { source: 'workspace', dir: (workspace) => path.join(workspace, '.agents', 'agents') },
  { source: 'workspace', dir: (workspace) => path.join(workspace, '.claude', 'agents') },
  { source: 'global', dir: (_, homes) => path.join(homes.app, 'agents') },
];

/** Each problem names its file; a file that cannot be used is reported and skipped, never thrown. */
export type AgentScan = { readonly agents: readonly AgentDefinition[]; readonly problems: readonly string[] };

async function loadAgentDir(dir: string, source: AgentSource, namespace: string, show: (file: string) => string, problems: string[]): Promise<AgentDefinition[]> {
  const agents: AgentDefinition[] = [];
  for (const entry of await sortedEntries(dir)) {
    if (!entry.name.endsWith('.md')) continue;
    const file = path.join(dir, entry.name);
    const raw = await readIfFile(file);
    if (raw === undefined) continue;
    const { fields, body } = parseFrontmatter(raw);
    const parsed = parseAgentDefinition(fields, body, { source, path: show(file), fallbackName: entry.name.slice(0, -'.md'.length), namespace });
    if (parsed.kind === 'skipped') {
      problems.push(`${show(file)}: skipped, ${parsed.reason}`);
      continue;
    }
    for (const note of parsed.notes) problems.push(`${show(file)}: ${note}`);
    agents.push(parsed.agent);
  }
  return agents;
}

/** The agents a session can start, with Claude Code plugins' agents read in place and named `<plugin>:<agent>`. */
export async function loadAgents(workspace: string, homes: Homes, plugins: readonly InstalledPlugin[]): Promise<AgentScan> {
  const show = (file: string) => shownPath(workspace, file);
  const problems: string[] = [];
  const groups = [];
  for (const folder of AGENT_FOLDERS) groups.push(await loadAgentDir(folder.dir(workspace, homes), folder.source, '', show, problems));
  for (const plugin of plugins) groups.push(await loadAgentDir(path.join(plugin.root, 'agents'), 'plugin', `${plugin.name}:`, show, problems));
  return { agents: mergeAgents([...groups, BUILTIN_AGENTS]), problems };
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

/** At most this many read-only children of one parent run at once. */
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
  /** The parent's tools and system prompt, which a fork reuses so that it shares the parent's cached prefix. */
  readonly parentMode: () => Pick<Mode, 'tools' | 'system'>;
  readonly readRoots: readonly string[];
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
};

/** What a workflow step sets on its child: the model, and caps in place of the definition's. */
type StepOptions = { readonly model?: string | undefined; readonly max_turns?: number | undefined; readonly max_cost_usd?: number | undefined; readonly lane?: string | undefined };

type ChildEndNote = Extract<ChildNote, { kind: 'child-end' }>;

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
  | { readonly kind: 'spawn'; readonly task: string; readonly start: ChildStart; readonly step: StepOptions; readonly background: boolean }
  | { readonly kind: 'resume'; readonly message: string; readonly log: SessionLog; readonly of: ChildOf; readonly moment: Exclude<ParentMoment, 'working'> };

/** A child's log as its run begins: what the run's first prompt is, when the run began, and the task the user sees it on. */
type OpenedChild = { readonly log: SessionLog; readonly start: ChildStart; readonly task: string; readonly prompt: string; readonly at: string };

export type Subagents = {
  readonly tool: Tool;
  readonly executor: Executor;
  /** `message_agent`, offered with `agent` and only with it. */
  readonly message: Executor;
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
});
const STEP_FIELDS = ['model', 'max_turns', 'max_cost_usd', 'lane'] as const;
const messageSchema = z.strictObject({ agent_session: z.string().min(1), text: z.string().trim().min(1) });

/** A child's report call: it only says it went through, and the loop ends the child's run after it. */
const reportExecutor = executor({
  input: z.strictObject({ message: z.string().trim().min(1, 'the report is empty; put everything the agent that started you needs in message') }),
  concurrent: () => true,
  describe: () => REPORT_TOOL,
  run: async () => REPORT_DELIVERED,
});

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

const asker = (approval: Approval, name: string, sessionId: SessionId): Approval =>
  approval.kind === 'interactive' ? { ...approval, approve: (denial, classifier) => approval.approve(denial, classifier, { name, sessionId }) } : approval;

export function subagents(env: SubagentEnv): Subagents {
  const { io, store, parent, agents } = env;
  const parallel = semaphore(MAX_PARALLEL_CHILDREN);
  // Each child until its end is logged, so `settled` never returns while an end is still on its way to the log.
  const running = new Set<Promise<unknown>>();
  const track = <T>(work: Promise<T>): Promise<T> => {
    running.add(work);
    void work.finally(() => running.delete(work)).catch(() => {});
    return work;
  };
  let committed = 0;
  const byName = (name: string) => agents.find((agent) => agent.name === name);
  const inBackground = new Set<AbortController>();
  // Set once the parent's run ended with nobody left to take a report.
  let unheard = false;
  // Set once the parent's run ended and its children run on to wake the session.
  let detached = false;

  const openSpawn = async (agent: AgentDefinition, run: Extract<ChildRun, { kind: 'spawn' }>, use: { readonly id: string }, id: SessionId, caps: ChildCaps, parentEvents: readonly TurnEvent[]): Promise<OpenedChild> => {
    const parentSession = parent.log.session;
    const { start, task, step } = run;
    const session: Session = {
      id,
      createdAt: new Date().toISOString(),
      workspace: parentSession.workspace,
      provider: parentSession.provider,
      // A fork shares the parent's cached prefix only on the parent's model.
      model: agent.backend !== undefined ? agent.backend : start === 'fork' ? parentSession.model : (step.model ?? agent.model ?? parentSession.model),
      effort: agent.effort ?? sessionEffortOf(parentSession, parentEvents),
      ...(agent.backend === undefined ? {} : { backend: { id: agent.backend } }),
    };
    const header = parentEvents[0];
    const file = sessionFile(store, session.id);
    const opening: TurnEvent[] = [
      {
        kind: 'session-start',
        session,
        context: header?.kind === 'session-start' ? header.context : undefined,
        memory: header?.kind === 'session-start' ? header.memory : undefined,
        // The parent's, so a child knows where it runs; it shares the parent's scratchpad.
        environment: header?.kind === 'session-start' ? header.environment : undefined,
        child: { parentId: parentSession.id, toolUseId: use.id, role: agent.name, caps, start, ...(run.background ? { background: true } : {}) },
      },
      ...(start === 'fork' ? forkOpening(parentEvents, use.id, session.createdAt) : []),
    ];
    for (const event of opening) await appendEvent(file, event);
    const log: SessionLog = { file, session, events: opening, tornLine: undefined, goodBytes: 0 };
    return { log, start, task, prompt: start === 'fork' ? forkTask(agent, task) : task, at: session.createdAt };
  };

  // The run goes on from where the child's log ends, with the message as its parent's steer and nothing left to prompt.
  const openResume = async ({ log, message, of, moment }: Extract<ChildRun, { kind: 'resume' }>): Promise<OpenedChild> => {
    await dropTornTail(log);
    const at = new Date().toISOString();
    const resumed = resumeEvent(message, nextSeq(log.events), at, moment);
    await appendEvent(log.file, resumed);
    return { log: { ...log, events: [...log.events, resumed] }, start: of.start, task: message, prompt: '', at };
  };

  const runChild = async (agent: AgentDefinition, run: ChildRun, use: { readonly id: string }, ctx: Parameters<Executor['run']>[1], id: SessionId, inbox: SteerInbox): Promise<ChildOutcome> => {
    // A resumed child gets its spawn's caps afresh, held like any child's to what this run has left for children.
    const asked = run.kind === 'spawn' ? { maxTurns: run.step.max_turns, maxCostUsd: run.step.max_cost_usd } : run.of.caps;
    const caps = childCaps(agent, env.limits.maxCostUsd - committed, asked);
    if (caps === undefined) throw new ToolError(`the subagents of this run have spent their $${env.limits.maxCostUsd} together; finish without another one`);
    const startedAt = Date.now();
    committed += caps.maxCostUsd;
    const { log, start, task, prompt, at } = run.kind === 'spawn' ? await openSpawn(agent, run, use, id, caps, ctx.events()) : await openResume(run);
    const { session, file } = log;
    const firstSeq = nextSeq(log.events);
    const view: ChildView = { id: session.id, parentId: parent.log.session.id, toolUseId: use.id, agent, task, model: session.model, effort: session.effort, caps, start, file };
    await ctx.logNote!({ kind: 'child-start', at, child: session.id, toolUseId: use.id, role: agent.name, model: session.model, effort: session.effort, caps, start, ...(env.waiter === undefined ? {} : { by: env.waiter }) });

    const controller = new AbortController();
    const cancel = () => controller.abort();
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
    const childApproval = asker(env.approval, agent.name, session.id);
    const executors = pick(env.executors(childApproval), agent.tools);
    const toolHooks = env.toolHooks?.(childApproval, { id: session.id, type: agent.name });
    const own = new Set<string>(agent.tools);
    // A fork keeps the parent's tools for the cache, so it has no report tool and its last text is its report.
    // A child starts no background command, so what arrives for it is the steers its parent or the user sends.
    const arrivals = () => env.steers.inbox.take(session.id);
    const mode: Mode =
      start === 'fork'
        ? { ...env.parentMode(), executors, readRoots: env.readRoots, arrivals, toolHooks }
        : {
            toolHooks,
            tools: [...AGENT_TOOL_DEFINITIONS.filter((tool) => own.has(tool.name)), REPORT_TOOL_DEFINITION],
            system: childSystemPrompt(agent),
            executors: { ...executors, [REPORT_TOOL]: reportExecutor },
            readRoots: env.readRoots,
            arrivals,
            handback: true,
          };
    const opened: OpenSession = { log, gateway: parent.gateway };

    let end: ChildEnd;
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
              surface: { files: env.files, watcher },
              signal: controller.signal,
              agents: external,
              keyOf: env.keyOf ?? (async () => undefined),
            })
          : await drive(childIo, store, opened, prompt, caps, mode, { files: env.files, watcher, steers: inbox });
      events = result.events;
      const error = result.events.findLast((e) => e.kind === 'error');
      end = childEndOf(result.reason, controller.signal.aborted, error?.kind === 'error' ? error.message : undefined);
    } catch (error) {
      end = controller.signal.aborted ? { kind: 'cancelled' } : { kind: 'failed', reason: error instanceof Error ? error.message : String(error) };
    } finally {
      ctx.signal.removeEventListener('abort', cancel);
      external?.close(session.id);
    }
    // This run's events alone: a resumed child's earlier report is not its new one.
    const ran = events.filter((e) => e.kind !== 'session-start' && e.seq !== undefined && e.seq >= firstSeq);
    const total = totalOf(ran);
    committed += (total.costUsd ?? 0) - caps.maxCostUsd;
    const lane = ran.findLast((e) => e.kind === 'backend-start')?.lane;
    const report = handedBack(ran, isPartial(end));
    const notes = lane == null ? [] : [`${GENO_NOTE} ${agent.name}'s edits are in lane ${lane}. The user applies them from the Lanes pane; they are not in the main checkout yet.`];
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
    if (background && !readOnly) throw new ToolError(`${name} may change files, so it cannot run in the background beside this conversation's own edits`);
    if (background && parentInbox === undefined) throw new ToolError('a background subagent needs a running turn to report to');
    const use = { id: ctx.toolUseId ?? `toolu_gcode_${randomUUID()}` };
    const id = run.kind === 'spawn' ? asSessionId(randomUUID()) : run.log.session.id;
    // Opened before the child waits for a slot, so a message sent meanwhile reaches its first model call.
    // An external agent's turn is one prompt with no safe point between tool rounds, so a message would wait for its end.
    const refusal = agent.backend === undefined ? undefined : `${name} runs on ${EXTERNAL_BACKENDS[agent.backend].label}, which cannot take a message mid-turn`;
    const inbox = env.steers.open(id, parentId, refusal);
    const stop = new AbortController();
    if (background) inBackground.add(stop);
    const childCtx = background ? { ...ctx, signal: AbortSignal.any([ctx.signal, stop.signal]) } : ctx;
    const child = (readOnly ? parallel : <T>(work: () => Promise<T>) => work())(() => runChild(agent, run, use, childCtx, id, inbox));
    void child
      .finally(() => {
        inBackground.delete(stop);
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
    const reported = env.waits?.child(parentId, id, {
      agent: name,
      toolUseId: use.id,
      silence: () => {
        silent = true;
        stop.abort();
      },
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
    concurrent: ({ agent }) => {
      const definition = byName(agent);
      return definition !== undefined && isReadOnly(definition);
    },
    describe: ({ agent, task }) => `${AGENT_TOOL} ${agent}: ${task.split('\n')[0]}`,
    async run({ agent: name, task, fork, background, ...step }, ctx) {
      const set = STEP_FIELDS.filter((field) => step[field] !== undefined);
      if (set.length > 0 && env.steps !== true) throw new ToolError(`${set.join(', ')} ${set.length === 1 ? 'is' : 'are'} for workflow steps; leave ${set.length === 1 ? 'it' : 'them'} out`);
      if (step.lane !== undefined) throw new ToolError('a workflow step in a lane is not supported yet');
      const agent = byName(name);
      if (agent === undefined) throw new ToolError(`no subagent ${name}; the subagents are ${agents.map((a) => a.name).join(', ')}`);
      if (agent.isolation === 'worktree') throw new ToolError(`${name} asks for isolation: worktree, which Geno does not support yet; it cannot run`);
      return launch(agent, { kind: 'spawn', task, start: fork === true ? 'fork' : 'fresh', step, background: background === true }, ctx, background === true);
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
