import { appendFile, mkdir, readFile, truncate } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import type { ContentBlock, StopReason } from '@anthropic-ai/sdk/resources/messages/messages';
import {
  APPROVAL_MODES,
  asSessionId,
  APPROVAL_RULE_IDS,
  EFFORTS,
  HUNK_STATUSES,
  nextSeq,
  PROVIDERS,
  SESSION_MODES,
  sessionModeOf,
  TOOL_STATUSES,
  TURN_ERROR_KINDS,
  type HunkId,
  type Session,
  type SessionId,
  type SessionMode,
  type TurnEvent,
} from '@g-code/core';
import { attachmentSchema, imageAttachmentSchema } from './attachments.js';
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

const loadedContextSchema = z.strictObject({
  instructions: z.array(z.strictObject({ path: z.string().min(1), text: z.string() })),
  rules: z.array(
    z.strictObject({
      path: z.string().min(1),
      trigger: z.discriminatedUnion('kind', [
        z.strictObject({ kind: z.literal('always') }),
        z.strictObject({ kind: z.literal('globs'), globs: z.array(z.string().min(1)).min(1) }),
        z.strictObject({ kind: z.literal('requested'), description: z.string().min(1) }),
      ]),
      text: z.string(),
    }),
  ),
  skills: z.array(z.strictObject({ name: z.string().min(1), description: z.string().min(1), path: z.string().min(1) })),
});

const contextItemSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('file'), path: z.string().min(1), text: z.string() }),
  z.strictObject({
    kind: z.literal('selection'),
    path: z.string().min(1),
    startLine: z.number().int().positive(),
    endLine: z.number().int().positive(),
    text: z.string(),
  }),
  z.strictObject({ kind: z.literal('rule'), path: z.string().min(1), matched: z.string().min(1), text: z.string() }),
  z.strictObject({ kind: z.literal('skill'), name: z.string().min(1), path: z.string().min(1), text: z.string() }),
]);

const hunkId = z.string().min(1).transform((raw) => raw as HunkId);

const fileChangeSchema = z.strictObject({
  id: z.string().min(1),
  path: z.string().refine(path.isAbsolute, 'must be an absolute path'),
  hunks: z.array(
    z.strictObject({
      startLine: z.number().int().positive(),
      lineCount: count,
      oldText: z.string(),
      newText: z.string(),
      status: z.enum(HUNK_STATUSES),
    }),
  ),
});

const verdict = z.enum(['allow', 'ask', 'deny']);

const approvalSchema = z.strictObject({
  mode: z.enum(APPROVAL_MODES),
  rule: z.enum(APPROVAL_RULE_IDS),
  reason: z.string(),
  command: z.string(),
  classifier: z
    .strictObject({ verdict, reason: z.string(), model: z.string(), latencyMs: count, costUsd: z.number().nonnegative().nullable() })
    .optional(),
  decidedBy: z.enum(['rule', 'classifier', 'user']),
  verdict: verdict.exclude(['ask']),
});

const toolResultFields = {
  kind: z.literal('tool-result'),
  ...seqFields,
  toolUseId: z.string().min(1),
  name: z.string(),
  status: z.enum(TOOL_STATUSES),
  change: fileChangeSchema.optional(),
  approval: approvalSchema.optional(),
  images: z.array(imageAttachmentSchema).optional(),
};

// A tool result is inline or spilled, so its two shapes share a kind and sit outside the discriminated union.
const turnEventSchema = z.union([
  z.discriminatedUnion('kind', [
    z.strictObject({ kind: z.literal('session-start'), session: sessionSchema, context: loadedContextSchema.optional() }),
    z.strictObject({
      kind: z.literal('user'),
      ...seqFields,
      content: z.string(),
      context: z.array(contextItemSchema).optional(),
      attachments: z.array(attachmentSchema).optional(),
      command: z.strictObject({ name: z.string().min(1), args: z.string() }).optional(),
    }),
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
    z.strictObject({
      kind: z.literal('checkpoint'),
      ...seqFields,
      sessionId: z.string().min(1).transform(asSessionId),
      turnSeq: z.number().int().positive(),
      sha: z.string().min(1),
      files: z.array(z.string()),
      label: z.string(),
    }),
    z.strictObject({
      kind: z.literal('restored'),
      ...seqFields,
      turnSeq: z.number().int().positive(),
      sha: z.string().min(1),
      files: z.array(z.string()),
    }),
    z.strictObject({ kind: z.literal('review'), ...seqFields, hunk: hunkId, status: z.enum(HUNK_STATUSES) }),
    z.strictObject({ kind: z.literal('retry'), ...seqFields, attempt: z.number().int().positive(), delayMs: count, message: z.string() }),
    z.strictObject({ kind: z.literal('mode'), ...seqFields, mode: z.enum(SESSION_MODES) }),
    z.strictObject({ kind: z.literal('title'), ...seqFields, title: z.string().min(1) }),
  ]),
  z.strictObject({ ...toolResultFields, output: z.string() }),
  z.strictObject({
    ...toolResultFields,
    spill: z.strictObject({ path: z.string().min(1), bytes: count, head: z.string(), tail: z.string() }),
  }),
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

/** Logs a switch of the session's approval mode. Switching to the mode it already has logs nothing. */
export async function logMode(log: SessionLog, mode: SessionMode): Promise<SessionLog> {
  if (sessionModeOf(log.events) === mode) return log;
  const event: TurnEvent = { kind: 'mode', seq: nextSeq(log.events), at: new Date().toISOString(), mode };
  await appendEvent(log.file, event);
  return { ...log, events: [...log.events, event] };
}

/** Cuts a torn trailing line so the next append starts on a fresh line. */
export async function dropTornTail(log: SessionLog): Promise<void> {
  if (log.tornLine !== undefined) await truncate(log.file, log.goodBytes);
}
