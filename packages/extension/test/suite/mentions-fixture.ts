/** The mentions fixture, shared by the suite inside VS Code and the test that launches it. */
export const FILES = {
  'math.ts': 'export function add(a: number, b: number): number {\n  return a + b;\n}\n',
  'notes/selected.ts': 'const one = 1;\nconst two = 2;\nconst three = 3;\nconst four = 4;\n',
} as const;

/** Typed into math.ts and never saved. */
export const UNSAVED = 'export const draftOnly = 1;\n';

/** The lines of notes/selected.ts the suite selects, from 1. */
export const SELECTED = { startLine: 2, endLine: 3 } as const;

export const PROMPT = 'Explain @math.ts and @selection';
