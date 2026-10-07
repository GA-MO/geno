/** The attention fixture's files and prompts, shared by the suites inside VS Code and the test that launches them. */
export const FILES = {
  'a.ts': 'export const one = 1;\n',
  '.gcode.json': '{ "check": "true", "agentTool": ["ask", "auto"] }\n',
} as const;

/** Each conversation carries its marker in its first message, so the fake model knows whose call it answers. */
export const MARKERS = { seen: '[seen]', slow: '[slow]', ask: '[ask]', parent: '[parent]', child: '[child]', lane: '[lane]' } as const;

export const PROMPTS = {
  seen: `${MARKERS.seen} Say hello`,
  slow: `${MARKERS.slow} Read a.ts slowly`,
  ask: `${MARKERS.ask} Download the page`,
  parent: `${MARKERS.parent} Have a worker download the page`,
  lane: `${MARKERS.lane} Look over a.ts`,
} as const;

export const CHILD_TASK = `${MARKERS.child} download the page`;

/** A command Ask mode asks about. */
export const COMMAND = 'curl -sSo page.html https://example.com';

export const ANSWERS = {
  seen: 'Hello.',
  slow: 'a.ts exports one.',
  lane: 'a.ts looks fine.',
} as const;

export const THEMES = { dark: 'Default Dark Modern', light: 'Default Light Modern', 'high-contrast': 'Default High Contrast' } as const;
