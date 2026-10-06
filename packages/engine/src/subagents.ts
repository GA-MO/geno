import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { z } from 'zod';
import type { Tool, ToolUseBlock } from '@anthropic-ai/sdk/resources/messages/messages';
import {
  AGENT_TOOL,
  AGENT_TOOL_DEFINITIONS,
  agentMention,
  agentToolDefinition,
  asSessionId,
  BUILTIN_AGENTS,
  childCaps,
  childEndOf,
  childEndWords,
  childReport,
  childSummary,
  childSystemPrompt,
  forkTask,
  IN_CONVERSATION,
  isReadOnly,
  mergeAgents,
  parseAgentDefinition,
  sessionEffortOf,
  ZERO_USAGE,
  type AgentDefinition,
  type AgentSource,
  type AssistantTurn,
  type ChildCaps,
  type ChildEnd,
  type ChildStart,
  type Effort,
  type Session,
  type SessionId,
  type TurnEvent,
} from '@g-code/core';
import { formatCost, totalOf, type OpenSession } from './chat.js';
import type { Io } from './command.js';
import { drive, type Limits, type Mode, type Watcher } from './drive.js';
import type { Files } from './files.js';
import { workingDiff } from './git.js';
import type { InstalledPlugin } from './plugins.js';
import { parseFrontmatter, readIfFile, shownPath, sortedEntries } from './project-context.js';
import { appendEvent, sessionFile } from './sessions.js';
import type { Store } from './store.js';
import type { Approval } from './tools/agent.js';
import { executor, ToolError, type Executor } from './tools/context.js';
import type { Executors } from './tools/index.js';
import type { Homes } from './commands.js';

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
};

export type Subagents = {
  readonly tool: Tool;
  readonly executor: Executor;
  /** Settles once every child started so far has ended and logged its end. */
  settled(): Promise<void>;
};

const inputSchema = z.strictObject({ agent: z.string().min(1), task: z.string(), fork: z.boolean().optional() });

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

/** The parent's conversation before its newest model call, which a fork starts from. */
function forkedEvents(events: readonly TurnEvent[]): TurnEvent[] {
  const last = events.findLastIndex((e) => e.kind === 'assistant');
  return events.slice(1, last === -1 ? events.length : last).filter((e) => IN_CONVERSATION[e.kind]);
}

const reportOf = (events: readonly TurnEvent[]): string =>
  events
    .flatMap((e) => (e.kind === 'assistant' ? e.content.flatMap((block) => (block.type === 'text' && block.text.trim() !== '' ? [block.text.trim()] : [])) : []))
    .join('\n\n');

const pick = (executors: Executors, names: readonly string[]): Executors =>
  Object.fromEntries(names.flatMap((name) => (Object.hasOwn(executors, name) ? [[name, executors[name]!]] : [])));

const asker = (approval: Approval, name: string, sessionId: SessionId): Approval =>
  approval.kind === 'interactive' ? { ...approval, approve: (denial, classifier) => approval.approve(denial, classifier, { name, sessionId }) } : approval;

