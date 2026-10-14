/** The working dino fixture's files, prompts and the fake model's calls, shared by the suite and the test that launches it. */
export const FILES = {
  'a.ts': ['export function add(a: number, b: number): number {', '  return a + b;', '}', ''].join('\n'),
  'notes.md': '# Notes\n\nNothing yet.\n',
  'build/out.js': 'console.log(1);\n',
  // The workspace's check command, which passes: the turn that runs it ends with a flex.
  '.gcode.json': JSON.stringify({ check: 'true' }),
} as const;

export const PROMPTS = {
  work: 'Swap the operands in add, note it, and check',
  trouble: 'Read the old helper, then delete the build folder',
  plan: 'Plan how to rename add',
} as const;

type Call = { readonly say: string; readonly name: string; readonly input: Readonly<Record<string, unknown>> };

/** One call per model reply, each with the pose it brings: read, then an edit of code, of Markdown, a command and a check. */
export const WORK: readonly (Call & { readonly pose: string })[] = [
  { say: 'Reading add first.', name: 'read', input: { path: 'a.ts' }, pose: 'reading' },
  { say: 'Swapping the operands.', name: 'edit', input: { path: 'a.ts', old_str: 'return a + b;', new_str: 'return b + a;' }, pose: 'coding' },
  { say: 'Now the notes.', name: 'read', input: { path: 'notes.md' }, pose: 'reading' },
  { say: 'Noting the change.', name: 'edit', input: { path: 'notes.md', old_str: 'Nothing yet.', new_str: 'add takes b first.' }, pose: 'writing' },
  { say: 'Looking at the folder.', name: 'bash', input: { command: 'ls -t' }, pose: 'running' },
  { say: 'Checking the project.', name: 'check', input: {}, pose: 'running' },
];

/** A read that fails, then a command Ask holds for the user. */
export const TROUBLE: readonly Call[] = [
  { say: 'Reading the old helper.', name: 'read', input: { path: 'missing.ts' } },
  { say: 'Removing the build output.', name: 'bash', input: { command: 'rm -rf build' } },
];

/** The recorded turn's replies: the work's calls again, then its answer. */
export const AGAIN_REPLIES = WORK.length + 1;

export const PLAN: readonly Call[] = [{ say: 'Reading add.', name: 'read', input: { path: 'a.ts' } }];

export const ANSWERS = { work: 'Swapped the operands; the check passes.', plan: '1. Rename add.' } as const;

export const THEMES = { dark: 'Default Dark Modern', light: 'Default Light Modern', 'high-contrast': 'Default High Contrast' } as const;
