import { randomUUID } from 'node:crypto';
import { parseArgs } from 'node:util';
import {
  asSessionId,
  hasPendingPrompt,
  isEffort,
  nextSeq,
  type Effort,
  type Session,
  type TokenUsage,
  type TurnErrorKind,
  type TurnEvent,
} from '@g-code/core';
import { checkId, UsageError, type Command, type Io } from './command.js';
import { openRouterGateway } from './gateway.js';
import { appendEvent, dropTornTail, readSessionLog, sessionFile, type SessionLog } from './sessions.js';
import type { Store } from './store.js';

export const DEFAULT_MODEL = 'anthropic/claude-opus-5.5';
const DEFAULT_EFFORT: Effort = 'medium';

const EXIT_CODES: Record<TurnErrorKind, number> = { refusal: 1, transport: 1, abort: 130 };

export const formatCost = (costUsd: number | null): string =>
  costUsd === null ? 'cost=unknown' : `cost=$${costUsd.toFixed(6)}`;

export const formatUsage = (usage: TokenUsage, costUsd: number | null): string =>
  `in=${usage.input} cache_read=${usage.cacheRead} cache_write=${usage.cacheWrite} out=${usage.output} ${formatCost(costUsd)}`;

export async function openSessionLog(store: Store, rawId: string, io: Io): Promise<SessionLog> {
  const log = await readSessionLog(sessionFile(store, asSessionId(checkId(rawId, 'session'))));
  if (log.tornLine !== undefined) io.err(`warning: ${log.file}: skipped torn line ${log.tornLine}`);
  return log;
}

async function newSession(store: Store, io: Io, model: string, effort: Effort): Promise<SessionLog> {
  const session: Session = {
    id: asSessionId(randomUUID()),
    createdAt: new Date().toISOString(),
    workspace: io.cwd,
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
    options: { session: { type: 'string' }, model: { type: 'string' }, effort: { type: 'string' } },
  });
  const message = positionals.join(' ').trim();
  if (values.effort !== undefined && !isEffort(values.effort)) throw new UsageError(`unknown effort: ${values.effort}`);
  const gateway = openRouterGateway(io.env, io.fetch);

  let log: SessionLog;
  if (values.session === undefined) {
    if (message === '') throw new UsageError('a message is required to start a session');
    const model = values.model ?? (io.env['GCODE_MODEL'] || DEFAULT_MODEL);
    log = await newSession(store, io, model, (values.effort as Effort | undefined) ?? DEFAULT_EFFORT);
  } else {
    if (values.model !== undefined || values.effort !== undefined) {
      throw new UsageError('--model and --effort are fixed when a session starts; drop them with --session');
    }
    log = await openSessionLog(store, values.session, io);
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
