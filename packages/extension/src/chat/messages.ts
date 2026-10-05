import type { HunkStatus } from '@g-code/core';

/**
 * The chat transcript, the one model the panel renders. The extension owns it and sends every change as an
 * Action; the webview runs the same reducer (transcript.ts) and renders the result, so replaying or
 * resending the whole transcript can never leave the view out of step.
 */
export type Transcript = { readonly model: string; readonly turns: readonly Turn[] };

export type Turn = {
  readonly id: string;
  readonly prompt: string;
  readonly blocks: readonly Block[];
  readonly status: TurnStatus;
  /** Undefined until the turn ends, and for a turn that failed before the model answered. */
  readonly usage: Usage | undefined;
};

export type TurnStatus = 'streaming' | 'done' | 'stopped' | 'failed';

export type Usage = { readonly model: string; readonly inputTokens: number; readonly outputTokens: number; readonly costUsd: number | null };

/** What the assistant did in a turn, in the order it happened. */
export type Block = TextBlock | ToolBlock | PermissionBlock | ErrorBlock;

export type TextBlock = { readonly kind: 'text'; readonly id: string; readonly text: string };

/** The ACP tool kinds the engine sends; anything else shows as `other`. */
export const TOOL_KINDS = ['read', 'search', 'edit', 'execute', 'other'] as const;
export type ToolKind = (typeof TOOL_KINDS)[number];

/** `cancelled` is a tool still running when its turn ended. */
export type ToolStatus = 'running' | 'completed' | 'failed' | 'cancelled';

/** One tool call. An edit that reached the editor carries its diff, and renders as an edit card. */
export type ToolBlock = {
  readonly kind: 'tool';
  readonly id: string;
  /** The tool's name, such as `read` or `bash`. */
  readonly name: string;
  /** What it acts on: a path, a pattern or a command. */
  readonly target: string;
  readonly toolKind: ToolKind;
  readonly status: ToolStatus;
  /** Milliseconds since the epoch, stamped by the extension as the updates arrive. */
  readonly startedAt: number;
  readonly endedAt: number | undefined;
  readonly output: string | undefined;
  readonly diff: FileDiff | undefined;
};

/** A file an edit changed, as hunks the review controller tracks by the same ids. */
export type FileDiff = { readonly path: string; readonly hunks: readonly DiffHunk[] };

export type DiffHunk = {
  readonly id: string;
  /** 1-based line of the new text in the file right after the edit. */
  readonly line: number;
  readonly removed: readonly string[];
  readonly added: readonly string[];
  readonly status: HunkStatus;
};

export type PermissionChoice = { readonly optionId: string; readonly name: string; readonly kind: string };

export type PermissionOutcome = { readonly kind: 'open' } | { readonly kind: 'chosen'; readonly optionId: string } | { readonly kind: 'cancelled' };

/** The engine asking before it runs a command its rules hold back. */
export type PermissionBlock = {
  readonly kind: 'permission';
  readonly id: string;
  readonly command: string;
  readonly reason: string;
  readonly options: readonly PermissionChoice[];
  readonly outcome: PermissionOutcome;
};

export type ErrorBlock = { readonly kind: 'error'; readonly id: string; readonly message: string };

/**
 * A change to the transcript. Everything but `reset`, `model` and `review` applies to the last turn, the only
 * one that can still change. `at` is when the extension saw the update, so a replay keeps the durations.
 */
export type Action =
  | { readonly type: 'reset'; readonly transcript: Transcript }
  | { readonly type: 'model'; readonly model: string }
  | { readonly type: 'turn-start'; readonly id: string; readonly prompt: string }
  | { readonly type: 'text'; readonly text: string }
  /** Starts a tool call or updates one; an absent field keeps its value. */
  | {
      readonly type: 'tool';
      readonly id: string;
      readonly at: number;
      readonly name?: string;
      readonly target?: string;
      readonly toolKind?: ToolKind;
      readonly status?: ToolStatus;
      readonly output?: string;
    }
  | { readonly type: 'diff'; readonly toolId: string; readonly at: number; readonly diff: FileDiff }
  /** The review status of hunks, whichever surface decided them; hunks the transcript lacks are ignored. */
  | { readonly type: 'review'; readonly hunks: Readonly<Record<string, HunkStatus>> }
  | { readonly type: 'permission'; readonly id: string; readonly command: string; readonly reason: string; readonly options: readonly PermissionChoice[] }
  | { readonly type: 'permission-done'; readonly id: string; readonly optionId: string | undefined }
  | { readonly type: 'error'; readonly message: string }
  | { readonly type: 'turn-end'; readonly status: Exclude<TurnStatus, 'streaming'>; readonly usage: Usage | undefined };

/** What the extension tells the chat webview. */
export type ToView = Action;

/** What the webview asks of the extension. */
export type FromView =
  | { readonly type: 'ready' }
  | { readonly type: 'send'; readonly text: string }
  | { readonly type: 'stop' }
  | { readonly type: 'permission'; readonly id: string; readonly optionId: string }
  | { readonly type: 'keep'; readonly hunk: string }
  | { readonly type: 'undo'; readonly hunk: string }
  /** Opens the file a hunk is in, at the hunk. */
  | { readonly type: 'reveal'; readonly hunk: string }
  | { readonly type: 'copy'; readonly text: string };
