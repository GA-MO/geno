import { describe, expect, it } from 'vitest';
import { firstFilter, type FilterInput, type FilterName } from '../src/tab/index.js';

const here = { version: 3, offset: 42 };
const base: FilterInput = { text: 'return a + b;', suffix: '\n}\n', maxLines: 3, requested: here, current: here };

const cases: [FilterName, Partial<FilterInput>][] = [
  ['stale', { current: { version: 4, offset: 42 } }],
  ['stale', { current: { version: 3, offset: 43 } }],
  ['empty', { text: '' }],
  ['empty', { text: '  \n\t\n' }],
  ['repeats-suffix', { text: '}', suffix: '\n}\n' }],
  ['repeats-suffix', { text: ')', suffix: ');\n' }],
  ['repeats-suffix', { text: '\n  foo(1);\n  bar();', suffix: '  foo(1);\n}' }],
  ['too-many-lines', { text: 'a\nb\nc\nd' }],
];

describe('firstFilter', () => {
  it.each(cases)('drops with %s', (name, overrides) => {
    expect(firstFilter({ ...base, ...overrides })).toBe(name);
  });

  it('keeps a fresh, non-empty, novel completion within the line limit', () => {
    expect(firstFilter(base)).toBeUndefined();
    expect(firstFilter({ ...base, text: 'a\nb\nc\n\n' })).toBeUndefined();
    expect(firstFilter({ ...base, text: 'foo', suffix: '' })).toBeUndefined();
  });
});
