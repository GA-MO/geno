import { randomUUID } from 'node:crypto';
import { parseArgs } from 'node:util';
import {
  asSessionId,
  childEndWords,
  jobEndText,
  wakeLabel,
  hasPendingPrompt,
  isEmptyContext,
  isEffort,
  isProviderName,
  type BackendBinding,
  specOf,
  nextSeq,
  spendOf,
  toolUsesOf,
  type ApprovalRecord,
  type Effort,
  type ModelRetry,
  type ProviderName,
  type Session,
  type TokenUsage,
  type TurnErrorKind,
  type TurnEvent,
  type Waiting,
  waitLabel,
} from '@g-code/core';
import { checkId, singleId, UsageError, type Command, type Io } from './command.js';
import { captureEnvironment, scratchpadOf } from './environment.js';
import { gatewayFor, type Gateway } from './gateway.js';
import { loadProjectContext } from './project-context.js';
import { appendEvent, dropTornTail, readSessionLog, sessionFile, type SessionLog } from './sessions.js';
import { homeOf, type Store } from './store.js';

export const DEFAULT_PROVIDER: ProviderName = 'modelstudio';
export const DEFAULT_EFFORT: Effort = 'medium';

export const EXIT_CODES: Record<TurnErrorKind, number> = {
  refusal: 1,
  transport: 1,
  overflow: 1,
  abort: 130,
  'max-turns': 3,
  budget: 3,
};

export const formatRetry = ({ attempt, delayMs, message }: ModelRetry): string =>
  `retry ${attempt} in ${(delayMs / 1000).toFixed(1)}s: ${message}`;

/** A wait as the CLI prints it, with the times it names in UTC. */
export const formatWait = (wait: Waiting, now: number): string =>
  `${waitLabel(wait, now, (ms) => `${new Date(ms).toISOString().slice(11, 16)} UTC`).toLowerCase()}${wait.retryAt === null ? ', until you retry or stop' : ''}: ${wait.message}`;

export const formatCost =(costUsd: number | null): string =>
  costUsd === null ? 'cost=unknown' : `cost=$${costUsd.toFixed(6)}`;

export const formatUsage = (usage: TokenUsage, costUsd: number | null): string =>
  `in=${usage.input} cache_read=${usage.cacheRead} cache_write=${usage.cacheWrite} out=${usage.output} ${formatCost(costUsd)}`;

export async function openSessionLog(store: Store, rawId: string, io: Io): Promise<SessionLog> {
  const log = await readSessionLog(sessionFile(store, asSessionId(checkId(rawId, 'session'))));
  if (log.tornLine !== undefined) io.err(`warning: ${log.file}: skipped torn line ${log.tornLine}`);
  return log;
}

async function newSession(
  store: Store,
  env: Io['env'],
  workspace: string,
  provider: ProviderName,
  model: string,
  effort: Effort,
  backend?: BackendBinding,
): Promise<SessionLog> {
  const session: Session = {
    id: asSessionId(randomUUID()),
    createdAt: new Date().toISOString(),
    workspace,
    provider,
    model,
    effort,
    ...(backend === undefined ? {} : { backend }),
  };
  const file = sessionFile(store, session.id);
  // Loaded once and logged, so every later turn and a resumed session send the same text.
  const [context, environment] = await Promise.all([
    loadProjectContext(workspace, homeOf(store)),
    captureEnvironment({ workspace, scratchpad: await scratchpadOf(session.id), env }),
  ]);
  const start: TurnEvent = { kind: 'session-start', session, context, environment };
  await appendEvent(file, start);
  return { file, session, events: [start], tornLine: undefined, goodBytes: 0 };
}

export type OpenSession = { readonly log: SessionLog; readonly gateway: Gateway };

export type SessionChoice = {
  readonly workspace: string;
  readonly provider: string | undefined;
  readonly model: string | undefined;
  readonly effort: string | undefined;
};

/** The provider and model from flags, then GCODE_PROVIDER and GCODE_MODEL, then the defaults. */
export function chooseModel(
  io: Io,
  choice: { readonly provider: string | undefined; readonly model: string | undefined },
): { readonly provider: ProviderName; readonly model: string } {
  const provider = choice.provider ?? (io.env['GCODE_PROVIDER'] || DEFAULT_PROVIDER);
  if (!isProviderName(provider)) throw new UsageError(`unknown provider: ${provider}`);
  const model = choice.model ?? (io.env['GCODE_MODEL'] || specOf(provider).defaultModel);
  if (model === undefined) throw new UsageError(`${specOf(provider).label} has no default model; pass --model or set GCODE_MODEL`);
  return { provider, model };
}

