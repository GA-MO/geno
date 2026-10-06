import { z } from 'zod';
import { RECALL_TOOL, recallText, type SessionHit } from '@g-code/core';
import { ALWAYS, executor, ToolError, type Executor } from './context.js';

/** Searches the session's workspace for the query, the session itself left out. */
export type Recall = (query: string) => Promise<readonly SessionHit[]>;

const QUERY_MAX = 200;

/** `recall`: reads earlier sessions and changes nothing, so it runs beside other calls and asks nobody. Undefined where no session is searched from. */
export function recallExecutor(recall: Recall | undefined): Executor {
  return executor({
    input: z.strictObject({ query: z.string().trim().min(1, 'recall needs a query of a few words').max(QUERY_MAX) }),
    concurrent: ALWAYS,
    describe: ({ query }) => `${RECALL_TOOL} ${query}`,
    async run({ query }) {
      if (recall === undefined) throw new ToolError(`${RECALL_TOOL} is not available here: there is no session to search from.`);
      return recallText(query, await recall(query));
    },
  });
}
