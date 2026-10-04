import { structuredPatch } from 'diff';

/**
 * One edit the user made, as whole lines: the changed lines plus up to CONTEXT_LINES unchanged lines on each side,
 * before and after. Whole lines let the entry render as a unified diff hunk, which is how Zeta reads history.
 */
export type EditHistoryEntry = {
  readonly path: string;
  /** When the last change folded into this entry happened. */
  readonly at: string;
  /** Zero-based line in the file where `oldText` and `newText` start. */
  readonly line: number;
  readonly oldText: string;
  readonly newText: string;
};

export type DocumentChange = {
  readonly path: string;
  readonly at: string;
  readonly before: string;
  readonly after: string;
};

export const CONTEXT_LINES = 3;
/** Zed's Zeta prompt never renders more than 6 edits. */
export const MAX_HISTORY = 6;

const linesOf = (text: string): string[] => {
  const lines = text.split('\n');
  if (text.endsWith('\n')) lines.pop();
  return lines;
};

const joinLines = (lines: readonly string[]): string => lines.map((l) => `${l}\n`).join('');

type LineChange = { readonly start: number; readonly oldEnd: number; readonly newEnd: number };

/** The changed line span: lines [start, oldEnd) of before became lines [start, newEnd) of after. */
function changedLines(before: readonly string[], after: readonly string[]): LineChange | undefined {
  let start = 0;
  while (start < before.length && start < after.length && before[start] === after[start]) start++;
  if (start === before.length && start === after.length) return undefined;
  let common = 0;
  while (
    common < before.length - start &&
    common < after.length - start &&
    before[before.length - 1 - common] === after[after.length - 1 - common]
  ) {
    common++;
  }
  return { start, oldEnd: before.length - common, newEnd: after.length - common };
}

export function editBetween(change: DocumentChange): EditHistoryEntry | undefined {
  const before = linesOf(change.before);
  const after = linesOf(change.after);
  const span = changedLines(before, after);
  if (span === undefined) return undefined;
  const from = Math.max(0, span.start - CONTEXT_LINES);
  const trailing = Math.min(CONTEXT_LINES, before.length - span.oldEnd);
  return {
    path: change.path,
    at: change.at,
    line: from,
    oldText: joinLines(before.slice(from, span.oldEnd + trailing)),
    newText: joinLines(after.slice(from, span.newEnd + trailing)),
  };
}

const lineCount = (text: string): number => linesOf(text).length;

/**
 * Adds a change to the history, newest last, keeping at most `limit` entries. A change inside the lines the newest
 * entry already covers, context included, folds into it, so typing a word is one edit rather than one per keystroke.
 */
export function recordChange(
  history: readonly EditHistoryEntry[],
  change: DocumentChange,
  limit: number = MAX_HISTORY,
): EditHistoryEntry[] {
  const before = linesOf(change.before);
  const after = linesOf(change.after);
  const span = changedLines(before, after);
  if (span === undefined) return [...history];
  const last = history.at(-1);
  const lastEnd = last && last.line + lineCount(last.newText);
  if (last?.path === change.path && span.start >= last.line && span.oldEnd <= lastEnd!) {
    const newText = joinLines(after.slice(last.line, lastEnd! + (after.length - before.length)));
    const rest = history.slice(0, -1);
    return newText === last.oldText ? rest : [...rest, { ...last, at: change.at, newText }];
  }
  const entry = editBetween(change)!;
  return [...history, entry].slice(-limit);
}

/** The entry as unified diff hunks, numbered by file line, without the file header. */
export function renderEdit(entry: EditHistoryEntry): string {
  const patch = structuredPatch('a', 'b', entry.oldText, entry.newText, '', '', { context: CONTEXT_LINES });
  return patch.hunks
    .map((hunk) => {
      const header = `@@ -${hunk.oldStart + entry.line},${hunk.oldLines} +${hunk.newStart + entry.line},${hunk.newLines} @@\n`;
      return header + hunk.lines.map((l) => `${l}\n`).join('');
    })
    .join('');
}
