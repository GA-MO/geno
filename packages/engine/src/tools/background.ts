import { z } from 'zod';
import type { BackgroundJobs } from '../background.js';
import { executor, optional, ToolError, type Executor } from './context.js';

/** The session's background commands, for the tools that start, read, list and stop them. */
export type SessionBackground = { readonly jobs: BackgroundJobs; readonly sessionId: string };

export const NO_BACKGROUND = 'background commands are not available here: a subagent ends with its call. Run the command in the foreground.';

export function backgroundExecutors(background: SessionBackground | undefined): { readonly bash_output: Executor } {
  const own = (): SessionBackground => {
    if (background === undefined) throw new ToolError(NO_BACKGROUND);
    return background;
  };
  return {
    bash_output: executor({
      input: z.strictObject({ id: z.string().min(1), tail: optional(z.number().int().positive().max(1000)) }),
      describe: ({ id }) => `bash_output ${id}`,
      // It reads what the command printed so far and changes nothing.
      concurrent: () => true,
      async run({ id, tail }) {
        const { jobs, sessionId } = own();
        return jobs.output(sessionId, id, tail);
      },
    }),
  };
}
