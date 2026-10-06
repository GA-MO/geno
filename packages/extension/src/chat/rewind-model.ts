import type { RewindKind } from '@g-code/core';
import type { Transcript, Turn } from './messages.js';

/** "Rewind to here" and "Fork from here" on one of the user's messages: what the menu offers, and how a rewind goes. */

export type RewindFromView =
  /** `confirmed` is the user's yes to the files the confirm listed; a rewind of files without it asks for the list first. */
  | { readonly type: 'rewind'; readonly turn: string; readonly kind: RewindKind; readonly confirmed: boolean }
  | { readonly type: 'fork'; readonly turn: string };

/**
 * A rewind or fork on its way from one message. `confirm` lists the files a restore rewrites, and the ones edited since
 * the last checkpoint, whose edits it loses. `restored` stays under the message until the next one.
 */
export type RewindState =
  | { readonly kind: 'working'; readonly action: RewindKind | 'fork' }
  | { readonly kind: 'confirm'; readonly action: RewindKind; readonly files: readonly string[]; readonly unsaved: readonly string[] }
  | { readonly kind: 'restored'; readonly files: readonly string[] }
  | { readonly kind: 'failed'; readonly message: string };

export type RewindToView =
  /** `state` undefined clears the message's line. */
  | { readonly type: 'rewind-state'; readonly turn: string; readonly state: RewindState | undefined }
  /** The rewound prompt, back in the composer to edit and resend. */
  | { readonly type: 'rewind-prompt'; readonly text: string };

/** One item of the message's menu. */
export type RewindItem = { readonly action: RewindKind | 'fork'; readonly label: string; readonly detail: string };

const LABELS: { readonly [K in RewindKind]: string } = { files: 'Restore files', conversation: 'Restore conversation', both: 'Restore both' };

/** What a restore of files rewrites; the engine's REWINDS says the same of each kind. */
export const RESTORES_FILES: { readonly [K in RewindKind]: boolean } = { files: true, conversation: false, both: true };

export const REWIND_ITEMS: readonly RewindItem[] = [
  { action: 'files', label: LABELS.files, detail: 'Put the files back as they were before this message' },
  { action: 'conversation', label: LABELS.conversation, detail: 'Go back to before this message, and edit it' },
  { action: 'both', label: LABELS.both, detail: 'Files and conversation, as before this message' },
  { action: 'fork', label: 'Fork from here', detail: 'A new chat with the conversation up to this message' },
];

/**
 * Whether the message offers the menu: the engine named its prompt, no turn runs, and the session is Geno's own, since
 * an external agent keeps its own conversation.
 */
export const offersRewind = (turn: Turn, transcript: Transcript): boolean =>
  turn.seq !== undefined && turn.status !== 'streaming' && transcript.turns.at(-1)?.status !== 'streaming' && transcript.backend === undefined;

/** A path list as it reads in one line: the first few names, then how many more. */
export function fileList(files: readonly string[], shown = 3): string {
  if (files.length <= shown) return files.join(', ');
  return `${files.slice(0, shown).join(', ')} and ${files.length - shown} more`;
}

/** The confirm's words: what it rewrites, what it loses, and whether the keyboard starts on Cancel. */
export function confirmOf(state: Extract<RewindState, { kind: 'confirm' }>): { readonly title: string; readonly loses: string | undefined; readonly button: string; readonly safeFirst: boolean } {
  const { files, unsaved, action } = state;
  const title = files.length === 0 ? 'No files changed since this message.' : `Restore ${files.length === 1 ? '1 file' : `${files.length} files`} to before this message: ${fileList(files)}.`;
  const loses = unsaved.length === 0 ? undefined : `Edits to ${fileList(unsaved)} are in no checkpoint, and restoring loses them.`;
  return { title, loses, button: LABELS[action], safeFirst: unsaved.length > 0 };
}

export const restoredText = (files: readonly string[]): string =>
  files.length === 0 ? 'No files needed restoring.' : `Restored ${files.length === 1 ? '1 file' : `${files.length} files`}: ${fileList(files)}.`;
