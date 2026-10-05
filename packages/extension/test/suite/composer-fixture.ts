/** The composer fixture's prompts, shared by the suite inside VS Code and the test that launches it. */
export const PROMPTS = {
  browse: 'Open the dev server',
  run: 'Read a.ts and tell me about it',
  queued: 'and say it twice',
  stalled: 'Write a long essay',
  stalledQueue: 'then a short one',
} as const;

export const THEMES = { dark: 'Default Dark Modern', light: 'Default Light Modern', 'high-contrast': 'Default High Contrast' } as const;
