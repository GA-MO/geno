/** The fold fixture's files, prompts and the fake model's calls, shared by the suite and the test that launches it. */
export const FILES = {
  'a.ts': ['export function add(a: number, b: number): number {', '  return a + b;', '}', ''].join('\n'),
  'b.ts': "export const greeting = 'hello';\n",
  'c.ts': ['export function double(n: number): number {', '  return n + n;', '}', ''].join('\n'),
  'build/out.js': 'console.log(1);\n',
} as const;

export const PROMPTS = {
  long: 'Tidy up add and check the project still builds',
  remove: 'Look around, then delete the build folder',
} as const;

type Call = { readonly narration: string; readonly name: string; readonly input: Readonly<Record<string, unknown>> };

/** Ten rounds of narration and one call each: twenty steps, one of them failing, before the answer. */
export const LONG: readonly Call[] = [
  { narration: 'Reading add first.', name: 'read', input: { path: 'a.ts' } },
  { narration: 'Checking the greeting too.', name: 'read', input: { path: 'b.ts' } },
  { narration: 'Finding the callers of add.', name: 'grep', input: { pattern: 'add\\(' } },
  { narration: 'Listing the sources.', name: 'glob', input: { pattern: '*.ts' } },
  { narration: 'Reading double as well.', name: 'read', input: { path: 'c.ts' } },
  { narration: 'Looking at the folder.', name: 'bash', input: { command: 'ls' } },
  { narration: 'Swapping the operands.', name: 'edit', input: { path: 'a.ts', old_str: 'return a + b;', new_str: 'return b + a;' } },
  { narration: 'Making sure nothing else uses the greeting.', name: 'grep', input: { pattern: 'greeting' } },
  { narration: 'Reading the old helper.', name: 'read', input: { path: 'missing.ts' } },
  { narration: 'Checking where we are.', name: 'bash', input: { command: 'pwd' } },
];

export const LONG_SUMMARY = 'Read 4 files · searched 3 times · edited 1 file · ran 2 commands · 1 failed';

export const LONG_ANSWER = 'Swapped the operands in `add`; nothing else calls it, and the old helper is gone.';

/** Four searches, then a command that asks: the running turn has more steps than it shows. */
export const ASKING: readonly Call[] = [
  { narration: 'Looking for the build script.', name: 'grep', input: { pattern: 'build' } },
  { narration: 'Looking for the output folder.', name: 'grep', input: { pattern: 'out' } },
  { narration: 'Looking for what reads it.', name: 'grep', input: { pattern: 'console' } },
  { narration: 'Looking for a clean script.', name: 'grep', input: { pattern: 'clean' } },
  { narration: 'Removing the build output.', name: 'bash', input: { command: 'rm -rf build' } },
];

export const ASKING_SUMMARY = 'Searched 4 times · ran 1 command · 1 denied';

export const ASKING_ANSWER = 'Left `build` alone, since you denied removing it.';
