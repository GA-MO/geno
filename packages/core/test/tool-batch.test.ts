import { describe, expect, it } from 'vitest';
import { MAX_CONCURRENT_TOOLS, nextToolBatch, type ToolBatch } from '../src/tool-batch.js';

/** Every batch of a turn whose uses are concurrent where `pattern` has `r`, in order. */
function batches(pattern: string): ToolBatch[] {
  const out: ToolBatch[] = [];
  for (let start = 0; start < pattern.length; ) {
    const batch = nextToolBatch(pattern.length, start, (i) => pattern[i] === 'r');
    out.push(batch);
    start = batch.end;
  }
  return out;
}

describe('tool batches', () => {
  it('groups consecutive concurrent uses and runs every other use alone, in the original order', () => {
    expect(batches('rrrre')).toEqual([
      { start: 0, end: 4 },
      { start: 4, end: 5 },
    ]);
    expect(batches('rere')).toEqual([
      { start: 0, end: 1 },
      { start: 1, end: 2 },
      { start: 2, end: 3 },
      { start: 3, end: 4 },
    ]);
    expect(batches('eerr')).toEqual([
      { start: 0, end: 1 },
      { start: 1, end: 2 },
      { start: 2, end: 4 },
    ]);
  });

  it('never puts reads from either side of an edit in one batch', () => {
    expect(batches('rrerr')).toEqual([
      { start: 0, end: 2 },
      { start: 2, end: 3 },
      { start: 3, end: 5 },
    ]);
  });

  it('runs at most 8 at once', () => {
    expect(MAX_CONCURRENT_TOOLS).toBe(8);
    expect(batches('r'.repeat(19))).toEqual([
      { start: 0, end: 8 },
      { start: 8, end: 16 },
      { start: 16, end: 19 },
    ]);
  });
});
