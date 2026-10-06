/** The usage fixture's files and prompts, shared by the suite inside VS Code and the test that launches it. */
export const FILES = {
  'a.ts': `${Array.from({ length: 200 }, (_, i) => `export const value${i} = ${i};`).join('\n')}\n`,
} as const;

/** Every request of the test opens with this, so the fake model knows the calls are its. */
export const MARKER = '[usage]';

export const PROMPTS = {
  read: `${MARKER} what does a.ts export?`,
  again: 'and how many values?',
} as const;

export const ANSWERS = {
  read: 'It exports value0 to value199.',
  again: 'Two hundred.',
} as const;

/** One row as the panel draws it and `gcode usage --json` gives it. */
export type ShownRow = { readonly label: string; readonly tokens: string; readonly percent: string; readonly baht: string; readonly usd: string };

/** What the suite read off the panel, which the test compares with the CLI's numbers. */
export type ShownSpend = { readonly turn: readonly ShownRow[]; readonly driver: string; readonly session: readonly ShownRow[]; readonly total: string; readonly top: readonly string[] };

export const THEMES = { dark: 'Default Dark Modern', light: 'Default Light Modern', 'high-contrast': 'Default High Contrast' } as const;
