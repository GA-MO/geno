import { fileURLToPath } from 'node:url';
import type * as acp from '@agentclientprotocol/sdk';
import { z } from 'zod';
import {
  afterLines,
  APPROVAL_META,
  BACKGROUND_META,
  CHAPTER_META,
  HUNK_STATUSES,
  hunkIdOf,
  MEMORY_SCOPES,
  parseChapterMark,
  parseShownFiles,
  parseSpinoffShown,
  PROGRESS_META,
  REMEMBER_META,
  REPLAYED_AT_META,
  REPLAYED_CHANGE_META,
  REPLAYED_TURN_META,
  SHOW_FILES_META,
  SPINOFF_META,
  WAIT_KINDS,
  WAITING_META,
  WAKE_META,
  WORKFLOW_META,
  type ChapterMark,
  type FileChange,
} from '@g-code/core';
import { isImageMediaType } from '@g-code/core/attachments';
import { agentChunkAction } from './compact-host.js';
import { editorActionOf } from './editor-action-wire.js';
import { TOOL_KINDS, type Action, type Denial, type FileDiff, type ToolImage, type ToolKind, type ToolStatus } from './messages.js';
import type { SentCommand } from './slash.js';
import { steerActionOf } from './steer-host.js';
import { todoOfUpdate } from './todo-model.js';
import { widgetOf } from './widget-model.js';
import { workflowPreviewWire } from './workflow-wire.js';

// How the panel turns the engine's ACP traffic into transcript actions, with no VS Code in it, so a script can turn a
// logged session into the panel's messages with the same code (scripts/run-to-gallery.ts).

// A subject this panel does not know reads as a command, so a newer engine's card still shows.
const approvalSubject = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('read'), path: z.string() }),
  z.object({ kind: z.literal('fetch'), url: z.string(), host: z.string() }),
  z.object({ kind: z.literal('browse'), url: z.string(), host: z.string() }),
  z.object({ kind: z.literal('mcp'), server: z.string(), tool: z.string() }),
]);
export const permissionInput = z.object({ command: z.string(), line: z.string().optional(), reason: z.string(), description: z.string().optional(), rule: z.string().optional(), subject: approvalSubject.optional().catch(undefined) });

const bashInput = z.object({ description: z.string() });

/** A bash call's description, from the model's own input; display only. */
const descriptionOf = (name: string, rawInput: unknown): { readonly description?: string } => {
  const input = name === 'bash' ? bashInput.safeParse(rawInput) : undefined;
  return input?.success === true ? { description: input.data.description } : {};
};
export const rememberInput = z.object({ text: z.string(), scope: z.enum(MEMORY_SCOPES) });
export const replayedTurn = z.object({
  seq: z.number().int().optional(),
  mode: z.string().optional(),
  startedAt: z.number(),
  endedAt: z.number(),
  status: z.enum(['done', 'stopped', 'failed']),
  usage: z.object({ model: z.string(), inputTokens: z.number(), outputTokens: z.number(), costUsd: z.number().nullable() }).nullable(),
  command: z.object({ name: z.string(), args: z.string() }).optional(),
});
const replayedChange = z.object({
  id: z.string(),
  path: z.string(),
  hunks: z.array(z.object({ startLine: z.number(), lineCount: z.number(), oldText: z.string(), newText: z.string(), status: z.enum(HUNK_STATUSES) })),
});

export const waitingSchema = z.object({ kind: z.enum(WAIT_KINDS), since: z.number(), retryAt: z.number().nullable(), resetAt: z.number().nullable(), message: z.string() });
const writingSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('thinking') }),
  z.object({ kind: z.literal('text') }),
  z.object({ kind: z.literal('tool'), name: z.string(), target: z.string().optional() }),
]);
const progressSchema = z.object({ requestAt: z.number(), lastByteAt: z.number().nullable(), limitMs: z.number().nullable(), writing: writingSchema.nullable(), tokens: z.number() });

const killCause = z.enum(['session-deleted', 'lane-discarded', 'engine-exit']);
const stopBy = z.enum(['model', 'user']);
const jobState = z.discriminatedUnion('status', [
  z.object({ status: z.literal('running'), ending: z.discriminatedUnion('kind', [z.object({ kind: z.literal('stop'), by: stopBy }), z.object({ kind: z.literal('kill'), cause: killCause })]).optional() }),
  z.object({ status: z.literal('exited'), exitCode: z.number().nullable(), signal: z.string().nullable() }),
  z.object({ status: z.literal('stopped'), by: stopBy }),
  z.object({ status: z.literal('killed'), cause: killCause }),
]);
export const previewTag = z.object({ name: z.string(), url: z.string() });
const backgroundView = z.object({ id: z.string(), toolUseId: z.string(), command: z.string(), state: jobState, tail: z.string(), preview: previewTag.optional() });

