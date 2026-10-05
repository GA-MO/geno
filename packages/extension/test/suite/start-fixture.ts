/** The start page fixture: shared by the suite inside VS Code and the test that launches it. */
export const FILES = { 'a.ts': 'export const a = 1;\n' } as const;

export const BRANCH = 'noodle/start-page';

/** This project's past sessions, oldest first; the start page continues from the three newest. */
export const SESSIONS = [
  { id: 'oldest', prompt: 'Rename the config loader', at: '2026-09-28T09:00:00.000Z' },
  { id: 'older', prompt: 'Fix the parser', at: '2026-10-01T09:00:00.000Z' },
  { id: 'newer', prompt: 'Add a test for the lexer', at: '2026-10-03T09:00:00.000Z' },
  { id: 'newest', prompt: 'Tidy the README', at: '2026-10-04T09:00:00.000Z' },
] as const;

export const ANSWER = 'Done.';
export const FOLLOW_UP = 'One more thing';

export const THEMES = { dark: 'Default Dark Modern', light: 'Default Light Modern', 'high-contrast': 'Default High Contrast' } as const;
