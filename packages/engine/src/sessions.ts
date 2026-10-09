import { appendFile, mkdir, readFile, truncate } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import type { ContentBlock, StopReason } from '@anthropic-ai/sdk/resources/messages/messages';
import {
  APPROVAL_MODES,
  asSessionId,
  CHILD_CAPS,
  CHILD_STARTS,
  COMPACT_TRIGGERS,
  cutView,
  APPROVAL_RULE_IDS,
  EXTERNAL_BACKEND_IDS,
  EFFORTS,
  HUNK_STATUSES,
  INPUT_PARTS,
  nextSeq,
  PROVIDERS,
  SESSION_MODES,
  sessionEffortOf,
  sessionModeOf,
  TODO_STATUSES,
  TOOL_STATUSES,
  TURN_ERROR_KINDS,
  WAIT_KINDS,
  type Effort,
  type HunkId,
  type Session,
  type SessionId,
  type SessionMode,
  type TurnEvent,
  LANE_CONFLICT_REASONS,
  type LaneConflictReason,
  isJobId,
  type JobId,
  isWakeId,
  MONITOR_OUTCOMES,
  PR_WATCH_OUTCOMES,
  type WakeId,
  spinoffsOf,
  CHAPTER_LIMITS,
  chaptersOf,
  userChapterAt,
  type ChapterMark,
  type SpinoffDecision,
  type SpinoffId,
} from '@g-code/core';
import { attachmentSchema, imageAttachmentSchema, widgetRefSchema } from './attachments.js';
import { memoryEntrySchema } from './memory.js';
import { editorActionSchema } from './tools/editor.js';
import { EngineError } from './errors.js';
import { isMissing, StoreError, type Store } from './store.js';

const count = z.number().int().nonnegative();
const seqFields = { seq: z.number().int().positive(), at: z.iso.datetime() };

const killCause = z.enum(['session-deleted', 'lane-discarded', 'engine-exit']);
const endedJobStateSchema = z.discriminatedUnion('status', [
  z.strictObject({ status: z.literal('exited'), exitCode: z.number().int().nullable(), signal: z.string().nullable() }),
  z.strictObject({ status: z.literal('stopped'), by: z.enum(['model', 'user']) }),
  z.strictObject({ status: z.literal('killed'), cause: killCause }),
]);

const epochMs = z.number().nonnegative();
const toolMarks = { startAt: epochMs, endAt: epochMs };
const modelMarksSchema = z.strictObject({
  startAt: epochMs,
  requestAt: epochMs,
  firstTokenAt: epochMs.nullable(),
  firstAnswerAt: epochMs.nullable(),
  lastTokenAt: epochMs.nullable(),
  endAt: epochMs,
  waitMs: z.number().int().nonnegative().optional(),
});

const waitingSchema = z.strictObject({
  kind: z.enum(WAIT_KINDS),
  since: epochMs,
  retryAt: epochMs.nullable(),
  resetAt: epochMs.nullable(),
  message: z.string(),
});

const sessionSchema = z.strictObject({
  id: z.string().min(1).transform(asSessionId),
  createdAt: z.iso.datetime(),
  workspace: z.string().refine(path.isAbsolute, 'must be an absolute path'),
  // Logs written before providers existed all went to OpenRouter.
  provider: z.enum(PROVIDERS).default('openrouter'),
  model: z.string().min(1),
  effort: z.enum(EFFORTS),
  backend: z.strictObject({ id: z.enum(EXTERNAL_BACKEND_IDS) }).optional(),
});

// Blocks are stored exactly as the API returned them and replayed verbatim, so only their tag is checked.
const contentBlock = z.custom<ContentBlock>(
  (raw) => z.looseObject({ type: z.string() }).safeParse(raw).success,
  'content block must be an object with a string type',
);

const instructionFileSchema = z.strictObject({ path: z.string().min(1), text: z.string(), importedFrom: z.string().min(1).optional() });

