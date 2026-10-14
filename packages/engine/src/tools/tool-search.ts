import { z } from 'zod';
import { autoLoadedText, coerceToSchema, loadedTools, offersToolSearch, searchTools, TOOL_SEARCH_TOOL, unloadedInputError, type ToolRoster, type TurnEvent } from '@g-code/core';
import { ALWAYS, executor, ToolDenied, ToolError, ToolRejected, type Executor, type ToolReply } from './context.js';
import type { Executors } from './index.js';

const searchInput = z.strictObject({ select: z.array(z.string().min(1)).optional(), query: z.string().min(1).optional() });

/** A call the user issued, such as `/workflow`'s, needs no load: the user names the tool, not the model. */
const issuedByUser = (events: readonly TurnEvent[], toolUseId: string | undefined): boolean =>
  toolUseId !== undefined && events.some((e) => e.kind === 'assistant' && e.issuedBy === 'user' && e.content.some((block) => block.type === 'tool_use' && block.id === toolUseId));

/**
 * A deferred tool's executor, its input typed by its schema (`coerceToSchema`). A call before any tool_search loaded it
 * runs when its input parses, and its result records the load as tool_search's does and shows the definition; one
 * whose input does not parse runs nothing and shows the definition with what was wrong.
 */
function gate(roster: ToolRoster, name: string, inner: Executor): Executor {
  const definition = roster.deferred.get(name)!.definition;
  const typed = (raw: unknown) => coerceToSchema(definition.input_schema, raw);
  return {
    input: inner.input,
    ...(inner.concurrent === undefined ? {} : { concurrent: (raw: unknown) => inner.concurrent!(typed(raw)) }),
    describe: (raw) => inner.describe(typed(raw)),
    async run(raw, ctx) {
      const input = typed(raw);
      if (issuedByUser(ctx.events(), ctx.toolUseId) || loadedTools(ctx.events()).has(name)) return inner.run(input, ctx);
      const parsed = inner.input.safeParse(input);
      if (!parsed.success) throw new ToolError(unloadedInputError(definition, z.prettifyError(parsed.error)));
      let reply: ToolReply;
      try {
        reply = await inner.run(input, ctx);
      } catch (error) {
        // A refusal or a denial keeps its own class and approval record; a plain failure shows the definition too.
        if (error instanceof ToolError && !(error instanceof ToolRejected || error instanceof ToolDenied)) throw new ToolError(autoLoadedText(definition, error.message));
        throw error;
      }
      return typeof reply === 'string' ? { text: autoLoadedText(definition, reply), loaded: [name] } : { ...reply, text: autoLoadedText(definition, reply.text), loaded: [name] };
    },
  };
}

/**
 * The roster's executors: `tool_search`, and each deferred tool, gated by whether a result in the log loaded it. The
 * log is what decides, so a resumed session can call what it loaded before.
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
