import { describe, expect, it } from 'vitest';
import { linesOf, needsSpill, numberedPage, PAGE_MAX_CHARS, PAGE_MAX_LINES } from '../src/index.js';

const numbered = (count: number, text = (n: number) => `line ${n}`) => Array.from({ length: count }, (_, i) => text(i + 1));

describe('numberedPage', () => {
  it('returns a short file whole and bare, and a range with its place', () => {
    expect(numberedPage(['a', 'b'], 1, undefined)).toBe('1\ta\n2\tb');
    expect(numberedPage(['a', 'b', 'c'], 2, 3)).toBe('2\tb\n3\tc\n[lines 2-3 of 3]');
  });

  it(`stops at ${PAGE_MAX_LINES} lines and names the start_line that continues`, () => {
    const lines = numbered(5000, () => 'x');
    const page = numberedPage(lines, 1, undefined);
    expect(page.split('\n')).toHaveLength(PAGE_MAX_LINES + 1);
    expect(page.endsWith('[lines 1-2000 of 5000. One read returns at most 2,000 lines or 20,000 characters; read again with start_line=2001 to continue.]')).toBe(true);
    expect(numberedPage(lines, 4001, undefined).endsWith('4999\tx\n5000\tx\n[lines 4001-5000 of 5000]')).toBe(true);
  });

  it('stops at the character budget, never splitting a line, and never needs a spill', () => {
    const lines = numbered(1000, (n) => `${n}`.padEnd(100, '.'));
    const page = numberedPage(lines, 1, undefined);
    const shown = page.split('\n').slice(0, -1);
    const last = Number(shown.at(-1)!.split('\t')[0]);
    expect(shown.at(-1)).toBe(`${String(last).padStart(4)}\t${lines[last - 1]}`);
    expect(page).toContain(`read again with start_line=${last + 1} to continue.]`);
    expect(page.length).toBeLessThanOrEqual(PAGE_MAX_CHARS + 200);
    expect(needsSpill(page)).toBe(false);
    expect(numberedPage(lines, last + 1, undefined).trimStart().startsWith(`${last + 1}\t`)).toBe(true);
  });

  it('shows the start of one line longer than a page and moves on to the next', () => {
    const page = numberedPage(['short', 'y'.repeat(50_000), 'after'], 2, undefined);
    expect(page.length).toBeLessThan(PAGE_MAX_CHARS + 200);
    expect(page.endsWith('[line 2 of 3 is 50,000 characters; this shows its start. Read again with start_line=3 to continue.]')).toBe(true);
  });

  it('splits text into lines without the empty one after a final newline', () => {
    expect(linesOf('a\nb\n')).toEqual(['a', 'b']);
    expect(linesOf('a\n\n')).toEqual(['a', '']);
  });
});