const loadedContextSchema = z.strictObject({
  user: z.array(instructionFileSchema).optional(),
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
  skills: z.array(z.strictObject({ name: z.string().min(1), description: z.string().min(1), path: z.string().min(1) })).optional(),
  skillListing: z
    .strictObject({ skills: z.array(z.strictObject({ name: z.string().min(1), description: z.string() })), unlisted: z.int().nonnegative() })
    .optional(),
  nested: z.array(instructionFileSchema.extend({ dir: z.string().min(1) })).optional(),
});

const environmentSchema = z.strictObject({
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  platform: z.string().min(1),
  osVersion: z.string(),
  loginShell: z.string().min(1).optional(),
  scratchpad: z.string().refine(path.isAbsolute, 'must be an absolute path'),
  git: z
    .union([z.strictObject({ branch: z.string().min(1).optional(), status: z.array(z.string()), moreStatus: count, commits: z.array(z.string()) }), z.literal('omitted')])
    .optional(),
  project: z
    .strictObject({
      packageManager: z.string().min(1).optional(),
      scripts: z.array(z.tuple([z.string(), z.string()])),
      otherScripts: z.array(z.string()),
      versions: z.array(z.tuple([z.string(), z.string()])),
    })
    .optional(),
  lane: z.strictObject({ name: z.string().min(1), branch: z.string().min(1), main: z.string().min(1) }).optional(),
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
  z.strictObject({ kind: z.literal('rule'), path: z.string().min(1), matched: z.string().min(1), text: z.string(), importedFrom: z.string().min(1).optional() }),
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
  decidedBy: z.enum(['rule', 'classifier', 'user', 'hook']),
  verdict: verdict.exclude(['ask']),
  message: z.string().optional(),
  interrupt: z.literal(true).optional(),
});

const hookNotesSchema = z.array(z.strictObject({ how: z.enum(['success', 'additional-context', 'blocking']), text: z.string() })).min(1);

const todoSchema = z.array(z.strictObject({ id: z.string(), text: z.string(), status: z.enum(TODO_STATUSES) }));

const spinoffId = z.string().regex(/^task_[0-9a-f]{8}$/).transform((raw) => raw as SpinoffId);
const spinoffNoteSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('offered'), offer: z.strictObject({ id: spinoffId, title: z.string().min(1), tldr: z.string().min(1), prompt: z.string().min(1) }) }),
  z.strictObject({ kind: z.literal('withdrawn'), id: spinoffId }),
]);
const spinoffDecisionSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('started'), sessionId: z.string().min(1), lane: z.string().min(1) }),
  z.strictObject({ kind: z.literal('dismissed') }),
]);
const usageSchema = z.strictObject({ input: count, cacheRead: count, cacheWrite: count, output: count });

const keptSchema = z.strictObject({
  messages: z.array(z.strictObject({ seq: z.number().int().positive(), from: z.enum(['user', 'parent']), steer: z.boolean(), text: z.string() })),
  droppedMessages: count,
  todo: todoSchema,
  tools: z.array(z.string()),
  files: z.strictObject({ read: z.array(z.string()), changed: z.array(z.string()) }),
  chapters: z.array(z.string()).optional(),
  skills: z.array(z.strictObject({ name: z.string().min(1), text: z.string().nullable() })).optional(),
  attached: z.array(z.strictObject({ path: z.string().min(1), text: z.string() })).optional(),
});
const chapterMarkSchema = z.strictObject({ title: z.string().min(1).max(CHAPTER_LIMITS.title), summary: z.string().min(1).max(CHAPTER_LIMITS.summary).optional() });

const diskStateFields = { hash: z.string().min(1), size: count, mtimeMs: z.number().nonnegative() };

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
  editorAction: editorActionSchema.optional(),
  todo: todoSchema.optional(),
  loaded: z.array(z.string()).optional(),
  spinoff: spinoffNoteSchema.optional(),
  chapter: chapterMarkSchema.optional(),
  file: z.strictObject({ path: z.string().min(1), ...diskStateFields }).optional(),
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
  depth: z.number().int().positive().optional(),
  background: z.literal(true).optional(),
  lane: z.string().min(1).optional(),
});

const childEndSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('done') }),
  z.strictObject({ kind: z.literal('failed'), reason: z.string() }),
  z.strictObject({ kind: z.literal('cancelled'), by: z.literal('model').optional() }),
  z.strictObject({ kind: z.literal('capped'), cap: z.enum(CHILD_CAPS) }),
  z.strictObject({ kind: z.literal('interrupted') }),
]);

const waiterSchema = z.strictObject({ pid: z.number().int().positive(), cwd: z.string().min(1) });
const jobId = z.string().refine(isJobId, 'not a job id').transform((raw) => raw as JobId);
const wakeId = z.string().refine(isWakeId, 'not a wake id').transform((raw) => raw as WakeId);
const wakeTriggerSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('children') }),
  z.strictObject({ kind: z.literal('jobs'), job: jobId }),
  z.strictObject({ kind: z.literal('monitor'), id: wakeId, outcome: z.enum(MONITOR_OUTCOMES) }),
  z.strictObject({ kind: z.literal('schedule'), id: wakeId }),
  z.strictObject({ kind: z.literal('pr'), id: wakeId, outcome: z.enum(PR_WATCH_OUTCOMES) }),
]);
const wakeNoteSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('scheduled'), id: wakeId, toolUseId: z.string().min(1), dueAt: z.number().int().nonnegative(), reason: z.string(), by: waiterSchema.optional() }),
  z.strictObject({ kind: z.literal('due'), id: wakeId, toolUseId: z.string().min(1), reason: z.string() }),
  z.strictObject({ kind: z.literal('monitor'), id: wakeId, toolUseId: z.string().min(1), job: jobId, pattern: z.string(), outcome: z.enum(MONITOR_OUTCOMES), line: z.string().optional() }),
  z.strictObject({ kind: z.literal('pr'), id: wakeId, toolUseId: z.string().min(1), pr: z.number().int().positive(), outcome: z.enum(PR_WATCH_OUTCOMES), text: z.string() }),
  z.strictObject({ kind: z.literal('cancelled') }),
  z.strictObject({ kind: z.literal('stopped'), id: wakeId }),
  z.strictObject({ kind: z.literal('interrupted'), runs: z.array(z.strictObject({ child: z.string().min(1), toolUseId: z.string().min(1) })), text: z.string() }),
]);