export function subagents(env: SubagentEnv): Subagents {
  const { io, store, parent, agents } = env;
  const parallel = semaphore(MAX_PARALLEL_CHILDREN);
  const running = new Set<Promise<unknown>>();
  let committed = 0;
  const byName = (name: string) => agents.find((agent) => agent.name === name);

  const runChild = async (agent: AgentDefinition, task: string, start: ChildStart, use: { readonly id: string }, ctx: Parameters<Executor['run']>[1]): Promise<string> => {
    const caps = childCaps(agent, env.limits.maxCostUsd - committed);
    if (caps === undefined) throw new ToolError(`the subagents of this run have spent their $${env.limits.maxCostUsd} together; finish without another one`);
    committed += caps.maxCostUsd;
    const parentEvents = ctx.events();
    const parentSession = parent.log.session;
    const session: Session = {
      id: asSessionId(randomUUID()),
      createdAt: new Date().toISOString(),
      workspace: parentSession.workspace,
      provider: parentSession.provider,
      // A fork shares the parent's cached prefix only on the parent's model.
      model: start === 'fork' ? parentSession.model : (agent.model ?? parentSession.model),
      effort: agent.effort ?? sessionEffortOf(parentSession, parentEvents),
    };
    const header = parentEvents[0];
    const file = sessionFile(store, session.id);
    const opening: TurnEvent[] = [
      {
        kind: 'session-start',
        session,
        context: header?.kind === 'session-start' ? header.context : undefined,
        child: { parentId: parentSession.id, toolUseId: use.id, role: agent.name, caps, start },
      },
      ...(start === 'fork' ? forkedEvents(parentEvents) : []),
    ];
    for (const event of opening) await appendEvent(file, event);
    const view: ChildView = { id: session.id, parentId: parentSession.id, toolUseId: use.id, agent, task, model: session.model, effort: session.effort, caps, start, file };
    await ctx.logChild!({ kind: 'child-start', at: session.createdAt, child: session.id, toolUseId: use.id, role: agent.name, model: session.model, effort: session.effort, caps, start });

    const controller = new AbortController();
    const cancel = () => controller.abort();
    if (ctx.signal.aborted) cancel();
    else ctx.signal.addEventListener('abort', cancel, { once: true });
    const watcher = await env.host.started(view, cancel);
    const childIo: Io = { ...io, interrupts: () => controller.signal, out: () => {}, write: () => {}, err: (line) => io.err(`${agent.name}: ${line}`) };
    const executors = pick(env.executors(asker(env.approval, agent.name, session.id)), agent.tools);
    const own = new Set<string>(agent.tools);
    const mode: Mode =
      start === 'fork'
        ? { ...env.parentMode(), executors, readRoots: env.readRoots }
        : { tools: AGENT_TOOL_DEFINITIONS.filter((tool) => own.has(tool.name)), system: childSystemPrompt(agent), executors, readRoots: env.readRoots };
    const opened: OpenSession = { log: { file, session, events: opening, tornLine: undefined, goodBytes: 0 }, gateway: parent.gateway };

    let end: ChildEnd;
    let events: readonly TurnEvent[] = opening;
    try {
      const result = await drive(childIo, store, opened, start === 'fork' ? forkTask(agent, task) : task, caps, mode, { files: env.files, watcher });
      events = result.events;
      const error = result.events.findLast((e) => e.kind === 'error');
      end = childEndOf(result.reason, controller.signal.aborted, error?.kind === 'error' ? error.message : undefined);
    } catch (error) {
      end = controller.signal.aborted ? { kind: 'cancelled' } : { kind: 'failed', reason: error instanceof Error ? error.message : String(error) };
    } finally {
      ctx.signal.removeEventListener('abort', cancel);
    }
    const ran = events.filter((e) => e.kind !== 'session-start' && !opening.includes(e));
    const total = totalOf(ran);
    committed += (total.costUsd ?? 0) - caps.maxCostUsd;
    const report = reportOf(ran);
    await ctx.logChild!({ kind: 'child-end', at: new Date().toISOString(), child: session.id, toolUseId: use.id, end, turns: total.turns, costUsd: total.costUsd, summary: childSummary(report) });
    await env.host.ended(view, end, { turns: total.turns, costUsd: total.costUsd });
    const text = childReport(agent.name, session.id, end, report);
    if (end.kind === 'failed' && report === '') throw new ToolError(text);
    return text;
  };

  const tool = agentToolDefinition(agents);
  const run = executor({
    input: inputSchema,
    concurrent: ({ agent }) => {
      const definition = byName(agent);
      return definition !== undefined && isReadOnly(definition);
    },
    describe: ({ agent, task }) => `${AGENT_TOOL} ${agent}: ${task.split('\n')[0]}`,
    async run({ agent: name, task, fork }, ctx) {
      const agent = byName(name);
      if (agent === undefined) throw new ToolError(`no subagent ${name}; the subagents are ${agents.map((a) => a.name).join(', ')}`);
      if (agent.isolation === 'worktree') throw new ToolError(`${name} asks for isolation: worktree, which Geno does not support yet; it cannot run`);
      if (ctx.logChild === undefined) throw new ToolError('subagents start only inside an agent run');
      const readOnly = isReadOnly(agent);
      if (!readOnly && env.approval.kind === 'non-interactive' && !env.allowWriters) {
        throw new ToolError(`${name} may change files, and a non-interactive run starts only read-only subagents`);
      }
      const use = { id: ctx.toolUseId ?? `toolu_gcode_${randomUUID()}` };
      const child = (readOnly ? parallel : <T>(work: () => Promise<T>) => work())(() => runChild(agent, task, fork === true ? 'fork' : 'fresh', use, ctx));
      running.add(child);
      void child.finally(() => running.delete(child)).catch(() => {});
      return child;
    },
  });
  return {
    tool,
    executor: run,
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
