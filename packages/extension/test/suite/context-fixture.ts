/** The rules and memory fixture's texts, shared by the suite inside VS Code and the test that launches it. */

export const PROMPTS = { remember: 'From now on, use pnpm.', ask: 'Set up the database.' } as const;

/** The exact note the model proposes; the card must show it word for word. */
export const NOTE = 'Use pnpm for every install and script, never npm.';
export const EDITED = 'Use pnpm 11 for every install and script.';

export const QUESTION = { question: 'Which database should I set up?', options: ['Postgres', 'SQLite'] } as const;
export const ANSWER = 'SQLite';

export const THEMES = { dark: 'Default Dark Modern', light: 'Default Light Modern', 'high-contrast': 'Default High Contrast' } as const;