// A tool result is inline or spilled, so its two shapes share a kind and sit outside the discriminated union.
const turnEventSchema = z.union([
  z.discriminatedUnion('kind', [
    z.strictObject({
      kind: z.literal('session-start'),
      session: sessionSchema,
      context: loadedContextSchema.optional(),
      memory: z.array(memoryEntrySchema).optional(),
      environment: environmentSchema.optional(),
      child: childOfSchema.optional(),
      fork: z.strictObject({ sessionId: childId, turnSeq: seqFields.seq, title: z.string() }).optional(),
      workflow: z.strictObject({ parentId: childId, toolUseId: z.string().min(1), name: z.string().min(1), input: z.string().optional(), resumes: childId.optional() }).optional(),
    }),
    z.strictObject({
      kind: z.literal('user'),
      ...seqFields,
      content: z.string(),
      context: z.array(contextItemSchema).optional(),
      attachments: z.array(attachmentSchema).optional(),
      command: z.strictObject({ name: z.string().min(1), args: z.string() }).optional(),
      steer: z.literal(true).optional(),
      from: z.enum(['parent', 'child', 'wake']).optional(),
      wake: z.array(wakeTriggerSchema).optional(),
    }),
    z.strictObject({
      kind: z.literal('assistant'),
      ...seqFields,
      content: z.array(contentBlock),
      stopReason: z.string().nullable().transform((reason) => reason as StopReason | null),
      usage: usageSchema,
      costUsd: z.number().nonnegative().nullable(),
      latencyMs: count,
      model: z.string().min(1),
      timing: modelMarksSchema.optional(),
      issuedBy: z.literal('user').optional(),
      promptParts: z.array(z.tuple([z.enum(INPUT_PARTS), count])).optional(),
      snapshot: z.string().min(1).optional(),
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
    z.strictObject({ kind: z.literal('cut'), ...seqFields, turnSeq: seqFields.seq }),
    z.strictObject({
      kind: z.literal('file-changed'),
      ...seqFields,
      path: z.string().min(1),
      shown: z.string().min(1),
      now: z.strictObject(diskStateFields).nullable(),
      excerpt: z.string().optional(),
    }),
    z.strictObject({
      kind: z.literal('compact'),
      ...seqFields,
      trigger: z.enum(COMPACT_TRIGGERS),
      keptFrom: seqFields.seq,
      summary: z.string().min(1),
      focus: z.string().min(1).optional(),
      kept: keptSchema,
      tokensBefore: count,
      tokensAfter: count,
      usage: usageSchema,
      costUsd: z.number().nonnegative().nullable(),
      model: z.string().min(1),
    }),
    z.strictObject({ kind: z.literal('review'), ...seqFields, hunk: hunkId, status: z.enum(HUNK_STATUSES) }),
    z.strictObject({ kind: z.literal('retry'), ...seqFields, attempt: z.number().int().positive(), delayMs: count, message: z.string() }),
    z.strictObject({ kind: z.literal('wait'), ...seqFields, wait: waitingSchema, by: waiterSchema.optional() }),
    z.strictObject({ kind: z.literal('wake'), ...seqFields, note: wakeNoteSchema }),
    z.strictObject({ kind: z.literal('mode'), seq: seqFields.seq.optional(), at: seqFields.at, mode: z.enum(SESSION_MODES) }),
    z.strictObject({
      kind: z.literal('notice'),
      ...seqFields,
      mode: z.enum(SESSION_MODES).optional(),
      memory: z.strictObject({ added: z.array(memoryEntrySchema), removed: z.array(memoryEntrySchema) }).optional(),
      mcp: z
        .strictObject({
          added: z.array(z.strictObject({ name: z.string().min(1), hint: z.string() })),
          removed: z.array(z.string().min(1)),
          instructions: z.array(z.strictObject({ server: z.string().min(1), text: z.string() })),
          unavailable: z
            .array(
              z.discriminatedUnion('why', [
                z.strictObject({ server: z.string().min(1), why: z.literal('failed'), reason: z.string() }),
                z.strictObject({ server: z.string().min(1), why: z.enum(['needs-sign-in', 'untrusted']) }),
              ]),
            )
            .optional(),
        })
        .optional(),
      todo: z.strictObject({ why: z.enum(['idle', 'stopped', 'earlier']), list: todoSchema }).optional(),
      budget: z.strictObject({ calls: count, maxCalls: z.number().int().positive(), costUsd: z.number(), maxCostUsd: z.number().positive(), perCallUsd: z.number().positive().optional() }).optional(),
      last: z.literal(true).optional(),
    }),
    z.discriminatedUnion('event', [
      z.strictObject({ kind: z.literal('hook-context'), ...seqFields, event: z.literal('SessionStart'), matched: z.enum(['startup', 'resume', 'compact']), notes: hookNotesSchema }),
      z.strictObject({ kind: z.literal('hook-context'), ...seqFields, event: z.literal('UserPromptSubmit'), notes: hookNotesSchema }),
      ...(['PreToolUse', 'PostToolUse', 'PostToolUseFailure'] as const).map((event) =>
        z.strictObject({ kind: z.literal('hook-context'), ...seqFields, event: z.literal(event), matched: z.string().min(1), toolUseId: z.string().min(1), notes: hookNotesSchema }),
      ),
      ...(['PostToolBatch', 'Stop', 'SubagentStart', 'SubagentStop'] as const).map((event) => z.strictObject({ kind: z.literal('hook-context'), ...seqFields, event: z.literal(event), notes: hookNotesSchema })),
    ]),
    z.strictObject({ kind: z.literal('report-nudge'), ...seqFields, empty: z.literal(true).optional() }),
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
      by: waiterSchema.optional(),
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
      kind: z.literal('background-end'),
      ...seqFields,
      job: z.strictObject({
        id: jobId,
        toolUseId: z.string(),
        command: z.string().min(1),
        preview: z.strictObject({ name: z.string(), url: z.string() }).optional(),
        state: endedJobStateSchema,
        outputFile: z.string().min(1).optional(),
      }),
      tail: z.string(),
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
    z.strictObject({ kind: z.literal('backend-start'), ...seqFields, agentSessionId: z.string().min(1), lane: z.string().min(1).nullable(), sandboxed: z.boolean(), loadable: z.boolean() }),
    z.strictObject({ kind: z.literal('backend-model'), seq: seqFields.seq.optional(), at: seqFields.at, model: z.string().min(1) }),
    z.strictObject({ kind: z.literal('spinoff'), seq: seqFields.seq.optional(), at: seqFields.at, id: spinoffId, decision: spinoffDecisionSchema }),
    z.strictObject({ kind: z.literal('chapter'), seq: seqFields.seq.optional(), at: seqFields.at, turnSeq: seqFields.seq, mark: chapterMarkSchema.nullable() }),
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
  /** The session as of its cuts (`cutView`), starting with the session-start header; the file keeps every event. */
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
  return { file, session: header.session, events: cutView(events), tornLine, goodBytes };
}

/** Logs a switch of the session's approval mode. Switching to the mode it already has logs nothing. */
export async function logMode(log: SessionLog, mode: SessionMode): Promise<SessionLog> {
  if (sessionModeOf(log.events) === mode) return log;
  const event: TurnEvent = { kind: 'mode', seq: nextSeq(log.events), at: new Date().toISOString(), mode };
  await appendEvent(log.file, event);
  return { ...log, events: [...log.events, event] };
}

/** A setting the user changes while a turn may run. */
export type SettingChange =
  | { readonly kind: 'mode'; readonly mode: SessionMode }
  | { readonly kind: 'effort'; readonly effort: Effort }
  | { readonly kind: 'backend-model'; readonly model: string }
  /** Not a setting, but logged the same way: the user decides about a suggestion whether or not a turn runs. */
  | { readonly kind: 'spinoff'; readonly id: SpinoffId; readonly decision: SpinoffDecision }
  /** Nor is the user's chapter at one of their messages, which they can mark while a turn runs. */
  | { readonly kind: 'chapter'; readonly turnSeq: number; readonly mark: ChapterMark | null };

/** Whether `change` would leave the session as it is. */
const UNCHANGED: { readonly [K in SettingChange['kind']]: (log: SessionLog, change: Extract<SettingChange, { kind: K }>) => boolean } = {
  mode: (log, { mode }) => sessionModeOf(log.events) === mode,
  effort: (log, { effort }) => sessionEffortOf(log.session, log.events) === effort,
  'backend-model': (log, { model }) => log.events.findLast((e) => e.kind === 'backend-model')?.model === model,
  spinoff: (log, { id }) => spinoffsOf(log.events).find((spinoff) => spinoff.id === id)?.state.kind !== 'offered',
  chapter: (log, { turnSeq, mark }) => {
    const now = userChapterAt(chaptersOf(log.events), turnSeq);
    return mark === null ? now === undefined : now?.title === mark.title && now.summary === mark.summary;
  },
};

const unchanged = (log: SessionLog, change: SettingChange): boolean => (UNCHANGED[change.kind] as (log: SessionLog, change: SettingChange) => boolean)(log, change);

/** Logs a setting change between turns. */
export async function logSettingChange(log: SessionLog, change: SettingChange): Promise<SessionLog> {
  if (unchanged(log, change)) return log;
  const event = { ...change, seq: nextSeq(log.events), at: new Date().toISOString() } as TurnEvent;
  await appendEvent(log.file, event);
  return { ...log, events: [...log.events, event] };
}

/**
 * Logs a setting change while a turn holds the log, so the change outlives a turn that never ends. It takes no seq,
 * which the turn owns, and it leaves a torn tail for the turn to cut: then it logs nothing and returns false.
 */
export async function logBesideTurn(log: SessionLog, change: SettingChange): Promise<boolean> {
  if (log.tornLine !== undefined) return false;
  if (!unchanged(log, change)) await appendEvent(log.file, { ...change, at: new Date().toISOString() } as TurnEvent);
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
