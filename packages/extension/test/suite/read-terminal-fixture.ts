/** The read_terminal fixture's command, its made-up secret and the prompt, shared by the suite and the test that launches it. */
export const FAKE_SECRET = `sk-gcodetest${'FAKE'.repeat(5)}`;

export const EXIT_CODE = 3;

export const FAILURE = 'build failed: cannot find module ./config';

/** A command the user types: it prints the secret, then fails with a message on stderr. */
export const COMMAND = `echo "deploy key ${FAKE_SECRET}" && sh -c 'echo "${FAILURE}" >&2; exit ${EXIT_CODE}'`;

export const TERMINAL_NAME = 'geno-shell';

export const PROMPT = 'the command I just ran failed';

export const ANSWER = 'The build could not find ./config.';
