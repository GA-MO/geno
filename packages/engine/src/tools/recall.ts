import { z } from 'zod';
import { RECALL_TOOL, recallText, searchCompacted, type SessionHit } from '@g-code/core';
import { ALWAYS, executor, type Executor } from './context.js';

/** Searches the session's workspace for the query, the session itself left out. */
export type Recall = (query: string) => Promise<readonly SessionHit[]>;

const QUERY_MAX = 200;

/**
 * `recall`: reads the compacted part of this session and earlier sessions, and changes nothing, so it runs beside
 * other calls and asks nobody. `recall` is undefined where no earlier session is searched, as in a subagent, which
 * still searches its own compacted part.
 */
export function recallExecutor(recall: Recall | undefined): Executor {
  return executor({
    input: z.strictObject({ query: z.string().trim().min(1, 'recall needs a query of a few words').max(QUERY_MAX) }),
    concurrent: ALWAYS,
    describe: ({ query }) => `${RECALL_TOOL} ${query}`,
    async run({ query }, ctx) {
      return recallText(query, recall === undefined ? [] : await recall(query), searchCompacted(ctx.events(), query));
    },
  });
}