export const wakeMark = z.object({ seq: z.number(), label: z.string() });

const approvalRecord = z.object({
  mode: z.string(),
  rule: z.string(),
  reason: z.string(),
  decidedBy: z.enum(['rule', 'classifier', 'user', 'hook']),
  verdict: z.enum(['allow', 'deny']),
  classifier: z.object({ reason: z.string() }).optional(),
  comment: z.string().optional(),
  message: z.string().optional(),
});
type ApprovalRecord = z.infer<typeof approvalRecord>;

const recordOf = (meta: Record<string, unknown> | null | undefined): ApprovalRecord | undefined => {
  const record = approvalRecord.safeParse(meta?.[APPROVAL_META]);
  return record.success ? record.data : undefined;
};

/** A command Auto let run without asking, with the classifier's reason; one it refused is a denial. */
function autoOf(record: ApprovalRecord | undefined): Extract<Action, { type: 'tool' }>['auto'] {
  if (record?.decidedBy !== 'classifier' || record.classifier === undefined || record.verdict !== 'allow') return undefined;
  return { reason: record.classifier.reason };
}

const sentence = (text: string): string => {
  const trimmed = text.trim().replace(/\.$/, '');
  return `${trimmed.charAt(0).toUpperCase()}${trimmed.slice(1)}.`;
};

