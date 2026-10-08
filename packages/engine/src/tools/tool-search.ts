import { z } from 'zod';
import { coerceToSchema, loadedTools, offersToolSearch, searchTools, TOOL_SEARCH_TOOL, unloadedCallError, type ToolRoster, type TurnEvent } from '@g-code/core';
import { ALWAYS, executor, ToolError, type Executor } from './context.js';
import type { Executors } from './index.js';

const searchInput = z.strictObject({ select: z.array(z.string().min(1)).optional(), query: z.string().min(1).optional() });

/** A call the user issued, such as `/workflow`'s, needs no load: the user names the tool, not the model. */
const issuedByUser = (events: readonly TurnEvent[], toolUseId: string | undefined): boolean =>
  toolUseId !== undefined && events.some((e) => e.kind === 'assistant' && e.issuedBy === 'user' && e.content.some((block) => block.type === 'tool_use' && block.id === toolUseId));

/** A deferred tool's executor: refused until loaded, and its input typed by its schema (`coerceToSchema`). */
function gate(roster: ToolRoster, name: string, inner: Executor): Executor {
  const typed = (raw: unknown) => coerceToSchema(roster.deferred.get(name)!.definition.input_schema, raw);
  return {
    input: inner.input,
    ...(inner.concurrent === undefined ? {} : { concurrent: (raw: unknown) => inner.concurrent!(typed(raw)) }),
    describe: (raw) => inner.describe(typed(raw)),
    async run(raw, ctx) {
      const refused = issuedByUser(ctx.events(), ctx.toolUseId) ? undefined : unloadedCallError(roster.deferred, loadedTools(ctx.events()), name);
      if (refused !== undefined) throw new ToolError(refused);
      return inner.run(typed(raw), ctx);
    },
  };
}

/**
 * The roster's executors: `tool_search`, and each deferred tool refusing to run until a tool_search in the log loaded
 * it. The log is what decides, so a resumed session can call what it loaded before.
 */
export function rosterExecutors(roster: ToolRoster, executors: Executors): Executors {
  if (!offersToolSearch(roster)) return executors;
  const gated = Object.fromEntries(
    Object.entries(executors).map(([name, inner]): [string, Executor] => [name, roster.deferred.has(name) ? gate(roster, name, inner) : inner]),
  );
  const search = executor({
    concurrent: ALWAYS,
    input: searchInput,
    describe: ({ select, query }) => `${TOOL_SEARCH_TOOL} ${[...(select ?? []), ...(query === undefined ? [] : [JSON.stringify(query)])].join(' ')}`,
    async run(input) {
      const { loaded, text } = searchTools(roster.deferred, input);
      if (loaded.length === 0) throw new ToolError(text);
      return { text, loaded };
    },
  });
  return { ...gated, [TOOL_SEARCH_TOOL]: search };
}
