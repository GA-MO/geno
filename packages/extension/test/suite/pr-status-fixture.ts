/** The PR status fixture, shared by the suite inside VS Code and the test that launches it with a fake gh. */
export const FILES = {
  'a.ts': 'export const total = 1;\n',
  '.git/HEAD': 'ref: refs/heads/cart-total\n',
} as const;

/** The stages the test sets the fake gh to, by name. */
export const STAGES = ['pending', 'failing', 'logged-out'] as const;
export type StageName = (typeof STAGES)[number];

export const TITLE = 'Add the cart total to the checkout page';

export const THEMES = { dark: 'Default Dark Modern', light: 'Default Light Modern', 'high-contrast': 'Default High Contrast' } as const;
