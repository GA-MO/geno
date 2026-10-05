import { FLOWCHART } from './diagram-fixture.js';

/** The style fixture's files, prompts and the fake model's answers, shared by the suite and the test that launches it. */
export const FILES = {
  'a.ts': ['export function add(a: number, b: number): number {', '  return a + b;', '}', ''].join('\n'),
  'b.ts': "export const greeting = 'hello';\n",
  'build/out.js': 'console.log(1);\n',
} as const;

export const EDIT = { path: 'a.ts', old_str: 'return a + b;', new_str: 'return b + a;' } as const;

export const ANSWER = [
  'Swapped the operands in `add`. The new body reads:',
  '',
  '```ts',
  'export function add(a: number, b: number): number {',
  '  return b + a;',
  '}',
  '```',
  '',
  'A request goes from the panel to the engine and streams back:',
  '',
  '```mermaid',
  FLOWCHART,
  '```',
].join('\n');

export const PROMPTS = {
  edit: 'Swap the operands in add and show how a request flows',
  remove: 'Delete the build folder',
  essay: 'Write a long essay',
} as const;
