/** The background commands fixture's files, prompts and the fake model's calls, shared by the suite and the test that launches it. */
export const FILES = { 'a.ts': 'export const a = 1;\n' } as const;

export const PROMPTS = { start: 'Start the dev server and build once', after: 'Is the server still up?' } as const;

/** Prints a line now and then, as a dev server does while it starts, then waits to be stopped. */
export const SERVER = 'for i in 1 2 3 4 5 6; do echo "compiled module $i"; sleep 0.3; done; echo "ready on http://localhost:5173"; sleep 600';
export const BUILD = 'sleep 1; echo "built in 1.0s"';

type Call = { readonly narration: string; readonly id: string; readonly name: string; readonly input: Readonly<Record<string, unknown>> };

export const CALLS: readonly Call[] = [
  { narration: 'Starting the dev server.', id: 'tu_bg_server', name: 'bash', input: { command: SERVER, description: 'Start the dev server', run_in_background: true } },
  { narration: 'Building once.', id: 'tu_bg_build', name: 'bash', input: { command: BUILD, description: 'Build the project once', run_in_background: true } },
  { narration: 'Waiting for the build.', id: 'tu_bg_wait', name: 'bash', input: { command: 'sleep 2', description: 'Wait for the build to finish' } },
];

export const ANSWERS = { start: 'The dev server runs as bg-1 and the build finished.', after: 'You stopped it.' } as const;
