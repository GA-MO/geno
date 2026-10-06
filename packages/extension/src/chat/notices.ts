import type { Attention, NeedsYouReason, TaskNotice, TaskRecord } from '@g-code/core';

/** How a task's notice reaches the user. */

/** Where the user is when a task changes: whether the panel shows its session, and whether the window has the focus. */
export type Whereabouts = { readonly shown: boolean; readonly focused: boolean; readonly panelVisible: boolean };

/**
 * Which way a notice reaches the user. Nothing while they look at the session in a focused window, which already
 * shows it. VS Code's own notification while the window has the focus. The OS notification as well while it does
 * not, since VS Code's stays inside its window.
 */
export function channelsOf({ shown, focused, panelVisible }: Whereabouts): { readonly toast: boolean; readonly os: boolean } {
  if (focused && shown && panelVisible) return { toast: false, os: false };
  return { toast: true, os: !focused };
}

/** The notice's words: the verb from the trigger table, then the task, then where it ran. */
export const noticeText = (notice: TaskNotice, task: TaskRecord): string =>
  `Geno ${notice.verb}: ${task.title}${task.lane === null ? '' : ` (lane ${task.lane})`}`;

/**
 * The macOS notification, through `osascript`, the system's own tool. The text goes in as the script's arguments,
 * never as script source, so nothing in a task's title can run as AppleScript.
 */
export const osNotification = (title: string, text: string): readonly [string, readonly string[]] => [
  '/usr/bin/osascript',
  ['-e', 'on run argv', '-e', 'display notification (item 2 of argv) with title (item 1 of argv)', '-e', 'end run', title, text],
];

/** `os`: the notice may also go out as the macOS notification. */
export type AttentionNotice = TaskNotice & { readonly os: boolean };

/**
 * What a task's move into a section tells the user. Only Needs you reaches past the window, as the macOS
 * notification; a finish shows in VS Code alone.
 */
export const ATTENTION_NOTICES: { readonly [K in NeedsYouReason | 'ready']: AttentionNotice } = {
  permission: { kind: 'needs-input', severity: 'warning', verb: 'needs your permission', os: true },
  question: { kind: 'needs-input', severity: 'warning', verb: 'needs your answer', os: true },
  failed: { kind: 'failed', severity: 'error', verb: 'failed', os: true },
  limited: { kind: 'needs-input', severity: 'warning', verb: 'is held at a rate limit until you retry', os: true },
  ready: { kind: 'done', severity: 'info', verb: 'finished', os: false },
};

/** The notice for a task's attention going from `before` to `after`, if the move calls for one. */
export function attentionNotice(before: Attention | undefined, after: Attention): AttentionNotice | undefined {
  if (after.kind === 'needs-you') return before?.kind === 'needs-you' ? undefined : ATTENTION_NOTICES[after.reason];
  if (after.kind === 'ready') return before?.kind === 'working' ? ATTENTION_NOTICES.ready : undefined;
  return undefined;
}
