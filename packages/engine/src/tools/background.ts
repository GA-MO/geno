import { z } from 'zod';
import { jobEndText, type EndedJobState } from '@g-code/core';
import type { BackgroundJobs } from '../background.js';
import { executor, optional, ToolError, type Executor } from './context.js';

/** The session's background commands, for the tools that start, read and stop them. */
export type SessionBackground = { readonly jobs: BackgroundJobs; readonly sessionId: string };

export const NO_BACKGROUND = 'background commands are not available here: a subagent ends with its call. Run the command in the foreground.';

const idInput = { id: z.string().min(1) };

export function backgroundExecutors(background: SessionBackground | undefined): { readonly bash_output: Executor; readonly bash_stop: Executor } {
  const own = (): SessionBackground => {
    if (background === undefined) throw new ToolError(NO_BACKGROUND);
    return background;
  };
  return {
    bash_output: executor({
      input: z.strictObject({ ...idInput, tail: optional(z.number().int().positive().max(1000)) }),
      describe: ({ id }) => `bash_output ${id}`,
      // It reads what the command printed so far and changes nothing.
      concurrent: () => true,
      async run({ id, tail }) {
        const { jobs, sessionId } = own();
        return jobs.output(sessionId, id, tail);
      },
    }),
    bash_stop: executor({
      input: z.strictObject(idInput),
      describe: ({ id }) => `bash_stop ${id}`,
      async run({ id }) {
        const { jobs, sessionId } = own();
        const job = await jobs.stop(sessionId, id, 'model');
        const tail = jobs.output(sessionId, id, 20).split('\n').slice(1).join('\n');
        return `${id} ${jobEndText(job.state as EndedJobState)}.\n${tail}`;
      },
    }),
  };
}
