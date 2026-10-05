/** g-code's additions to the Agent Client Protocol, shared by the engine and the extension. docs/e12.md maps every flow. */

import type { Invocation } from './commands.js';
import type { HunkStatus } from './hunks.js';
import type { HunkId, ReviewHunk } from './review.js';

/** Extension method, sent by the engine: the editor's diagnostics for some files. */
export const DIAGNOSTICS_METHOD = '_gcode/diagnostics';

/** Key in the client capabilities' `_meta`, true when the client answers DIAGNOSTICS_METHOD. */
export const DIAGNOSTICS_CAPABILITY = 'gcode/diagnostics';

/** Extension method, sent by the engine: the editor's buffers with unsaved edits, for grep and glob. */
export const UNSAVED_BUFFERS_METHOD = '_gcode/unsavedBuffers';

/** Key in the client capabilities' `_meta`, true when the client answers UNSAVED_BUFFERS_METHOD. */
export const UNSAVED_BUFFERS_CAPABILITY = 'gcode/unsavedBuffers';

export type UnsavedBuffersRequest = { readonly sessionId: string };
/** `path` is absolute, with symlinks resolved. */
export type UnsavedBuffersResponse = { readonly buffers: readonly { readonly path: string; readonly text: string }[] };

/** Key in fs/write_text_file's `_meta`: the hash of the text the write was computed from, null for a new file. */
export const BASE_HASH_META = 'gcode/baseHash';

/** Key in fs/write_text_file's `_meta`: the id of the tool call making the write, so the editor can show the edit on it. */
export const TOOL_CALL_META = 'gcode/toolCallId';

/** What a turn's model calls came to, in session/prompt's response `_meta` beside ACP's token `usage`. */
export const TURN_USAGE_META = 'gcode/usage';

/** `costUsd` is null when any call of the turn had no known price. */
export type TurnUsage = { readonly model: string; readonly costUsd: number | null };

/** Key in a bash call's closing tool_call_update `_meta`: the ApprovalRecord of a command a rule flagged, for the step to show. */
export const APPROVAL_META = 'gcode/approval';

/** session/request_permission's `toolCall.rawInput`: the command asked about and why it needs asking. */
export type PermissionInput = { readonly command: string; readonly reason: string };

/** The JSON-RPC error a client answers fs/write_text_file with when the file no longer holds that text. */
export const STALE_BASE_ERROR = { code: -32010, reason: 'stale-base' } as const;

export const SEVERITIES = ['error', 'warning', 'information', 'hint'] as const;
export type Severity = (typeof SEVERITIES)[number];

export type DiagnosticsRequest = { readonly sessionId: string; readonly paths: readonly string[] };

/** One problem the editor reports. `line` and `character` count from 1. */
export type EditorDiagnostic = {
  readonly path: string;
  readonly line: number;
  readonly character: number;
  readonly severity: Severity;
  readonly message: string;
  readonly source: string | null;
};

export type DiagnosticsResponse = { readonly diagnostics: readonly EditorDiagnostic[] };

/** Extension method, sent by the editor: records review decisions, then returns every hunk of the session with its status. */
export const REVIEW_METHOD = '_gcode/review';

export type ReviewDecision = { readonly hunk: HunkId; readonly status: HunkStatus };
export type ReviewRequest = { readonly sessionId: string; readonly decisions: readonly ReviewDecision[] };
export type ReviewResponse = { readonly hunks: readonly ReviewHunk[] };

/** Extension method, sent by the editor: a file's text at the session's first checkpoint, null when it did not exist then. */
export const CHECKPOINT_TEXT_METHOD = '_gcode/checkpointText';

export type CheckpointTextRequest = { readonly sessionId: string; readonly path: string };
export type CheckpointTextResponse = { readonly text: string | null };

/** Extension method, sent by the editor: restores the session's first checkpoint, as `gcode rewind` does, and returns the absolute paths it rewrote or deleted. */
export const REWIND_METHOD = '_gcode/rewind';

export type RewindRequest = { readonly sessionId: string };
export type RewindResponse = { readonly files: readonly string[] };

/** Key in session/prompt's `_meta`: run the prompt as a one-shot edit of a selection instead of an agent turn. */
export const INLINE_EDIT_META = 'gcode/inlineEdit';

/** `path` is absolute; lines count from 1 and include both ends. */
export type InlineEditTarget = { readonly path: string; readonly startLine: number; readonly endLine: number };

/**
 * Key in an embedded `resource` prompt block's `_meta`: `{ startLine, endLine }`, counted from 1 and inclusive, which
 * makes the block an `@selection` of those lines. A `resource_link`, or a `resource` without the key, is an `@file`.
 */
export const SELECTION_LINES_META = 'gcode/lines';

export type SelectionLines = { readonly startLine: number; readonly endLine: number };

/** Key in session/list's `SessionInfo._meta`: what the history shows besides ACP's title and time. */
export const SESSION_SUMMARY_META = 'gcode/summary';

export type SessionSummaryMeta = { readonly turns: number; readonly costUsd: number | null; readonly createdAt: string };

/** Extension method, sent by the editor: names a session. The engine logs the title and sends `session_info_update`. */
export const RENAME_SESSION_METHOD = '_gcode/renameSession';

export type RenameSessionRequest = { readonly sessionId: string; readonly title: string };

/**
 * Key in a replayed `user_message_chunk`'s `_meta` during session/load: how the turn it starts went, which ACP
 * has no update for. Times are milliseconds since the epoch.
 */
export const REPLAYED_TURN_META = 'gcode/turn';

export type ReplayedTurn = {
  /** The session's mode when the prompt was sent. */
  readonly mode: string;
  readonly startedAt: number;
  readonly endedAt: number;
  readonly status: 'done' | 'stopped' | 'failed';
  /** `inputTokens` counts cached tokens too; null for a turn that never reached the model. */
  readonly usage: { readonly model: string; readonly inputTokens: number; readonly outputTokens: number; readonly costUsd: number | null } | null;
  /** The slash command the user typed, whose expansion the replayed prompt text is. */
  readonly command?: Invocation;
};

/** Key in a replayed `tool_call` or `tool_call_update`'s `_meta`: when it happened, in milliseconds since the epoch. */
export const REPLAYED_AT_META = 'gcode/at';

/** Key in a replayed `tool_call_update`'s `_meta`: the edit the call made, its hunks in their current review status. */
export const REPLAYED_CHANGE_META = 'gcode/change';

/**
 * What the user pointed at from the composer, parsed from session/prompt's blocks. `path` is absolute. A file is
 * read through the buffer bridge when the prompt is logged; a selection carries the text the user saw.
 */
export type Mention =
  | { readonly kind: 'file'; readonly path: string }
  | ({ readonly kind: 'selection'; readonly path: string; readonly text: string } & SelectionLines);

export function formatDiagnostics(diagnostics: readonly EditorDiagnostic[], show: (path: string) => string): string {
  if (diagnostics.length === 0) return 'The editor reports no problems in the files you read or edited.';
  const lines = diagnostics.map(
    (d) => `${show(d.path)}:${d.line}:${d.character} ${d.severity}: ${d.message}${d.source === null ? '' : ` (${d.source})`}`,
  );
  return `The editor reports these problems in the files you read or edited:\n${lines.join('\n')}`;
}
