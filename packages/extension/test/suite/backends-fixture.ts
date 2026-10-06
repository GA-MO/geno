/** The backends fixture, shared by the suite inside VS Code and the test that writes the fake Cursor agent. */

export const FILES = { 'a.ts': 'one\ntwo\nthree\n' } as const;

/** The edit the fake agent makes in its lane, and the main checkout gets back through Apply. */
export const EDITED = 'one\nTWO\nthree\n';

/** Its first words name the lane the agent works in. */
export const PROMPT = 'Read and edit a.ts';
export const LANE = 'read-and-edit-a-ts';

/** The fake agent's model list, as CURSOR_SETUP offers it. */
export const MODELS = ['Auto', 'composer-2.5', 'grok-4.7'] as const;
export const SWITCHED = { name: 'grok-4.7', value: 'grok-4.7[fast=true]' } as const;

export const ANSWER = 'Made two loud.';
