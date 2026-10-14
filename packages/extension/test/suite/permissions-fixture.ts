/** The permissions fixture, shared by the suite inside VS Code and the test that launches it. */
export const FILES = { 'a.ts': 'export const a = 1;\n' } as const;

/** A harmless command Ask asks about, since it names a path outside the workspace. The list tool cannot sort by time, so Geno lets ls -t run. */
export const COMMAND = 'ls -t ..';

export const PROMPTS = { first: 'What is next to this folder?', again: 'List it once more' } as const;
