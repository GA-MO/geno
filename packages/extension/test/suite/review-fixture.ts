/** The review fixture's files and the edits the fake model makes, shared by the suites inside VS Code and the test that launches them. */
export const FILES = {
  'a.ts': [
    'export function add(a: number, b: number): number {',
    '  return a + b;',
    '}',
    '',
    'export const one = 1;',
    'export const two = 2;',
    'export const three = 3;',
    '',
  ].join('\n'),
  'b.ts': "export const greeting = 'hello';\n",
  'c.ts': ['export function double(n: number): number {', '  return n + n;', '}', ''].join('\n'),
} as const;

export const EDITS = {
  addOrder: { path: 'a.ts', old_str: 'return a + b;', new_str: 'return b + a;' },
  three: { path: 'a.ts', old_str: 'export const three = 3;', new_str: 'export const three = 30;\nexport const four = 40;' },
  greeting: { path: 'b.ts', old_str: "'hello'", new_str: "'hi'" },
  double: { path: 'c.ts', old_str: 'return n + n;', new_str: 'return n * 2;' },
} as const;

export const TYPED_ABOVE = 'export const zero = 0;\n';

export const INSTRUCTION = 'Multiply instead of adding';
