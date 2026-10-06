/** The editor actions fixture's files, prompt and the fake model's calls, shared by the suite and the test that launches it. */
const filler = Array.from({ length: 60 }, (_, i) => `export const n${i} = ${i};`);

export const HELPER_LINE = 45;

export const FILES = {
  'a.ts': 'export const one = 1;\n',
  'src/util.ts': [...filler.slice(0, HELPER_LINE - 1), 'export function helper(): number {', '  return 42;', '}', ...filler.slice(HELPER_LINE - 1), ''].join('\n'),
} as const;

export const PROMPT = 'Raise one, show me the diff, then where is helper defined? open it for me';

export const EDIT = { path: 'a.ts', old_str: 'one = 1', new_str: 'one = 10' } as const;

export const ANSWER = 'helper is defined in src/util.ts at line 45; it is open now.';
