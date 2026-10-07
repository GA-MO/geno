/** The scheduled-task fixture's files, command and the fake model's answer, shared by the suite and the test that launches it. */
export const FILES = { 'src/app.ts': 'export const port = 3000;\n' } as const;

/** The run's first message carries the marker, so the fake model knows the call is the run's. */
export const MARKER = '[sched-run]';

export const PROMPT = `${MARKER} review src/ for unused exports`;

export const COMMAND = `/schedule weekdays at 9:00 ${PROMPT}`;

export const ANSWER = 'No unused exports: src/app.ts exports port, and nothing else.';
