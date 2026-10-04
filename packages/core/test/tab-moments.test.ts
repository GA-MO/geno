import { describe, expect, it } from 'vitest';
import { applyEdit, editMoments, gradePrediction, type ChangedFile } from '../src/tab/index.js';

const lines = (n: number) => Array.from({ length: n }, (_, i) => `const v${i} = ${i};`);
const before = `${lines(30).join('\n')}\n`;
const after = before.replace('const v2 = 2;', 'const v2 = two;').replace('const v12 = 12;\n', '').replace('const v25 = 25;', 'const v25 = twentyfive;\nconst extra = 1;');
const file: ChangedFile = { id: 't1', path: 'a.ts', before, after };

describe('editMoments', () => {
  it('makes one moment per hunk after the first, with the earlier hunks applied and in the history', () => {
    const moments = editMoments(file);
    expect(moments.map((m) => m.id)).toEqual(['t1#1', 't1#2']);
    const [first, second] = moments;
    expect(first!.document).toBe(before.replace('const v2 = 2;', 'const v2 = two;'));
    expect(first!.history).toHaveLength(1);
    expect(first!.document.slice(0, first!.cursor).endsWith('const v2 = two;')).toBe(true);
    expect(first!.document.slice(first!.target.start, first!.target.end)).toBe('const v12 = 12;\n');
    expect(first!.target.text).toBe('');
    expect(second!.history).toHaveLength(2);
    expect(applyEdit(second!.document, second!.target)).toBe(after);
  });

  it('keeps only the newest history entries', () => {
    expect(editMoments(file, 1)[1]!.history).toHaveLength(1);
  });
});

describe('gradePrediction', () => {
  const [moment] = editMoments(file);
  const { start, end } = moment!.target;

  it('grades the same resulting file as exact, even through a smaller edit', () => {
    expect(gradePrediction(moment!, { kind: 'edit', start, end, text: '' })).toBe('exact');
  });

  it('grades a different change on the target lines as region, and one elsewhere as wrong location', () => {
    expect(gradePrediction(moment!, { kind: 'edit', start, end: start + 5, text: 'let' })).toBe('region');
    expect(gradePrediction(moment!, { kind: 'edit', start: 0, end: 5, text: 'let' })).toBe('wrong-location');
    expect(gradePrediction(moment!, { kind: 'none', reason: 'unchanged' })).toBe('none');
  });
});
