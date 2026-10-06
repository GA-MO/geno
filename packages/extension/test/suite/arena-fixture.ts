/** The Arena fixture's files and task, shared by the suite inside VS Code and the test that launches it. */
export const FILES = {
  'a.ts': 'one\ntwo\nthree\n',
  'b.ts': 'x\n',
  // Lane C writes BAD, so its check fails and the review ranks only A and B.
  '.gcode.json': '{ "check": "! grep -q BAD a.ts" }\n',
} as const;

export const TASK = '[arena] Make line two louder';

/** The review child's task says this; the lanes' prompts are the task and their seed's text. */
export const REVIEW_MARKER = 'lanes each tried the task';

export const SUMMARY = 'B is the smaller change, and A adds a line nobody asked for.';
export const REASONS = { A: 'Adds an unasked line four.', B: 'Smallest change that does it.' } as const;

/** What the main checkout holds after the winner B is applied, and after A's added line is grafted over it. */
export const APPLIED = { 'a.ts': 'one\nTwo\nthree\n', 'b.ts': 'y\n' } as const;
export const GRAFTED = 'one\nTwo\nthree\nfour\n';
