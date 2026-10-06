/** The steer fixture's prompts, shared by the suite inside VS Code and the test that launches it. */
export const FILES = {
  'a.ts': 'export const alpha = 1;\n',
  'b.ts': 'export const beta = 2;\n',
  '.gcode.json': '{ "agentTool": ["ask", "auto"] }\n',
} as const;

/** The chat's conversation and the child's each carry a marker in their first message, so the fake model knows whose call it answers. */
export const MARKERS = { chat: '[chat]', kid: '[kid]' } as const;

/** Files whose appearance in the workspace ends the waiting bash call of a turn. */
export const RELEASES = { steer: 'release-steer', queue: 'release-queue' } as const;

export const waitFor = (file: string): string => `until [ -f ${file} ]; do sleep 0.2; done`;

export const PROMPTS = {
  steer: `${MARKERS.chat} Wait for the build, then check a.ts`,
  queue: 'Wait for the build again',
  agent: 'Ask an explorer where alpha is',
} as const;

/** What the user types while a turn runs. */
export const SENT = {
  steer: 'Also check b.ts while you are at it',
  queued: 'and say it twice',
  nextTurn: 'Then list the files',
  child: 'Look in a.ts only',
} as const;

export const ANSWERS = {
  steer: 'Checked a.ts and b.ts as you asked.',
  queue: 'The build is done.',
  queued: 'The build is done. The build is done.',
  nextTurn: 'a.ts and b.ts.',
  child: 'alpha is in a.ts.',
  agent: 'The explorer found alpha in a.ts.',
} as const;

export const TASK = `${MARKERS.kid} where is alpha defined`;

export const THEMES = { dark: 'Default Dark Modern', light: 'Default Light Modern', 'high-contrast': 'Default High Contrast' } as const;
