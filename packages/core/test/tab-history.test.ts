import { describe, expect, it } from 'vitest';
import { editBetween, recordChange, renderEdit, type DocumentChange } from '../src/tab/index.js';

const file = (n: number) => Array.from({ length: n }, (_, i) => `line ${i}`).join('\n') + '\n';
const at = (s: number) => `2026-01-01T00:00:0${s}.000Z`;
const change = (before: string, after: string, path = 'a.ts', s = 0): DocumentChange => ({ path, at: at(s), before, after });

describe('editBetween', () => {
  it('keeps the changed lines with three lines of context each side, numbered from the first context line', () => {
    const before = file(20);
    const entry = editBetween(change(before, before.replace('line 10\n', 'line ten\n')))!;
    expect(entry.line).toBe(7);
    expect(entry.oldText).toBe('line 7\nline 8\nline 9\nline 10\nline 11\nline 12\nline 13\n');
    expect(entry.newText).toBe('line 7\nline 8\nline 9\nline ten\nline 11\nline 12\nline 13\n');
    expect(renderEdit(entry)).toBe(
      '@@ -8,7 +8,7 @@\n line 7\n line 8\n line 9\n-line 10\n+line ten\n line 11\n line 12\n line 13\n',
    );
  });

  it('is undefined when nothing changed', () => {
    expect(editBetween(change('a\n', 'a\n'))).toBeUndefined();
  });
});

describe('recordChange', () => {
  it('folds keystrokes on the same lines into one edit, and drops it when the user types it back', () => {
    const v0 = file(20);
    const v1 = v0.replace('line 10\n', 'line 10x\n');
    const v2 = v1.replace('line 10x\n', 'line 10xy\n');
    let history = recordChange([], change(v0, v1, 'a.ts', 1));
    history = recordChange(history, change(v1, v2, 'a.ts', 2));
    expect(history).toHaveLength(1);
    expect(history[0]).toMatchObject({ at: at(2), oldText: expect.stringContaining('line 10\n'), newText: expect.stringContaining('line 10xy\n') });
    expect(recordChange(history, change(v2, v0, 'a.ts', 3))).toEqual([]);
  });

  it('starts a new edit for a change elsewhere or in another file, keeping the newest `limit`', () => {
    const v0 = file(40);
    const v1 = v0.replace('line 5\n', 'line five\n');
    const v2 = v1.replace('line 30\n', 'line thirty\n');
    let history = recordChange([], change(v0, v1, 'a.ts', 1), 2);
    history = recordChange(history, change(v1, v2, 'a.ts', 2), 2);
    history = recordChange(history, change('x\n', 'y\n', 'b.ts', 3), 2);
    expect(history.map((e) => [e.path, e.line])).toEqual([
      ['a.ts', 27],
      ['b.ts', 0],
    ]);
  });

  it('folds an inserted line into the edit it sits next to', () => {
    const v0 = file(20);
    const v1 = v0.replace('line 10\n', 'line 10\nnew\n');
    const v2 = v1.replace('new\n', 'new\nnewer\n');
    const history = recordChange(recordChange([], change(v0, v1)), change(v1, v2));
    expect(history).toHaveLength(1);
    expect(renderEdit(history[0]!)).toContain('+new\n+newer\n');
  });
});
