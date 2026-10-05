import { createHash } from 'node:crypto';
import { hunksBetween, type Hunk, type HunkStatus } from './hunks.js';
import type { TurnEvent } from './session.js';
import type { Brand } from './types.js';

export type HunkId = Brand<string, 'HunkId'>;

/**
 * An edit as it landed in one file. Hunk lines count in the text before the edit. The id hashes that text and
 * the text after it, so the engine, which logs the change, and the editor, which applies it, name its hunks
 * alike without asking each other.
 */
export type FileChange = { readonly id: string; readonly path: string; readonly hunks: readonly Hunk[] };

export const changeOf = (path: string, before: string, after: string): FileChange => ({
  id: createHash('sha256').update(before).update('\0').update(after).digest('hex').slice(0, 16),
  path,
  hunks: hunksBetween(before, after),
});

export const hunkIdOf = (change: FileChange, index: number): HunkId => `${change.id}:${index}` as HunkId;

const lineCountOf = (text: string): number => text.split('\n').length - (text === '' || text.endsWith('\n') ? 1 : 0);

/** 1-based line of each hunk's new text in the text right after its change. */
export function afterLines(change: FileChange): number[] {
  let delta = 0;
  return change.hunks.map((hunk) => {
    const line = hunk.startLine + delta;
    delta += lineCountOf(hunk.newText) - hunk.lineCount;
    return line;
  });
}

function lineOffset(text: string, line: number): number {
  let offset = 0;
  for (let i = 1; i < line; i++) {
    const next = text.indexOf('\n', offset);
    if (next === -1) return text.length;
    offset = next + 1;
  }
  return offset;
}

/** A hunk's new text as a character range of a document: [start, end). Zero length for a pure deletion. */
export type Span = { readonly start: number; readonly end: number };

/** Where each hunk's new text sits in `after`, the text the change produced. */
export const spansIn = (after: string, change: FileChange): Span[] =>
  afterLines(change).map((line, i) => {
    const start = lineOffset(after, line);
    return { start, end: start + change.hunks[i]!.newText.length };
  });

/** One edit to a document, in the terms VS Code reports it: replace [offset, offset + length) with `text`. */
export type TextChange = { readonly offset: number; readonly length: number; readonly text: string };

/**
 * Moves a span through an edit to the document. Edits before it shift it, edits after it leave it, and an
 * edit that overlaps it widens it to cover the new text, so a hunk keeps its place as the user types around it.
 */
export function shiftSpan(span: Span, change: TextChange): Span {
  const { start, end } = span;
  const changeEnd = change.offset + change.length;
  const delta = change.text.length - change.length;
  const before = changeEnd < start || (changeEnd === start && (change.offset < start || change.length === 0));
  if (before) return { start: start + delta, end: end + delta };
  if (change.offset >= end) return span;
  return { start: Math.min(start, change.offset), end: Math.max(end + delta, change.offset + change.text.length) };
}

/**
 * Finds a hunk's new text in `text` nearest to the line it was written at, for restoring review after a
 * reload, when no span survived. Undefined when the text is gone.
 */
export function locateSpan(text: string, newText: string, line: number): Span | undefined {
  const expected = lineOffset(text, line);
  if (newText === '') return expected <= text.length ? { start: expected, end: expected } : undefined;
  let best: number | undefined;
  for (let at = text.indexOf(newText); at !== -1; at = text.indexOf(newText, at + 1)) {
    const lineStart = at === 0 || text[at - 1] === '\n';
    if (lineStart && (best === undefined || Math.abs(at - expected) < Math.abs(best - expected))) best = at;
  }
  return best === undefined ? undefined : { start: best, end: best + newText.length };
}

/** A hunk under review: where it came from and what the user decided. */
export type ReviewHunk = Hunk & {
  readonly id: HunkId;
  readonly path: string;
  /** 1-based line of its new text right after its change was applied. */
  readonly afterLine: number;
};

type Logged = { readonly seq: number; readonly hunks: ReviewHunk[] };

/**
 * The review state a session log describes: every hunk its edits made, with the status the user last gave
 * it. A rewind undoes every hunk logged after the checkpoint it restored.
 */
export function reviewState(events: readonly TurnEvent[]): ReviewHunk[] {
  const changes: Logged[] = [];
  const status = new Map<HunkId, HunkStatus>();
  const checkpointSeq = new Map<number, number>();
  for (const event of events) {
    if (event.kind === 'checkpoint') checkpointSeq.set(event.turnSeq, event.seq);
    if (event.kind === 'tool-result' && event.change !== undefined) {
      const change = event.change;
      const lines = afterLines(change);
      changes.push({
        seq: event.seq,
        hunks: change.hunks.map((hunk, i) => ({ ...hunk, id: hunkIdOf(change, i), path: change.path, afterLine: lines[i]! })),
      });
    }
    if (event.kind === 'review') status.set(event.hunk, event.status);
    if (event.kind === 'restored') {
      const from = checkpointSeq.get(event.turnSeq) ?? 0;
      for (const logged of changes) if (logged.seq > from) for (const hunk of logged.hunks) status.set(hunk.id, 'undone');
    }
  }
  return changes.flatMap((logged) => logged.hunks.map((hunk) => ({ ...hunk, status: status.get(hunk.id) ?? hunk.status })));
}
