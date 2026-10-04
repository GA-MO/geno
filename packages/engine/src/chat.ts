import { randomUUID } from 'node:crypto';
import { parseArgs } from 'node:util';
import {
  asSessionId,
  hasPendingPrompt,
  isEffort,
  isProviderName,
  nextSeq,
  toolUsesOf,
  type Effort,
  type ProviderName,
  type Session,
  type TokenUsage,
  type TurnErrorKind,
  type TurnEvent,
} from '@g-code/core';
import { checkId, singleId, UsageError, type Command, type Io } from './command.js';
import { gatewayFor, PROVIDER_TABLE, type Gateway } from './gateway.js';
import { appendEvent, dropTornTail, readSessionLog, sessionFile, type SessionLog } from './sessions.js';
import type { Store } from './store.js';

export const DEFAULT_PROVIDER: ProviderName = 'modelstudio';
const DEFAULT_EFFORT: Effort = 'medium';

export const EXIT_CODES: Record<TurnErrorKind, number> = {
  refusal: 1,
  transport: 1,
  abort: 130,
  'max-turns': 3,
  budget: 3,
};

export const formatCost = (costUsd: number | null): string =>
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
  io: Io,
  provider: ProviderName,
  model: string,
  effort: Effort,
): Promise<SessionLog> {
  const session: Session = {
    id: asSessionId(randomUUID()),
    createdAt: new Date().toISOString(),
    workspace: io.cwd,
    provider,
    model,
    effort,
  };
  const file = sessionFile(store, session.id);
  const start: TurnEvent = { kind: 'session-start', session };
  await appendEvent(file, start);
  return { file, session, events: [start], tornLine: undefined, goodBytes: 0 };
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
  const effort = values.effort ?? DEFAULT_EFFORT;
  if (!isEffort(effort)) throw new UsageError(`unknown effort: ${effort}`);

  // The gateway is built before anything is written, so a missing key leaves no stray session behind.
  let log: SessionLog;
  let gateway: Gateway;
  if (values.session === undefined) {
    if (message === '') throw new UsageError('a message is required to start a session');
    const provider = values.provider ?? (io.env['GCODE_PROVIDER'] || DEFAULT_PROVIDER);
    if (!isProviderName(provider)) throw new UsageError(`unknown provider: ${provider}`);
    const model = values.model ?? (io.env['GCODE_MODEL'] || PROVIDER_TABLE[provider].defaultModel);
    gateway = gatewayFor(provider, io.env, io.fetch);
    log = await newSession(store, io, provider, model, effort);
  } else {
    if (values.provider !== undefined || values.model !== undefined || values.effort !== undefined) {
      throw new UsageError('--provider, --model and --effort are fixed when a session starts; drop them with --session');
    }
    log = await openSessionLog(store, values.session, io);
    gateway = gatewayFor(log.session.provider, io.env, io.fetch);
    await dropTornTail(log);
  }
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
    signal: io.interrupts(),
    onText: (delta) => {
      streamed = true;
      io.write(delta);
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

const RENDER: { [K in TurnEvent['kind']]: (event: EventOf<K>) => string[] } = {
  'session-start': ({ session }) => [
    `session: ${session.id}`,
    `created: ${session.createdAt}  workspace: ${session.workspace}  provider: ${session.provider}  model: ${session.model}  effort: ${session.effort}`,
  ],
  user: ({ seq, content }) => [`#${seq} user: ${content}`],
  assistant: ({ seq, content, stopReason, model, usage, costUsd, latencyMs }) => [
    `#${seq} assistant (${stopReason ?? 'no stop reason'}, ${model}): ${content
      .flatMap((block) => (block.type === 'text' ? [block.text] : []))
      .join('')}`,
    ...toolUsesOf(content).map((use) => `  tool_use ${use.id} ${use.name} ${JSON.stringify(use.input)}`),
    `  usage: ${formatUsage(usage, costUsd)} latency=${latencyMs}ms`,
  ],
  error: ({ seq, error, message }) => [`#${seq} error (${error}): ${message}`],
  'tool-result': (event) => [
    `#${event.seq} tool-result ${event.toolUseId} ${event.name} (${event.status}): ${
      'spill' in event
        ? `spilled ${event.spill.bytes} bytes to ${event.spill.path}`
        : event.output.replace(/\s+/g, ' ').trim().slice(0, 120)
    }`,
  ],
};

const render = <K extends TurnEvent['kind']>(event: EventOf<K>): string[] =>
  (RENDER[event.kind] as (e: EventOf<K>) => string[])(event);

export const showSession: Command = async (args, { io, store }) => {
  const { positionals } = parseArgs({ args, strict: true, allowPositionals: true, options: {} });
  const { events } = await openSessionLog(store, singleId(positionals, 'session'), io);
  for (const event of events) for (const line of render(event)) io.out(line);

  const answers = events.filter((e): e is EventOf<'assistant'> => e.kind === 'assistant');
  const sum = (pick: (e: EventOf<'assistant'>) => number) => answers.reduce((n, e) => n + pick(e), 0);
  const total: TokenUsage = {
    input: sum((e) => e.usage.input),
    cacheRead: sum((e) => e.usage.cacheRead),
    cacheWrite: sum((e) => e.usage.cacheWrite),
    output: sum((e) => e.usage.output),
  };
  const cost = answers.some((e) => e.costUsd === null) ? null : sum((e) => e.costUsd ?? 0);
  io.out(`total: turns=${answers.length} ${formatUsage(total, cost)} latency=${sum((e) => e.latencyMs)}ms`);
  return 0;
};
