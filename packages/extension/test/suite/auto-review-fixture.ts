/** The auto review fixture's files, prompts and edits, shared by the suites inside VS Code and the test that launches them. */
export const FILES = {
  'a.ts': 'export const one = 1;\nexport const two = 2;\nexport const three = 3;\n',
  'b.ts': "export const greeting = 'hello';\n",
  'c.ts': 'export const double = (n: number): number => n + n;\n',
  '.gcode.json': '{ "check": "true" }\n',
} as const;

/** Each conversation carries its marker in its first message, so the fake model knows whose call it answers. */
export const MARKERS = { chat: '[chat]', lane: '[lane]' } as const;

export const PROMPTS = {
  edit: `${MARKERS.chat} Raise one and shorten the greeting`,
  review: 'Multiply in c.ts',
  lane: `${MARKERS.lane} Make three loud`,
} as const;

export const LANE = 'lane-make-three-loud';

export const EDITS = {
  one: { path: 'a.ts', old_str: 'export const one = 1;', new_str: 'export const one = 10;' },
  greeting: { path: 'b.ts', old_str: "'hello'", new_str: "'hi'" },
  three: { path: 'a.ts', old_str: 'export const three = 3;', new_str: 'export const THREE = 3;' },
  double: { path: 'c.ts', old_str: 'n + n', new_str: 'n * 2' },
} as const;

export const ANSWERS = { edit: 'Raised one and shortened the greeting.', review: 'It multiplies now.', lane: 'Three is loud now.' } as const;
