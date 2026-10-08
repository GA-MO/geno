/** The stall suite's limits, shared by the suite inside VS Code and the test that launches it. */

/** The first try goes quiet after its thinking and is given up after this. */
export const IDLE_LIMIT_MS = 1500;

/** Longer than the 30 s the working row waits before it says a call has had no response. */
export const FIRST_BYTE_LIMIT_MS = 120_000;
