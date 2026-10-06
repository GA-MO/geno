/** The wake fixture's files, prompts and the fake model's replies, shared by the suite and the test that launches it. */
export const FILES = { 'a.ts': 'export const a = 1;\n' } as const;

export const PROMPT = 'Build the project in the background';

/** Waits for the suite to write `go`, so the build ends exactly when the suite says. */
export const BUILD = 'while [ ! -f go ]; do sleep 0.1; done; echo "built in 1.0s"';

export const CALL = { narration: 'Building in the background.', id: 'tu_wake_build', name: 'bash', input: { command: BUILD, description: 'Build the project', run_in_background: true } } as const;

export const ANSWERS = { first: 'The build runs as bg-1; I will look when it ends.', woken: 'The build finished in 1.0s.' } as const;

export const DRAFT = 'one more thing';
