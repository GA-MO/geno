import { appendFile, mkdir, readFile, truncate } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import type { ContentBlock, StopReason } from '@anthropic-ai/sdk/resources/messages/messages';
import {
  asSessionId,
  EFFORTS,
  PROVIDERS,
  TURN_ERROR_KINDS,
  type Session,
  type SessionId,
  type TurnEvent,
} from '@g-code/core';
import { EngineError } from './errors.js';
import { isMissing, StoreError, type Store } from './store.js';

const count = z.number().int().nonnegative();
const seqFields = { seq: z.number().int().positive(), at: z.iso.datetime() };

const sessionSchema = z.strictObject({
  id: z.string().min(1).transform(asSessionId),
  createdAt: z.iso.datetime(),
  workspace: z.string().refine(path.isAbsolute, 'must be an absolute path'),
  // Logs written before providers existed all went to OpenRouter.
  provider: z.enum(PROVIDERS).default('openrouter'),
  model: z.string().min(1),
  effort: z.enum(EFFORTS),
});

// Blocks are stored exactly as the API returned them and replayed verbatim, so only their tag is checked.
const contentBlock = z.custom<ContentBlock>(
  (raw) => z.looseObject({ type: z.string() }).safeParse(raw).success,
  'content block must be an object with a string type',
);

const turnEventSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('session-start'), session: sessionSchema }),
  z.strictObject({ kind: z.literal('user'), ...seqFields, content: z.string() }),
  z.strictObject({
    kind: z.literal('assistant'),
    ...seqFields,
    content: z.array(contentBlock),
    stopReason: z.string().nullable().transform((reason) => reason as StopReason | null),
    usage: z.strictObject({ input: count, cacheRead: count, cacheWrite: count, output: count }),
    costUsd: z.number().nonnegative().nullable(),
    latencyMs: count,
    model: z.string().min(1),
  }),
  z.strictObject({ kind: z.literal('error'), ...seqFields, error: z.enum(TURN_ERROR_KINDS), message: z.string() }),
]);

export type SessionLog = {
  readonly file: string;
  readonly session: Session;
  /** Every parsed event, starting with the session-start header. */
  readonly events: readonly TurnEvent[];
  /** 1-based line number of a torn trailing line that was skipped. */
  readonly tornLine: number | undefined;
  /** Byte length of the file up to and including the last good line. */
  readonly goodBytes: number;
};

export const sessionFile = (store: Store, id: SessionId): string => path.join(store.sessionsDir, `${id}.jsonl`);

/** One appendFile call per event, so a crash can tear at most the line being written. */
export async function appendEvent(file: string, event: TurnEvent): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true });
  await appendFile(file, `${JSON.stringify(event)}\n`);
}

function parseLine(file: string, lineNo: number, line: string): TurnEvent {
  const parsed = turnEventSchema.safeParse(JSON.parse(line));
  if (!parsed.success) throw new StoreError(file, `line ${lineNo}: ${z.prettifyError(parsed.error)}`);
  const event: TurnEvent = parsed.data;
  if ((lineNo === 1) !== (event.kind === 'session-start')) {
    throw new StoreError(file, `line ${lineNo}: session-start must be line 1 and only line 1`);
  }
  return event;
}

export async function readSessionLog(file: string): Promise<SessionLog> {
  let text: string;
  try {
    text = await readFile(file, 'utf8');
  } catch (error) {
    if (isMissing(error)) throw new EngineError(`no session log at ${file}`);
    throw error;
  }
  const lines = text.split('\n');
  const lastLine = text.endsWith('\n') ? lines.length - 1 : lines.length;
  const events: TurnEvent[] = [];
  let goodBytes = 0;
  let tornLine: number | undefined;
  for (let i = 0; i < lastLine; i++) {
    const line = lines[i]!;
    const lineNo = i + 1;
    try {
      events.push(parseLine(file, lineNo, line));
    } catch (error) {
      const isTail = lineNo === lastLine && lineNo > 1;
      if (error instanceof SyntaxError && isTail) {
        tornLine = lineNo;
        break;
      }
      if (error instanceof SyntaxError) throw new StoreError(file, `line ${lineNo}: ${error.message}`);
      throw error;
    }
    goodBytes += Buffer.byteLength(line) + 1;
  }
  const header = events[0];
  if (header?.kind !== 'session-start') throw new StoreError(file, 'line 1: missing session-start');
  return { file, session: header.session, events, tornLine, goodBytes };
}

/** Cuts a torn trailing line so the next append starts on a fresh line. */
export async function dropTornTail(log: SessionLog): Promise<void> {
  if (log.tornLine !== undefined) await truncate(log.file, log.goodBytes);
}