// The gateway is built before anything is written, so a missing key leaves no stray session behind.
export async function startSession(store: Store, io: Io, choice: SessionChoice): Promise<OpenSession> {
  const effort = choice.effort ?? DEFAULT_EFFORT;
  if (!isEffort(effort)) throw new UsageError(`unknown effort: ${effort}`);
  const { provider, model } = chooseModel(io, choice);
  const gateway = gatewayFor(provider, io.env, io.fetch);
  return { log: await newSession(store, io.env, choice.workspace, provider, model, effort), gateway };
}

/** A session on an external agent, which needs no Geno model or key: the agent brings its own. */
export async function startExternalSession(store: Store, io: Io, workspace: string, backend: BackendBinding): Promise<SessionLog> {
  const named = io.env['GCODE_PROVIDER'] ?? '';
  return newSession(store, io.env, workspace, isProviderName(named) ? named : DEFAULT_PROVIDER, backend.id, DEFAULT_EFFORT, backend);
}

export async function resumeSession(store: Store, io: Io, rawId: string): Promise<OpenSession> {
  const log = await openSessionLog(store, rawId, io);
  const gateway = gatewayFor(log.session.provider, io.env, io.fetch);
  await dropTornTail(log);
  return { log, gateway };
}

export const chat: Command = async (args, { io, store }) => {
  const { values, positionals } = parseArgs({
    args,
    strict: true,
    allowPositionals: true,
    options: {
      session: { type: 'string' },
      provider: { type: 'string' },
      model: { type: 'string' },
      effort: { type: 'string' },
    },
  });
  const message = positionals.join(' ').trim();

  let opened: OpenSession;
  if (values.session === undefined) {
    if (message === '') throw new UsageError('a message is required to start a session');
    opened = await startSession(store, io, {
      workspace: io.cwd,
      provider: values.provider,
      model: values.model,
      effort: values.effort,
    });
  } else {
    if (values.provider !== undefined || values.model !== undefined || values.effort !== undefined) {
      throw new UsageError('--provider, --model and --effort are fixed when a session starts; drop them with --session');
    }
    opened = await resumeSession(store, io, values.session);
  }
  const { log, gateway } = opened;
  const { session, file } = log;
  io.out(`session: ${session.id}`);

  const events = [...log.events];
  const record = async (event: TurnEvent) => {
    events.push(event);
    await appendEvent(file, event);
  };
  if (message !== '') {
    await record({ kind: 'user', seq: nextSeq(events), at: new Date().toISOString(), content: message });
  } else if (!hasPendingPrompt(events)) {
    throw new UsageError('the session has no unanswered message; pass one');
  }

  let streamed = false;
  const result = await gateway.turn({
    session,
    events,
    tools: [],
    signal: io.interrupts(),
    onText: (delta) => {
      streamed = true;
      io.write(delta);
    },
    onRetry: async (retry) => {
      if (streamed) io.write('\n');
      streamed = false;
      await record({ kind: 'retry', seq: nextSeq(events), at: new Date().toISOString(), ...retry });
      io.err(formatRetry(retry));
    },
    onWait: (wait) => {
      if (wait !== null) io.err(formatWait(wait, Date.now()));
    },
  });
  if (streamed) io.write('\n');

  const at = new Date().toISOString();
  if (result.kind === 'error') {
    await record({ kind: 'error', seq: nextSeq(events), at, error: result.error, message: result.message });
    io.err(`${result.error}: ${result.message}`);
    return EXIT_CODES[result.error];
  }
  const { turn } = result;
  await record({ kind: 'assistant', seq: nextSeq(events), at, ...turn });
  io.out(`usage: ${formatUsage(turn.usage, turn.costUsd)} latency=${turn.latencyMs}ms`);
  return 0;
};

type EventOf<K extends TurnEvent['kind']> = Extract<TurnEvent, { kind: K }>;

const formatApproval = ({ mode, rule, decidedBy, verdict, classifier }: ApprovalRecord): string =>
  `  approval (${mode}): ${rule} -> ${verdict} by ${decidedBy}${
    classifier === undefined ? '' : `; classifier ${classifier.verdict} in ${classifier.latencyMs}ms ${formatCost(classifier.costUsd)}: ${classifier.reason}`
  }`;

