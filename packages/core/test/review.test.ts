import { describe, expect, it } from 'vitest';
import {
  asSessionId,
  changeOf,
  locateSpan,
  reviewState,
  shiftSpan,
  spansIn,
  type HunkId,
  type Span,
  type TextChange,
  type TurnEvent,
} from '../src/index.js';

const BEFORE = 'a\nb\nc\nd\ne\n';
const AFTER = 'a\nB\nB2\nc\ne\n';

describe('changeOf', () => {
  it('names a change by its texts, so two sides that saw the same edit agree on its hunk ids', () => {
    expect(changeOf('/w/x.ts', BEFORE, AFTER).id).toBe(changeOf('/w/x.ts', BEFORE, AFTER).id);
    expect(changeOf('/w/x.ts', BEFORE, AFTER).id).not.toBe(changeOf('/w/x.ts', BEFORE, 'a\n').id);
  });

  it('places each hunk on the new text in the text after the change', () => {
    const change = changeOf('/w/x.ts', BEFORE, AFTER);
    expect(change.hunks.map((h) => [h.startLine, h.lineCount, h.oldText, h.newText])).toEqual([
      [2, 1, 'b\n', 'B\nB2\n'],
      [4, 1, 'd\n', ''],
    ]);
    const spans = spansIn(AFTER, change);
    expect(spans.map((s) => AFTER.slice(s.start, s.end))).toEqual(['B\nB2\n', '']);
    // The deletion of d sits where d was: before e, one line further down than in the base.
    expect(AFTER.slice(spans[1]!.start)).toBe('e\n');
  });
});

describe('shiftSpan', () => {
  const span: Span = { start: 10, end: 20 };
  const at = (offset: number, length: number, text: string): TextChange => ({ offset, length, text });

  it.each([
    ['an insertion on an earlier line shifts it', at(2, 0, 'xyz\n'), { start: 14, end: 24 }],
    ['an insertion right at its start shifts it', at(10, 0, 'x'), { start: 11, end: 21 }],
    ['a deletion that ends at its start shifts it', at(5, 5, ''), { start: 5, end: 15 }],
    ['an edit after it leaves it', at(20, 3, 'q'), { start: 10, end: 20 }],
    ['an edit inside it widens it by the growth', at(12, 2, 'longer'), { start: 10, end: 24 }],
    ['an edit straddling its start covers the new text', at(8, 4, 'zz'), { start: 8, end: 18 }],
  ])('%s', (_name, change, expected) => {
    expect(shiftSpan(span, change)).toEqual(expected);
  });

  it('moves an empty span with an insertion at its place', () => {
    expect(shiftSpan({ start: 4, end: 4 }, at(4, 0, 'ab'))).toEqual({ start: 6, end: 6 });
  });
});

describe('locateSpan', () => {
  it('finds the occurrence of the new text nearest the line it was written at', () => {
    const text = 'x\ny\nx\ny\n';
    expect(locateSpan(text, 'x\n', 3)).toEqual({ start: 4, end: 6 });
    expect(locateSpan(text, 'x\n', 1)).toEqual({ start: 0, end: 2 });
  });

  it('ignores matches that do not start a line, and reports text that is gone', () => {
    expect(locateSpan('ax\nb\n', 'x\n', 1)).toBeUndefined();
  });
});

describe('reviewState', () => {
  const sessionId = asSessionId('s');
  const at = '2026-10-05T00:00:00.000Z';
  const change = changeOf('/w/x.ts', BEFORE, AFTER);
  const later = changeOf('/w/y.ts', 'p\n', 'q\n');
  const [first, second] = [`${change.id}:0`, `${change.id}:1`] as HunkId[];
  const result = (seq: number, c: typeof change): TurnEvent => ({
    kind: 'tool-result',
    seq,
    at,
    toolUseId: `tu${seq}`,
    name: 'edit',
    status: 'ok',
    output: 'Edited.',
    change: c,
  });
  const checkpoint = (seq: number, turnSeq: number): TurnEvent => ({ kind: 'checkpoint', seq, at, sessionId, turnSeq, sha: `sha${turnSeq}`, files: [], label: '' });

  it('starts every hunk pending and applies the last decision for each', () => {
    const events: TurnEvent[] = [
      checkpoint(1, 2),
      result(3, change),
      { kind: 'review', seq: 4, at, hunk: first!, status: 'undone' },
      { kind: 'review', seq: 5, at, hunk: first!, status: 'kept' },
    ];
    expect(reviewState(events).map((h) => [h.id, h.status, h.afterLine])).toEqual([
      [first, 'kept', 2],
      [second, 'pending', 5],
    ]);
  });

  it('undoes, on a rewind, exactly the hunks logged after the restored checkpoint', () => {
    const events: TurnEvent[] = [
      checkpoint(1, 2),
      result(3, change),
      checkpoint(4, 5),
      result(6, later),
      { kind: 'restored', seq: 7, at, turnSeq: 5, sha: 'sha5', files: ['y.ts'] },
    ];
    expect(reviewState(events).map((h) => [h.path, h.status])).toEqual([
      ['/w/x.ts', 'pending'],
      ['/w/x.ts', 'pending'],
      ['/w/y.ts', 'undone'],
    ]);
  });
});
