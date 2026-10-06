/** The waits fixture's files and prompt, shared by the suite inside VS Code and the test that launches it. */
export const FILES = { 'a.ts': 'export const one = 1;\n' } as const;

export const PROMPT = 'Read a.ts and tell me about it';

export const ANSWER = 'a.ts exports one.';
