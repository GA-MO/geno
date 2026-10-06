/** The lanes fixture's files and prompts, shared by the suites inside VS Code and the test that launches them. */
export const FILES = {
  'a.ts': 'export const one = 1;\nexport const two = 2;\nexport const three = 3;\n',
  '.gcode.json': '{ "check": "true" }\n',
} as const;

/** Each conversation carries its marker in its first message, so the fake model knows whose call it answers. */
export const MARKERS = { lane: '[lane]', slow: '[slow]' } as const;

export const PROMPTS = {
  lane: `${MARKERS.lane} Make two loud`,
  slow: `${MARKERS.slow} Read a.ts and tell me about it`,
} as const;

/** The lane the lane prompt makes: its first words as a slug. */
export const LANE = 'lane-make-two-loud';

export const EDIT = { path: 'a.ts', old_str: 'export const two = 2;', new_str: 'export const TWO = 2;' } as const;

export const ANSWERS = {
  lane: 'Line two is loud now.',
  slow: 'a.ts exports one, two and three.',
} as const;

export const THEMES = { dark: 'Default Dark Modern', light: 'Default Light Modern', 'high-contrast': 'Default High Contrast' } as const;
