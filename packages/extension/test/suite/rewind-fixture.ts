/** The rewind fixture's prompts, shared by the suite inside VS Code and the test that launches it. */
export const FILES = {
  'a.ts': 'export const a = "one";\n',
  'b.ts': 'export const b = 1;\n',
} as const;

/** Every conversation of the test, the fork's too, opens with this, so the fake model knows the calls are its. */
export const MARKER = '[rewind]';

export const PROMPTS = {
  two: `${MARKER} make it two`,
  three: 'make it three',
  /** What the user sends after editing the rewound prompt in the composer. */
  edited: 'make it 3',
  /** The fork's own next turn. */
  forked: 'make it 2.5',
} as const;

export const ANSWERS = {
  two: 'It is two.',
  three: 'It is three.',
  edited: 'Made it 3.',
  forked: 'Made it 2.5.',
} as const;

/** An edit the user makes by hand after the last turn, which no checkpoint holds. */
export const HAND_EDIT = { file: 'b.ts', text: 'export const b = 2;\n' } as const;

export const THEMES = { dark: 'Default Dark Modern', light: 'Default Light Modern', 'high-contrast': 'Default High Contrast' } as const;
