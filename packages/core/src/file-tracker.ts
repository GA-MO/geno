/**
 * The files the model read or wrote with its tools, as it knows them, so the engine can tell it when one changes on
 * disk behind its back. The engine logs each note with its text's parts, so a replay or a resume sends the same bytes.
 */

import { diffLines } from 'diff';
import { GENO_NOTE, neutralizeNoticeLines } from './fence.js';
import { showHidden } from './hidden.js';
import type { TurnEvent } from './session.js';
import { fileLines, numberLines } from './str-replace.js';

/** A file's text as the model knows it, by hash, and the disk's size and change time when it learned it. */
export type DiskState = { readonly hash: string; readonly size: number; readonly mtimeMs: number };

/** The file a read showed or an edit wrote, by its absolute path. */
export type FileStamp = { readonly path: string } & DiskState;

/**
 * A tracked file changed on disk and the model is told at its next request. `now` is how the disk has it, or null when
 * the file is gone or too large to track any more. `shown` is the path as the model's tools show it. `excerpt` is the
 * changed lines of the new text, numbered, when the engine still had the text the model knew.
 */
export type FileChangedEvent = {
  readonly kind: 'file-changed';
  readonly seq: number;
  readonly at: string;
  readonly path: string;
  readonly shown: string;
  readonly now: DiskState | null;
  readonly excerpt?: string | undefined;
};

/** How many files, the most recently read or written, the engine looks at before each model call. */
export const MAX_TRACKED_FILES = 50;
/** A larger file is not hashed, so it is not tracked. */
export const MAX_TRACKED_BYTES = 4 * 1024 * 1024;

/** Lines of the new text shown on each side of a change. */
export const EXCERPT_CONTEXT_LINES = 3;
/** A longer excerpt is left out, and the note says to read the file instead. */
export const EXCERPT_MAX_LINES = 60;
export const EXCERPT_MAX_CHARS = 6000;

/**
 * Claude Code's note for a file that changed on disk since the model read it: with the changed lines when the engine
 * has them and they are short, and otherwise without.
 */
export const changedOnDiskNote = (shown: string, excerpt?: string): string =>
  `${GENO_NOTE} Note: ${shown} changed on disk since you last read it. That's usually deliberate, so take it as the current state rather than reverting it. If the change looks wrong, say so rather than undoing it yourself; otherwise there is no need to call it out. ${
    excerpt === undefined ? 'The changes are not shown here; read the file if you need its current content.' : `Here are the relevant changes (shown with line numbers):\n${excerpt}`
  }`;

/** The 1-based line ranges of `after` that changed from `before`, each widened by the context lines and merged. */
function changedRanges(before: string, after: string, total: number): { first: number; last: number }[] {
  const ranges: { first: number; last: number }[] = [];
  const add = (first: number, last: number) => {
    const wide = { first: Math.max(1, first - EXCERPT_CONTEXT_LINES), last: Math.min(total, last + EXCERPT_CONTEXT_LINES) };
    const previous = ranges.at(-1);
    if (previous !== undefined && wide.first <= previous.last + 1) previous.last = Math.max(previous.last, wide.last);
    else ranges.push(wide);
  };
  let line = 1;
  for (const part of diffLines(before, after)) {
    if (part.added) add(line, line + part.count - 1);
    else if (part.removed) add(line, line - 1);
    if (!part.removed) line += part.count;
  }
  return ranges.filter((range) => range.first <= range.last);
}

/**
 * The changed lines of `after`, numbered as the read tool numbers them, with a few lines around each change. None
 * when nothing of `after` is left to show, or when the excerpt would pass its limits. File text is data, so a line in
 * it cannot pose as Geno's.
 */
export function changedExcerpt(before: string, after: string): string | undefined {
  const lines = after === '' ? [] : fileLines(after);
  const ranges = changedRanges(before, after, lines.length);
  const blocks = ranges.map(({ first, last }) => numberLines(lines.slice(first - 1, last).map((line) => neutralizeNoticeLines(showHidden(line))), first));
  const excerpt = blocks.join('\n...\n');
  const count = ranges.reduce((sum, { first, last }) => sum + last - first + 1, 0) + ranges.length - 1;
  return blocks.length === 0 || count > EXCERPT_MAX_LINES || excerpt.length > EXCERPT_MAX_CHARS ? undefined : excerpt;
}

/**
 * Each tracked file and how the model knows it, oldest first: the newest read or edit of it, or the newest note about
 * it. A rewind drops them all, since its own note tells the model to read files again.
 */
export function trackedFiles(events: readonly TurnEvent[]): ReadonlyMap<string, DiskState> {
  const known = new Map<string, DiskState>();
  const track = (path: string, state: DiskState | null) => {
    known.delete(path);
    if (state !== null) known.set(path, state);
  };
  for (const event of events) {
    if (event.kind === 'tool-result' && event.file !== undefined) {
      const { path, ...state } = event.file;
      track(path, state);
    }
    if (event.kind === 'file-changed') track(event.path, event.now);
    if (event.kind === 'restored') known.clear();
  }
  return new Map([...known].slice(-MAX_TRACKED_FILES));
}
