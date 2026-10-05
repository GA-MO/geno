/** The panel fixture's files, prompts and the fake model's answer, shared by the suite inside VS Code and the test that launches it. */
export const FILES = {
  'a.ts': ['export function add(a: number, b: number): number {', '  return a + b;', '}', ''].join('\n'),
  'b.ts': "export const greeting = 'hello';\n",
  'c.ts': ['export function double(n: number): number {', '  return n + n;', '}', ''].join('\n'),
  'build/out.js': 'console.log(1);\n',
} as const;

export const EDITS = {
  addOrder: { path: 'a.ts', old_str: 'return a + b;', new_str: 'return b + a;' },
  greeting: { path: 'b.ts', old_str: "'hello'", new_str: "'hi'" },
  double: { path: 'c.ts', old_str: 'return n + n;', new_str: 'return n * 2;' },
} as const;

export const PROMPTS = {
  edit: 'Swap the operands in add, shorten the greeting and make double multiply',
  remove: 'Delete the build folder',
  removeAgain: 'Delete it after all',
  stopByButton: 'Write a long essay',
  stopByEscape: 'Write another long essay',
} as const;

export const CODE = ['export function add(a: number, b: number): number {', '  return b + a;', '}'].join('\n');

export const ANSWER = [
  'Swapped the operands in `add`, shortened the greeting and made `double` multiply. The new `add` reads:',
  '',
  '```ts',
  CODE,
  '```',
  '',
  '- **a.ts**: `b + a` instead of `a + b`',
  "- **b.ts**: the greeting is now `'hi'`",
  '- **c.ts**: `double` returns `n * 2`',
].join('\n');

/** Tool call ids the fake model uses, so the suite can find each call's row in the panel. */
export const TOOL_IDS = { grep: 'tu_grep', read: 'tu_read_a', readB: 'tu_read_b', readC: 'tu_read_c', editA: 'tu_edit_a', editB: 'tu_edit_b', editC: 'tu_edit_c' } as const;

export const THEMES = { dark: 'Default Dark Modern', light: 'Default Light Modern', 'high-contrast': 'Default High Contrast' } as const;

/** The Keep and Undo CodeLens command ids, which the panel's buttons must drive too. */
export const KEEP = 'gcode.review.keep';
export const UNDO = 'gcode.review.undo';
