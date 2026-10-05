/** How many tool uses of one turn run at once. */
export const MAX_CONCURRENT_TOOLS = 8;

/**
 * A turn's tool uses run as consecutive batches, one after another: either a run of up to MAX_CONCURRENT_TOOLS uses
 * that change nothing and ask nobody, which run at the same time, or one other use alone. `start` and `end` index the
 * turn's uses, end exclusive. Results are logged in the turn's order whatever order the batch finishes in.
 */
export type ToolBatch = { readonly start: number; readonly end: number };

/**
 * The batch that begins at `start` of a turn's `count` uses. `concurrent` is asked as the batch forms, so a mode switch
 * or an "allow for the session" from an earlier batch counts.
 */
export function nextToolBatch(count: number, start: number, concurrent: (index: number) => boolean, limit = MAX_CONCURRENT_TOOLS): ToolBatch {
  if (!concurrent(start)) return { start, end: start + 1 };
  let end = start + 1;
  while (end < count && end - start < limit && concurrent(end)) end++;
  return { start, end };
}
