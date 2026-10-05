/** The sessions fixture's files, prompts and logged titles, shared by the suite inside VS Code and the test that launches it. */
export const FILES = { 'a.ts': 'export const a = 1;\n' } as const;

export const PROMPTS = { hello: 'Say hello', more: 'Keep going from there' } as const;

export const ANSWERS = { hello: 'Hello there.', more: 'Continuing where we left off.' } as const;

/** Logged before the window opens: an older session of this project, another project's, and a temporary clone's. */
export const OLDER = { id: 'older-session', prompt: 'Fix the parser', text: 'Reading the parser first.', answer: 'The parser is fixed.' } as const;
export const ELSEWHERE = { id: 'elsewhere-session', workspace: '/Users/someone/projects/elsewhere', prompt: 'Tidy the README' } as const;
export const TEMPORARY = { id: 'temporary-session', prompt: 'An eval task in a clone' } as const;

export const RENAMED = 'Greeting';

export const THEMES = { dark: 'Default Dark Modern', light: 'Default Light Modern', 'high-contrast': 'Default High Contrast' } as const;
