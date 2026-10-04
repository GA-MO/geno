import { diffLines } from 'diff';
import { recordChange, MAX_HISTORY, type EditHistoryEntry } from './history.js';
import { applyEdit, type NextEdit, type PredictedEdit } from './zeta.js';

/**
 * A point in an edit session where the next edit is known. Without recorded sessions, these come from git history:
 * the first k hunks of a commit's change to one file were made, in file order, and hunk k+1 is the next edit.
 */
export type EditMoment = {
  readonly id: string;
  readonly path: string;
  readonly history: readonly EditHistoryEntry[];
  readonly document: string;
  /** At the end of the last edited line, where the cursor sits after typing it. */
  readonly cursor: number;
  readonly target: PredictedEdit;
};

export type ChangedFile = { readonly id: string; readonly path: string; readonly before: string; readonly after: string };

type Hunk = { readonly start: number; readonly end: number; readonly text: string };

function hunksOf(before: string, after: string): Hunk[] {
  const hunks: Hunk[] = [];
  let offset = 0;
  let open: { start: number; end: number; text: string } | undefined;
  for (const part of diffLines(before, after)) {
    if (!part.added && !part.removed) {
      if (open) hunks.push(open);
      open = undefined;
      offset += part.value.length;
      continue;
    }
    open ??= { start: offset, end: offset, text: '' };
    if (part.removed) {
      offset += part.value.length;
      open.end = offset;
    } else {
      open.text += part.value;
    }
  }
  if (open) hunks.push(open);
  return hunks;
}

const MINUTE_MS = 60_000;

/** Where typing the hunk leaves the cursor: after its last inserted character, before a trailing newline. */
const cursorAfter = (start: number, text: string): number => start + (text.endsWith('\n') ? text.length - 1 : text.length);

/** One moment per hunk after the first, its history the hunks before it, newest `historyLimit` kept. */
export function editMoments(file: ChangedFile, historyLimit: number = MAX_HISTORY): EditMoment[] {
  const moments: EditMoment[] = [];
  let document = file.before;
  let shift = 0;
  let cursor = 0;
  let history: EditHistoryEntry[] = [];
  for (const [k, hunk] of hunksOf(file.before, file.after).entries()) {
    const edit: PredictedEdit = { start: hunk.start + shift, end: hunk.end + shift, text: hunk.text };
    if (k > 0) moments.push({ id: `${file.id}#${k}`, path: file.path, history, document, cursor, target: edit });
    const after = applyEdit(document, edit);
    const at = new Date(k * MINUTE_MS).toISOString();
    history = recordChange(history, { path: file.path, at, before: document, after }, historyLimit);
    cursor = cursorAfter(edit.start, edit.text);
    document = after;
    shift += hunk.text.length - (hunk.end - hunk.start);
  }
  return moments;
}

export const GRADES = ['exact', 'region', 'wrong-location', 'none'] as const;
export type Grade = (typeof GRADES)[number];

const touches = (a: PredictedEdit, b: PredictedEdit): boolean => a.start <= b.end && b.start <= a.end;

/**
 * Exact when the prediction leaves the file as the target hunk does; region when it changes the target's lines
 * but differently; wrong-location when it changes something else.
 */
export function gradePrediction(moment: EditMoment, prediction: NextEdit): Grade {
  if (prediction.kind === 'none') return 'none';
  if (applyEdit(moment.document, prediction) === applyEdit(moment.document, moment.target)) return 'exact';
  return touches(prediction, moment.target) ? 'region' : 'wrong-location';
}
