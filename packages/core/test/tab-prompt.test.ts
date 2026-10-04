import { describe, expect, it } from 'vitest';
import { buildFimPrompt, estimateTokens, type FimBudget, type FimInputs } from '../src/tab/index.js';

const lines = (prefix: string, count: number): string =>
  Array.from({ length: count }, (_, i) => `${prefix} line ${i} with some code();`).join('\n');

const inputs = (overrides: Partial<FimInputs> = {}): FimInputs => ({
  repo: 'demo',
  path: 'src/app.ts',
  prefix: 'const x = ',
  suffix: ';\n',
  snippets: [],
  ...overrides,
});

const roomy: FimBudget = { prefixTokens: 10_000, suffixTokens: 10_000, snippetTokens: 10_000 };

describe('buildFimPrompt', () => {
  it('lays out repo, other files, then the current file in Qwen FIM order', () => {
    const { prompt } = buildFimPrompt(
      inputs({ snippets: [{ path: 'src/near.ts', text: 'export const near = 1;\n' }] }),
      roomy,
    );
    expect(prompt).toBe(
      '<|repo_name|>demo\n' +
        '<|file_sep|>src/near.ts\nexport const near = 1;\n' +
        '<|file_sep|>src/app.ts\n' +
        '<|fim_prefix|>const x = <|fim_suffix|>;\n<|fim_middle|>',
    );
  });

  it('puts the most relevant snippet last, next to the current file', () => {
    const { prompt } = buildFimPrompt(
      inputs({
        snippets: [
          { path: 'first.ts', text: 'a\n' },
          { path: 'second.ts', text: 'b\n' },
          { path: 'third.ts', text: 'c\n' },
        ],
      }),
      roomy,
    );
    const order = ['third.ts', 'second.ts', 'first.ts', 'src/app.ts'].map((p) => prompt.indexOf(`<|file_sep|>${p}\n`));
    expect(order.every((at) => at >= 0)).toBe(true);
    expect(order).toEqual(order.toSorted((a, b) => a - b));
  });

  it('trims the prefix from the top and the suffix from the bottom, keeping whole lines and the cursor line', () => {
    const budget: FimBudget = { prefixTokens: 50, suffixTokens: 30, snippetTokens: 0 };
    const prefix = `${lines('before', 40)}\n  const cursor = `;
    const suffix = `value;\n${lines('after', 40)}`;
    const { inputs: trimmed } = buildFimPrompt(inputs({ prefix, suffix }), budget);

    expect(estimateTokens(trimmed.prefix)).toBeLessThanOrEqual(budget.prefixTokens);
    expect(estimateTokens(trimmed.suffix)).toBeLessThanOrEqual(budget.suffixTokens);
    expect(trimmed.prefix.endsWith('\n  const cursor = ')).toBe(true);
    expect(trimmed.suffix.startsWith('value;\n')).toBe(true);
    expect(prefix.endsWith(trimmed.prefix)).toBe(true);
    expect(suffix.startsWith(trimmed.suffix)).toBe(true);
    const prefixLines = new Set(prefix.split('\n'));
    for (const line of trimmed.prefix.split('\n')) expect(prefixLines.has(line)).toBe(true);
    const suffixLines = new Set(suffix.split('\n'));
    for (const line of trimmed.suffix.split('\n')) expect(suffixLines.has(line)).toBe(true);
    expect(trimmed.prefix.split('\n').length).toBeGreaterThan(2);
  });

  it('fills the snippet budget most relevant first and drops what does not fit', () => {
    const budget: FimBudget = { prefixTokens: 100, suffixTokens: 100, snippetTokens: 60 };
    const { inputs: trimmed } = buildFimPrompt(
      inputs({
        snippets: [
          { path: 'best.ts', text: lines('best', 3) },
          { path: 'big.ts', text: lines('big', 30) },
          { path: 'never.ts', text: lines('never', 30) },
        ],
      }),
      budget,
    );
    expect(trimmed.snippets.map((s) => s.path)).toEqual(['best.ts', 'big.ts']);
    expect(trimmed.snippets[0]!.text).toBe(`${lines('best', 3)}\n`);
    expect(lines('big', 30).startsWith(trimmed.snippets[1]!.text.trimEnd())).toBe(true);
    const snippetChars = trimmed.snippets.reduce((n, s) => n + `<|file_sep|>${s.path}\n`.length + s.text.length, 0);
    expect(estimateTokens('x'.repeat(snippetChars))).toBeLessThanOrEqual(budget.snippetTokens);
  });

  it('cuts a cursor line that alone exceeds the budget instead of exceeding it', () => {
    const { inputs: trimmed } = buildFimPrompt(
      inputs({ prefix: 'x'.repeat(1000), suffix: 'y'.repeat(1000) }),
      { prefixTokens: 10, suffixTokens: 10, snippetTokens: 0 },
    );
    expect(trimmed.prefix).toBe('x'.repeat(30));
    expect(trimmed.suffix).toBe('y'.repeat(30));
  });

  it('asks for one line when code precedes the cursor on its line, and several on a blank line', () => {
    expect(buildFimPrompt(inputs({ prefix: 'a\n  const x = ' }), roomy).singleLine).toBe(true);
    expect(buildFimPrompt(inputs({ prefix: 'a\n  ' }), roomy).singleLine).toBe(false);
    expect(buildFimPrompt(inputs({ prefix: '' }), roomy).singleLine).toBe(false);
  });
});