export type Totals = {
  readonly turns: number;
  readonly usage: TokenUsage;
  readonly costUsd: number | null;
  readonly latencyMs: number;
};

/** A compaction's summary call counts in the usage and cost, and not in the turns or latency. */
export function totalOf(events: readonly TurnEvent[]): Totals {
  const answers = events.filter((e): e is EventOf<'assistant'> => e.kind === 'assistant');
  const spends = events.flatMap((e) => spendOf(e) ?? []);
  const sum = (pick: (u: TokenUsage) => number) => spends.reduce((n, s) => n + pick(s.usage), 0);
  return {
    turns: answers.length,
    usage: { input: sum((u) => u.input), cacheRead: sum((u) => u.cacheRead), cacheWrite: sum((u) => u.cacheWrite), output: sum((u) => u.output) },
    costUsd: spends.some((s) => s.costUsd === null) ? null : spends.reduce((n, s) => n + (s.costUsd ?? 0), 0),
    latencyMs: answers.reduce((n, e) => n + e.latencyMs, 0),
  };
}

const RENDER: { [K in TurnEvent['kind']]: (event: EventOf<K>) => string[] } = {
  'session-start': ({ session, context, fork }) => [
    `session: ${session.id}`,
    ...(fork === undefined ? [] : [`forked from: ${fork.sessionId} at turn ${fork.turnSeq} (${fork.title})`]),
    `created: ${session.createdAt}  workspace: ${session.workspace}  provider: ${session.provider}  model: ${session.model}  effort: ${session.effort}${session.backend === undefined ? '' : `  backend: ${session.backend.id}`}`,
    ...(context === undefined || isEmptyContext(context)
      ? []
      : [
          `context: ${[...context.instructions.map((f) => f.path), ...context.rules.map((r) => `${r.path} (${r.trigger.kind})`)].join(', ') || 'no instructions'}; ${context.skills.length} skills`,
        ]),
  ],
  user: ({ seq, content, context, attachments, wake }) => [
    wake === undefined ? `#${seq} user: ${content}` : `#${seq} ${wakeLabel(wake)}`,
    ...(context ?? []).map((item) => `  attached ${item.kind} ${item.path}${item.kind === 'selection' ? `:${item.startLine}-${item.endLine}` : ''}`),
    ...(attachments ?? []).map((a) => `  attached ${a.kind} ${a.name}${a.kind === 'image' ? ` ${a.width}x${a.height}` : ''} (${a.sha256.slice(0, 12)})`),
  ],
  assistant: ({ seq, content, stopReason, model, usage, costUsd, latencyMs }) => [
    `#${seq} assistant (${stopReason ?? 'no stop reason'}, ${model}): ${content
      .flatMap((block) => (block.type === 'text' ? [block.text] : []))
      .join('')}`,
    ...toolUsesOf(content).map((use) => `  tool_use ${use.id} ${use.name} ${JSON.stringify(use.input)}`),
    `  usage: ${formatUsage(usage, costUsd)} latency=${latencyMs}ms`,
  ],
  error: ({ seq, error, message }) => [`#${seq} error (${error}): ${message}`],
  checkpoint: ({ seq, turnSeq, sha, files }) => [
    `#${seq} checkpoint before turn ${turnSeq}: ${sha.slice(0, 12)}${files.length === 0 ? '' : ` changed ${files.join(', ')}`}`,
  ],
  cut: ({ seq, turnSeq }) => [`#${seq} cut the conversation from turn ${turnSeq} on`],
  compact: ({ seq, trigger, keptFrom, tokensBefore, tokensAfter, usage, costUsd, summary }) => [
    `#${seq} compact (${trigger}): kept from #${keptFrom}, ${tokensBefore} -> about ${tokensAfter} tokens, ${formatUsage(usage, costUsd)}`,
    ...summary.split('\n').map((line) => `  ${line}`),
  ],
  restored: ({ seq, turnSeq, sha, files }) => [
    `#${seq} restored to the checkpoint before turn ${turnSeq} (${sha.slice(0, 12)}): ${files.length === 0 ? 'no files changed' : files.join(', ')}`,
  ],
  'tool-result': (event) => [
    `#${event.seq} tool-result ${event.toolUseId} ${event.name} (${event.status}): ${
      'spill' in event
        ? `spilled ${event.spill.bytes} bytes to ${event.spill.path}`
        : event.output.replace(/\s+/g, ' ').trim().slice(0, 120)
    }`,
    ...(event.change === undefined ? [] : [`  changed ${event.change.path}: ${event.change.hunks.length} hunks (${event.change.id})`]),
    ...(event.approval === undefined ? [] : [formatApproval(event.approval)]),
    ...(event.spinoff === undefined ? [] : [event.spinoff.kind === 'offered' ? `  suggested ${event.spinoff.offer.id}: ${event.spinoff.offer.title}` : `  withdrew ${event.spinoff.id}`]),
    ...(event.chapter === undefined ? [] : [`  chapter: ${event.chapter.title}${event.chapter.summary === undefined ? '' : ` (${event.chapter.summary})`}`]),
  ],
  review: ({ seq, hunk, status }) => [`#${seq} review: hunk ${hunk} ${status}`],
  retry: ({ seq, ...retry }) => [`#${seq} ${formatRetry(retry)}`],
  wait: ({ seq, at, wait }) => [`#${seq} ${formatWait(wait, Date.parse(at))}`],
  wake: ({ seq, note }) => [`#${seq} wake ${note.kind}${'id' in note ? ` ${note.id}` : ''}${note.kind === 'scheduled' ? ` at ${new Date(note.dueAt).toISOString()}: ${note.reason}` : note.kind === 'monitor' ? ` on ${note.job}: ${note.outcome}` : note.kind === 'pr' ? ` on PR #${note.pr}: ${note.outcome}` : ''}`],
  mode: ({ seq, mode }) => [`${seq === undefined ? '' : `#${seq} `}mode: ${mode}`],
  effort: ({ seq, effort }) => [`${seq === undefined ? '' : `#${seq} `}effort: ${effort}`],
  title: ({ seq, title }) => [`#${seq} renamed: ${title}`],
  'child-start': ({ seq, child, role, model, effort, caps, start }) => [
    `#${seq} child-start ${role} ${child} (${start}, ${model}, effort ${effort}, caps ${caps.maxTurns} turns $${caps.maxCostUsd})`,
  ],
  'child-end': ({ seq, child, end, turns, costUsd, summary }) => [`#${seq} child-end ${child} ${childEndWords(end)} turns=${turns} ${formatCost(costUsd)}: ${summary}`],
  'backend-start': ({ seq, agentSessionId, lane, sandboxed }) => [`#${seq} backend session ${agentSessionId}${lane === null ? '' : ` in lane ${lane}`}${sandboxed ? ', sandboxed' : ', not sandboxed'}`],
  'backend-model': ({ seq, model }) => [`${seq === undefined ? '' : `#${seq} `}backend model: ${model}`],
  chapter: ({ seq, turnSeq, mark }) => [`${seq === undefined ? '' : `#${seq} `}chapter at turn ${turnSeq}: ${mark === null ? 'removed by the user' : `${mark.title}, marked by the user`}`],
  spinoff: ({ seq, id, decision }) => [`${seq === undefined ? '' : `#${seq} `}spinoff ${id}: ${decision.kind === 'started' ? `started as session ${decision.sessionId} in lane ${decision.lane}` : 'dismissed by the user'}`],
  'lane-apply': ({ seq, lane, changes, conflicts, deleted }) => [
    `#${seq} lane-apply ${lane}: ${conflicts.length > 0 ? `${conflicts.length} conflicts, nothing applied` : `${changes.length + deleted.length} files`}`,
    ...changes.map((change) => `  changed ${change.path} (${change.hunks.length} hunks)`),
    ...deleted.map((file) => `  deleted ${file}`),
    ...conflicts.map((conflict) => `  conflict ${conflict.path}: ${conflict.reason}`),
  ],
  'background-end': ({ seq, job, tail }) => [`#${seq} background ${job.id} ${jobEndText(job.state)}: ${job.command}`, ...(tail === '' ? [] : tail.split('\n').map((line) => `  ${line}`))],
};

const render = <K extends TurnEvent['kind']>(event: EventOf<K>): string[] =>
  (RENDER[event.kind] as (e: EventOf<K>) => string[])(event);

export const showSession: Command = async (args, { io, store }) => {
  const { positionals } = parseArgs({ args, strict: true, allowPositionals: true, options: {} });
  const { events } = await openSessionLog(store, singleId(positionals, 'session'), io);
  for (const event of events) for (const line of render(event)) io.out(line);

  const total = totalOf(events);
  io.out(`total: turns=${total.turns} ${formatUsage(total.usage, total.costUsd)} latency=${total.latencyMs}ms`);
  return 0;
};
