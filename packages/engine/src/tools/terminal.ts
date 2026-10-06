import { z } from 'zod';
import { TERMINAL_LIMITS, terminalReadText, type ReadTerminalRequest, type ReadTerminalResponse } from '@g-code/core';
import { executor, type Executor } from './context.js';

/** Reads the terminals of the editor that shows the session; rejects when no editor shows it. */
export type TerminalReader = (request: Omit<ReadTerminalRequest, 'sessionId'>) => Promise<ReadTerminalResponse>;

const summary = z.object({ index: z.number().int().positive(), name: z.string(), active: z.boolean(), shellIntegration: z.boolean(), commands: z.number().int().nonnegative() });
const exit = z.discriminatedUnion('state', [z.object({ state: z.literal('running') }), z.object({ state: z.literal('ended'), code: z.number().int().nullable() })]);
const command = z.object({ commandLine: z.string(), cwd: z.string().nullable(), exit, output: z.string(), omittedLines: z.number().int().nonnegative() });

export const readTerminalResponse = z.object({
  terminals: z.array(summary),
  read: z.discriminatedUnion('kind', [
    z.object({ kind: z.literal('commands'), terminal: summary, commands: z.array(command) }),
    z.object({ kind: z.literal('no-shell-integration'), terminal: summary }),
    z.object({ kind: z.literal('no-terminal') }),
    z.object({ kind: z.literal('not-found'), asked: z.string() }),
  ]),
}) satisfies z.ZodType<ReadTerminalResponse>;

const input = z.strictObject({
  terminal: z.string().min(1).optional(),
  commands: z.number().int().min(1).max(TERMINAL_LIMITS.maxCommands).optional(),
});

/** read_terminal, which reads the user's terminals through `reader`. It changes nothing and asks nobody. */
export const readTerminalExecutor = (reader: TerminalReader): Executor =>
  executor({
    input,
    concurrent: () => true,
    describe: ({ terminal }) => (terminal === undefined ? 'read_terminal' : `read_terminal ${terminal}`),
    async run({ terminal, commands }) {
      const response = await reader({ ...(terminal === undefined ? {} : { terminal }), commands: commands ?? TERMINAL_LIMITS.commands });
      return terminalReadText(response, terminal !== undefined);
    },
  });
