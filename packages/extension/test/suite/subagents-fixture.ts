/** The subagents fixture's prompts and tasks, shared by the suite inside VS Code and the test that launches it. */
export const FILES = {
  'a.ts': 'export const alpha = 1;\n',
  'b.ts': 'export const beta = 2;\n',
  '.gcode.json': '{ "agentTool": ["ask", "auto"] }\n',
} as const;

/** Each conversation carries its marker in its first message, so the fake model knows whose call it answers. */
export const MARKERS = { parent: '[p1]', cancel: '[p2]', alpha: '[c-a]', beta: '[c-b]', gamma: '[c-c]' } as const;

export const PROMPTS = {
  explore: `${MARKERS.parent} Where are alpha and beta?`,
  cancel: `${MARKERS.cancel} Look for gamma`,
} as const;

export const TASKS = {
  alpha: `${MARKERS.alpha} where is alpha defined`,
  beta: `${MARKERS.beta} where is beta defined`,
  gamma: `${MARKERS.gamma} where is gamma defined`,
} as const;

export const ANSWERS = {
  alpha: 'a.ts:1 defines alpha.',
  beta: 'b.ts:1 defines beta.',
  parent: 'alpha is in a.ts, beta in b.ts.',
  cancelled: 'The search for gamma was stopped.',
} as const;

export const THEMES = { dark: 'Default Dark Modern', light: 'Default Light Modern', 'high-contrast': 'Default High Contrast' } as const;
