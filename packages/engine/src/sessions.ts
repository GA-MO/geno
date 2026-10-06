import { appendFile, mkdir, readFile, truncate } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import type { ContentBlock, StopReason } from '@anthropic-ai/sdk/resources/messages/messages';
import {
  APPROVAL_MODES,
  asSessionId,
  CHILD_CAPS,
  CHILD_STARTS,
  APPROVAL_RULE_IDS,
  EFFORTS,
  HUNK_STATUSES,
  nextSeq,
  PROVIDERS,
  SESSION_MODES,
  sessionEffortOf,
  sessionModeOf,
  TOOL_STATUSES,
  TURN_ERROR_KINDS,
  type Effort,
  type HunkId,
  type Session,
  type SessionId,
  type SessionMode,
  type TurnEvent,
  LANE_CONFLICT_REASONS,
  type LaneConflictReason,
} from '@g-code/core';
import { attachmentSchema, imageAttachmentSchema, widgetRefSchema } from './attachments.js';
import { EngineError } from './errors.js';
import { isMissing, StoreError, type Store } from './store.js';

const count = z.number().int().nonnegative();
const seqFields = { seq: z.number().int().positive(), at: z.iso.datetime() };

const epochMs = z.number().nonnegative();
const toolMarks = { startAt: epochMs, endAt: epochMs };
const modelMarksSchema = z.strictObject({
  startAt: epochMs,
  requestAt: epochMs,
  firstTokenAt: epochMs.nullable(),
  firstAnswerAt: epochMs.nullable(),
  lastTokenAt: epochMs.nullable(),
  endAt: epochMs,
});

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

const instructionFileSchema = z.strictObject({ path: z.string().min(1), text: z.string() });

const loadedContextSchema = z.strictObject({
  global: instructionFileSchema.optional(),
  instructions: z.array(instructionFileSchema),
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
  widget: widgetRefSchema.optional(),
  timing: z.strictObject(toolMarks).optional(),
};

const childCapsSchema = z.strictObject({ maxTurns: z.number().int().positive(), maxCostUsd: z.number().positive() });
const childStartSchema = z.enum(CHILD_STARTS);
const childId = z.string().min(1).transform(asSessionId);

const childOfSchema = z.strictObject({
  parentId: childId,
  toolUseId: z.string().min(1),
  role: z.string().min(1),
  caps: childCapsSchema,
  start: childStartSchema,
});

const childEndSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('done') }),
  z.strictObject({ kind: z.literal('failed'), reason: z.string() }),
  z.strictObject({ kind: z.literal('cancelled') }),
  z.strictObject({ kind: z.literal('capped'), cap: z.enum(CHILD_CAPS) }),
]);

// A tool result is inline or spilled, so its two shapes share a kind and sit outside the discriminated union.
const turnEventSchema = z.union([
  z.discriminatedUnion('kind', [
    z.strictObject({ kind: z.literal('session-start'), session: sessionSchema, context: loadedContextSchema.optional(), child: childOfSchema.optional() }),
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
      timing: modelMarksSchema.optional(),
      issuedBy: z.literal('user').optional(),
    }),
    z.strictObject({
      kind: z.literal('error'),
      ...seqFields,
      error: z.enum(TURN_ERROR_KINDS),
      message: z.string(),
      timing: modelMarksSchema.optional(),
      tools: z.array(z.strictObject({ toolUseId: z.string().min(1), name: z.string(), ...toolMarks })).optional(),
    }),
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
    z.strictObject({ kind: z.literal('mode'), seq: seqFields.seq.optional(), at: seqFields.at, mode: z.enum(SESSION_MODES) }),
    z.strictObject({ kind: z.literal('effort'), seq: seqFields.seq.optional(), at: seqFields.at, effort: z.enum(EFFORTS) }),
    z.strictObject({ kind: z.literal('title'), ...seqFields, title: z.string().min(1) }),
    z.strictObject({
      kind: z.literal('child-start'),
      ...seqFields,
      child: childId,
      toolUseId: z.string().min(1),
      role: z.string().min(1),
      model: z.string().min(1),
      effort: z.enum(EFFORTS),
      caps: childCapsSchema,
      start: childStartSchema,
    }),
    z.strictObject({
      kind: z.literal('child-end'),
      ...seqFields,
      child: childId,
      toolUseId: z.string().min(1),
      end: childEndSchema,
      turns: count,
      costUsd: z.number().nonnegative().nullable(),
      summary: z.string(),
    }),
    z.strictObject({
      kind: z.literal('lane-apply'),
      ...seqFields,
      lane: z.string().min(1),
      changes: z.array(fileChangeSchema),
      conflicts: z.array(z.strictObject({ path: z.string(), reason: z.enum(Object.keys(LANE_CONFLICT_REASONS) as [LaneConflictReason, ...LaneConflictReason[]]) })),
      deleted: z.array(z.string()),
      grafted: count.optional(),
    }),
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

/** A setting the user changes while a turn may run. */
export type SettingChange = { readonly kind: 'mode'; readonly mode: SessionMode } | { readonly kind: 'effort'; readonly effort: Effort };

/**
 * Logs a setting change while a turn holds the log, so the change outlives a turn that never ends. It takes no seq,
 * which the turn owns, and it leaves a torn tail for the turn to cut: then it logs nothing and returns false.
 */
export async function logBesideTurn(log: SessionLog, change: SettingChange): Promise<boolean> {
  if (log.tornLine !== undefined) return false;
  const unchanged = change.kind === 'mode' ? sessionModeOf(log.events) === change.mode : sessionEffortOf(log.session, log.events) === change.effort;
  if (!unchanged) await appendEvent(log.file, { ...change, at: new Date().toISOString() });
  return true;
}

/** Logs a change of the session's effort. Setting the effort it already has logs nothing. */
export async function logEffort(log: SessionLog, effort: Effort): Promise<SessionLog> {
  if (sessionEffortOf(log.session, log.events) === effort) return log;
  const event: TurnEvent = { kind: 'effort', seq: nextSeq(log.events), at: new Date().toISOString(), effort };
  await appendEvent(log.file, event);
  return { ...log, events: [...log.events, event] };
}

/** Cuts a torn trailing line so the next append starts on a fresh line. */
export async function dropTornTail(log: SessionLog): Promise<void> {
  if (log.tornLine !== undefined) await truncate(log.file, log.goodBytes);
}