/** The pattern of the user's own rule a workspace refusal names, and the file they keep it in. */
const USER_RULE = /`([^`]+)`, which the user set in (.+)$/;

/** Who refused a call and why, in the user's words: the record's reason and the call's output speak to the model. */
export function denialOf(record: ApprovalRecord): Denial | undefined {
  if (record.verdict !== 'deny') return undefined;
  if (record.decidedBy === 'user') return { by: 'you', reason: record.comment === undefined ? 'It did not run, and Geno waits for you.' : `It did not run. You told Geno: ${record.comment}` };
  if (record.decidedBy === 'classifier') return { by: 'auto', reason: record.classifier === undefined ? 'Auto would not run it.' : sentence(record.classifier.reason) };
  if (record.decidedBy === 'hook' || record.rule === 'hook-deny') return { by: 'hook', reason: sentence(record.message ?? record.reason) };
  const own = record.rule === 'workspace-deny' ? USER_RULE.exec(record.reason) : null;
  if (own !== null) return { by: 'rule', rule: own[1]!, reason: `Your rule in ${own[2]} blocks it.` };
  if (record.mode === 'non-interactive') return { by: 'rule', reason: `${sentence(record.reason).slice(0, -1)} needs your approval, and nobody could answer.` };
  return { by: 'rule', reason: `${sentence(record.reason).slice(0, -1)} is not allowed here.` };
}

/** The classifier's reason in a permission question it would not answer itself, as the engine words it. */
export const classifierReasonOf = (title: string | null | undefined): string | undefined => /The classifier says: (.+)\.$/.exec(title ?? '')?.[1];

const TOOL_STATUSES: Readonly<Record<acp.ToolCallStatus, ToolStatus>> = { pending: 'running', in_progress: 'running', completed: 'completed', failed: 'failed' };

const kindOf = (kind: acp.ToolKind | null | undefined): ToolKind => ((TOOL_KINDS as readonly string[]).includes(kind ?? '') ? (kind as ToolKind) : 'other');

/** The engine titles a call as the CLI shows it, `<tool> <target>`, as in `edit math.ts`. */
function callOf(title: string): { readonly name: string; readonly target: string } {
  const space = title.indexOf(' ');
  return space === -1 ? { name: title, target: '' } : { name: title.slice(0, space), target: title.slice(space + 1) };
}

function outputOf(content: readonly acp.ToolCallContent[] | null | undefined): string | undefined {
  const texts = (content ?? []).flatMap((c) => (c.type === 'content' && c.content.type === 'text' ? [c.content.text] : []));
  return texts.length === 0 ? undefined : texts.join('\n');
}

type UpdateOf<K extends acp.SessionUpdate['sessionUpdate']> = Extract<acp.SessionUpdate, { sessionUpdate: K }>;

const UPDATES: { readonly [K in acp.SessionUpdate['sessionUpdate']]?: (update: UpdateOf<K>, at: number) => Action | undefined } = {
  user_message_chunk: (update) => steerActionOf(update),
  agent_message_chunk: (update) => agentChunkAction(update),
  notice: ({ title, _meta }, at) => {
    if (_meta != null && PROGRESS_META in _meta) {
      const progress = progressSchema.safeParse(_meta[PROGRESS_META]);
      return progress.success ? { type: 'progress', progress: progress.data } : undefined;
    }
    if (_meta == null || !(WAITING_META in _meta)) return { type: 'notice', text: title };
    const waiting = waitingSchema.nullable().safeParse(_meta[WAITING_META]);
    return waiting.success ? { type: 'waiting', at, waiting: waiting.data } : undefined;
  },
  tool_call: ({ toolCallId, title, kind, status, rawInput }, at) => {
    const call = callOf(title);
    return { type: 'tool', id: toolCallId, at, ...call, ...descriptionOf(call.name, rawInput), toolKind: kindOf(kind), status: TOOL_STATUSES[status ?? 'pending'] };
  },
  tool_call_update: ({ toolCallId, title, status, content, _meta }, at) => {
    const output = outputOf(content);
    const images = imagesOf(content);
    const record = recordOf(_meta);
    const auto = autoOf(record);
    const denial = record === undefined ? undefined : denialOf(record);
    return {
      type: 'tool',
      id: toolCallId,
      at,
      ...(title == null ? {} : callOf(title)),
      ...(denial !== undefined ? { status: 'denied' as const, denial } : status == null ? {} : { status: TOOL_STATUSES[status] }),
      ...(output === undefined ? {} : { output }),
      ...(images.length === 0 ? {} : { images }),
      ...(auto === undefined ? {} : { auto }),
    };
  },
};

export function actionOf<K extends acp.SessionUpdate['sessionUpdate']>(update: UpdateOf<K>, at: number): Action | undefined {
  const action = (UPDATES[update.sessionUpdate] as ((u: UpdateOf<K>, at: number) => Action | undefined) | undefined)?.(update, at);
  if (action?.type !== 'tool') return action;
  const widget = widgetOf(update);
  const editorAction = update.sessionUpdate === 'tool_call_update' ? editorActionOf(update._meta) : undefined;
  const todo = todoOfUpdate(update);
  const spinoff = update.sessionUpdate === 'tool_call_update' ? parseSpinoffShown(update._meta?.[SPINOFF_META]) : undefined;
  const chapter = update.sessionUpdate === 'tool_call_update' ? chapterOf(update._meta) : undefined;
  const shown = update.sessionUpdate === 'tool_call_update' ? parseShownFiles(update._meta?.[SHOW_FILES_META]) : undefined;
  return {
    ...action,
    ...(widget === undefined ? {} : { widget }),
    ...(editorAction === undefined ? {} : { editorAction }),
    ...(todo === undefined ? {} : { todo }),
    ...(spinoff === undefined ? {} : { spinoff }),
    ...(chapter === undefined ? {} : { chapter }),
    ...(shown === undefined ? {} : { shown }),
  };
}

/** The chapter an update's `_meta` carries, checked, since it crossed the process boundary. */
export function chapterOf(meta: Record<string, unknown> | null | undefined): ChapterMark | undefined {
  const parsed = meta?.[CHAPTER_META] === undefined ? undefined : parseChapterMark(meta[CHAPTER_META]);
  return parsed?.ok === true ? parsed.value : undefined;
}

/** When an update happened: now, or for a replayed tool call, when it was logged. */
export const timeOf = (update: acp.SessionUpdate): number => {
  const at = update._meta?.[REPLAYED_AT_META];
  return typeof at === 'number' ? at : Date.now();
};

const linesOf = (text: string): string[] => (text === '' ? [] : text.replace(/\n$/, '').split('\n'));

/** An edit as the review shows it, at `path`, the file's path as the workspace names it. */
export function diffOf(path: string, change: FileChange): FileDiff {
  const lines = afterLines(change);
  return {
    path,
    change: change.id,
    hunks: change.hunks.map((hunk, i) => ({ id: hunkIdOf(change, i), line: lines[i]!, removed: linesOf(hunk.oldText), added: linesOf(hunk.newText), status: hunk.status })),
  };
}

/** A replayed turn's end, which ACP has no update for: the engine sends it with the prompt that starts the turn. */
export function replayedEnd(update: acp.SessionUpdate): Action | undefined {
  const turn = replayedTurn.safeParse(update._meta?.[REPLAYED_TURN_META]);
  if (!turn.success) return undefined;
  const { endedAt, status, usage } = turn.data;
  return { type: 'turn-end', at: endedAt, status, usage: usage ?? undefined };
}

/** The image files a tool call's content links to, as the engine sends a read of an image. */
export function imagesOf(content: readonly acp.ToolCallContent[] | null | undefined): ToolImage[] {
  return (content ?? []).flatMap((c) =>
    c.type === 'content' && c.content.type === 'resource_link' && c.content.uri.startsWith('file:') && isImageMediaType(c.content.mimeType ?? '')
      ? [{ path: fileURLToPath(c.content.uri), name: c.content.name }]
      : [],
  );
}

type UserChunk = UpdateOf<'user_message_chunk'>;

/** The turn a replayed prompt starts, as a session load shows it; `id` is the panel's id for the turn. */
export function replayedTurnStart(update: UserChunk, text: string, id: string, sentCommand: (command: { readonly name: string; readonly args: string } | undefined) => SentCommand | undefined): Action {
  const woke = wakeMark.safeParse(update._meta?.[WAKE_META]);
  const start = replayedTurn.safeParse(update._meta?.[REPLAYED_TURN_META]);
  return {
    type: 'turn-start',
    id,
    at: start.success ? start.data.startedAt : Date.now(),
    prompt: text,
    mode: start.success ? start.data.mode : undefined,
    command: start.success ? sentCommand(start.data.command) : undefined,
    // A woken turn has no message of the user's to rewind to.
    seq: start.success && !woke.success ? start.data.seq : undefined,
    wake: woke.success ? woke.data.label : undefined,
    chapter: chapterOf(update._meta),
  };
}

/**
 * What any other update of the shown session does to the transcript: a background job's row, or the update's own
 * action and, for a replayed edit, its diff. `relative` names a file as the workspace does.
 */
export function updateActions(update: acp.SessionUpdate, relative: (file: string) => string): Action[] {
  const job = update.sessionUpdate === 'tool_call_update' ? backgroundView.safeParse(update._meta?.[BACKGROUND_META]) : undefined;
  if (job?.success === true) {
    const { id, state, tail, command, preview } = job.data;
    return [{ type: 'background', toolId: job.data.toolUseId, job: { id, state, tail, command, ...(preview === undefined ? {} : { preview }) } }];
  }
  const at = timeOf(update);
  const action = actionOf(update, at);
  const change = replayedChange.safeParse(update._meta?.[REPLAYED_CHANGE_META]);
  const diff: Action | undefined =
    update.sessionUpdate === 'tool_call_update' && change.success ? { type: 'diff', toolId: update.toolCallId, at, diff: diffOf(relative(change.data.path), change.data) } : undefined;
  return [action, diff].filter((a): a is Action => a !== undefined);
}

/** The card a permission request shows, as card `id`. */
export function permissionAction({ toolCall, options }: Pick<acp.RequestPermissionRequest, 'toolCall' | 'options'>, id: string): Extract<Action, { type: 'permission' }> {
  const input = permissionInput.safeParse(toolCall.rawInput);
  const { command, line, reason, description, rule, subject } = input.success ? input.data : { command: toolCall.title ?? 'a command', line: undefined, reason: '', description: undefined, rule: undefined, subject: undefined };
  const memory = rememberInput.safeParse(toolCall._meta?.[REMEMBER_META]);
  const workflow = workflowPreviewWire.safeParse(toolCall._meta?.[WORKFLOW_META]);
  return {
    type: 'permission',
    id,
    command: memory.success ? memory.data.text : command,
    ...(line === undefined ? {} : { line }),
    reason,
    ...(description === undefined ? {} : { description }),
    options: options.map(({ optionId, name, kind }) => ({ optionId, name, kind })),
    classifier: classifierReasonOf(toolCall.title),
    ...(memory.success ? { ask: { kind: 'memory', ...memory.data } } : workflow.success ? { ask: { kind: 'workflow', preview: workflow.data } } : {}),
    toolId: toolCall.toolCallId,
    ...(toolCall.kind === 'edit' ? { toolKind: 'edit' as const } : {}),
    ...(rule === undefined ? {} : { rule }),
    ...(subject === undefined ? {} : { subject }),
  };
}
