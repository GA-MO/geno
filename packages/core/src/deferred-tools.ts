import type { Tool } from '@anthropic-ai/sdk/resources/messages/messages';
import type { TurnEvent } from './session.js';

export const TOOL_SEARCH_TOOL = 'tool_search';

/** The tools the loop uses nearly every turn. They are always sent in full; every other tool may be deferred. */
export const CORE_TOOL_NAMES: ReadonlySet<string> = new Set(['agent', 'ask_user', 'bash', 'check', 'edit', 'glob', 'grep', 'list', 'read', 'todo']);

/** Follows the mode's system prompt in a run that defers tools; fixed text, so the cached prefix holds. */
export const DEFERRED_TOOLS_NOTE = `Some of your tools are listed by name only, in the description of ${TOOL_SEARCH_TOOL}. Before the first call of one, load it with ${TOOL_SEARCH_TOOL}; it then stays callable for the rest of the session.`;

/** A tool sent by name and hint only, until `tool_search` loads its definition into the conversation. */
export type DeferredTool = { readonly definition: Tool; readonly hint: string };

/**
 * What one run offers the model. `offered` is the request's `tools`, the same on every call, so loading a tool never
 * moves the cached prefix: the definition reaches the model in the tool_search result instead. `deferred` is sorted by
 * name and empty when nothing is deferred, in which case `offered` is the input unchanged.
 */
export type ToolRoster = { readonly offered: readonly Tool[]; readonly deferred: ReadonlyMap<string, DeferredTool> };

/** Measured on Model Studio qwen3.8-flash over Geno's own and the browser's definitions by scripts/prefix-tokens.ts. */
const CHARS_PER_TOKEN = 3.5;

const textTokens = (text: string): number => Math.ceil(text.length / CHARS_PER_TOKEN);
const toolTokens = (tool: Tool): number => textTokens(JSON.stringify(tool));

/**
 * Deferring pays when the tokens it takes out of every call, net of tool_search and the note, outweigh the turns that
 * loads cost. On the eval tasks a load is rare and a call carries about 9k tokens, so the break-even is far lower than
 * this; the margin keeps a lone small tool in full, where tool_search would cost about as much as it saves (docs/u46.md).
 */
export const MIN_SAVED_TOKENS = 300;

/** The deferred block stays within this many characters; past it, tools are counted and still found by query. */
export const MAX_BLOCK_CHARS = 8192;

const MAX_HINT_CHARS = 90;

/** The first sentence of a description, cut to a line. */
export function hintOf(description: string | undefined): string {
  const flat = (description ?? '').replace(/\s+/g, ' ').trim();
  const sentence = /^(.+?[.!?])(\s|$)/.exec(flat)?.[1] ?? flat;
  if (sentence.length <= MAX_HINT_CHARS) return sentence;
  const cut = sentence.slice(0, MAX_HINT_CHARS - 3);
  return `${cut.slice(0, cut.lastIndexOf(' ') > 0 ? cut.lastIndexOf(' ') : cut.length)}...`;
}

function blockText(deferred: ReadonlyMap<string, DeferredTool>): string {
  const lines: string[] = [];
  let size = 0;
  let omitted = 0;
  for (const [name, { hint }] of deferred) {
    const line = `- ${name}: ${hint}`;
    if (omitted > 0 || size + line.length + 1 > MAX_BLOCK_CHARS) omitted++;
    else {
      lines.push(line);
      size += line.length + 1;
    }
  }
  if (omitted > 0) lines.push(`- ... and ${omitted} more tools, found with query`);
  return lines.join('\n');
}

export const toolSearchDefinition = (deferred: ReadonlyMap<string, DeferredTool>): Tool => ({
  name: TOOL_SEARCH_TOOL,
  description: `Load the full definitions of the tools listed below by name only. A listed tool cannot be called until it is loaded; once loaded it stays callable for the rest of the session, so load each tool once. Pass select with exact names when you know them, or query with a few words to search the names and descriptions. The tools:\n${blockText(deferred)}`,
  input_schema: {
    type: 'object',
    properties: {
      select: { type: 'array', items: { type: 'string' }, description: 'Exact tool names to load, such as ["bash_output"].' },
      query: { type: 'string', description: 'Words to search for, such as "browser screenshot". Loads the best matches.' },
    },
    additionalProperties: false,
  },
});

const deferredOf = (tools: readonly Tool[]): ReadonlyMap<string, DeferredTool> =>
  new Map(
    tools
      .filter((tool) => !CORE_TOOL_NAMES.has(tool.name))
      .toSorted((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
      .map((definition): [string, DeferredTool] => [definition.name, { definition, hint: hintOf(definition.description) }]),
  );

/** The tokens deferring `tools` would take out of every call, net of tool_search and the note, by the roster's estimate. */
export function deferredSavings(tools: readonly Tool[]): number {
  const deferred = deferredOf(tools);
  if (deferred.size === 0) return 0;
  return [...deferred.values()].reduce((sum, { definition }) => sum + toolTokens(definition), 0) - toolTokens(toolSearchDefinition(deferred)) - textTokens(DEFERRED_TOOLS_NOTE);
}

/** Splits `tools` into the core and the deferred, and sends tool_search last in place of the deferred. */
export function toolRoster(tools: readonly Tool[], minSavedTokens: number = MIN_SAVED_TOKENS): ToolRoster {
  const deferred = deferredOf(tools);
  if (deferred.size === 0 || deferredSavings(tools) < minSavedTokens) return { offered: tools, deferred: new Map() };
  return { offered: [...tools.filter((tool) => CORE_TOOL_NAMES.has(tool.name)), toolSearchDefinition(deferred)], deferred };
}

/** The tools tool_search loaded so far, from the log, so a resumed or replayed session can call the same ones. */
export const loadedTools = (events: readonly TurnEvent[]): ReadonlySet<string> =>
  new Set(events.flatMap((event) => (event.kind === 'tool-result' && event.status === 'ok' ? (event.loaded ?? []) : [])));

export type ToolSearchInput = { readonly select?: readonly string[] | undefined; readonly query?: string | undefined };

/** What one search loads, and the text its result shows the model. An empty `loaded` is an error result. */
export type ToolSearchResult = { readonly loaded: readonly string[]; readonly text: string };

const MAX_QUERY_MATCHES = 5;

const wordsOf = (text: string): string[] => text.toLowerCase().split(/[^a-z0-9]+/).filter((word) => word.length > 1);

function matches(deferred: ReadonlyMap<string, DeferredTool>, query: string): string[] {
  const words = wordsOf(query);
  const scored = [...deferred].flatMap(([name, { definition }]) => {
    const inName = wordsOf(name);
    const inText = new Set(wordsOf(definition.description ?? ''));
    const score = words.reduce((sum, word) => sum + (inName.includes(word) ? 3 : 0) + (inName.some((part) => part.startsWith(word)) ? 1 : 0) + (inText.has(word) ? 1 : 0), 0);
    return score > 0 ? [{ name, score }] : [];
  });
  return scored
    .toSorted((a, b) => b.score - a.score || (a.name < b.name ? -1 : 1))
    .slice(0, MAX_QUERY_MATCHES)
    .map(({ name }) => name);
}

const shown = ({ name, description, input_schema }: Tool): string => JSON.stringify({ name, description, input_schema });

export function searchTools(deferred: ReadonlyMap<string, DeferredTool>, input: ToolSearchInput): ToolSearchResult {
  const selected = input.select ?? [];
  const unknown = selected.filter((name) => !deferred.has(name));
  const picked = [...new Set([...selected.filter((name) => deferred.has(name)), ...(input.query === undefined ? [] : matches(deferred, input.query))])];
  const notes = [
    ...(unknown.length === 0 ? [] : [`Not deferred tools: ${unknown.join(', ')}. Use the names listed in the tool_search description.`]),
    ...(selected.length === 0 && input.query === undefined ? ['Pass select or query.'] : []),
    ...(picked.length === 0 && input.query !== undefined ? [`No deferred tool matches "${input.query}".`] : []),
  ];
  if (picked.length === 0) return { loaded: [], text: notes.join('\n') };
  const definitions = picked.map((name) => shown(deferred.get(name)!.definition));
  const text = [`Loaded ${picked.length === 1 ? 'this tool' : `these ${picked.length} tools`}. Call ${picked.length === 1 ? 'it' : 'them'} directly from now on, with input that matches the input_schema:`, ...definitions, ...notes].join('\n');
  return { loaded: picked, text };
}

/** Why a call to a deferred tool cannot run yet, or undefined when it can. */
export const unloadedCallError = (deferred: ReadonlyMap<string, DeferredTool>, loaded: ReadonlySet<string>, name: string): string | undefined =>
  deferred.has(name) && !loaded.has(name)
    ? `${name} is a deferred tool and is not loaded yet. Call ${TOOL_SEARCH_TOOL} with select: ["${name}"] first, then call ${name} with the input its schema asks for.`
    : undefined;

type Schema = { readonly type?: unknown; readonly properties?: Readonly<Record<string, Schema>>; readonly items?: Schema };

const SCALARS: Readonly<Record<string, (text: string) => unknown>> = {
  number: (text) => (text.trim() !== '' && Number.isFinite(Number(text)) ? Number(text) : text),
  integer: (text) => (/^\s*-?\d+\s*$/.test(text) ? Number(text) : text),
  boolean: (text) => (/^true$/i.test(text) ? true : /^false$/i.test(text) ? false : text),
};

/**
 * A deferred tool's schema reaches the model as text, not in `tools`, and Model Studio's Qwen then writes some numbers
 * and booleans as strings ("2", "False"; docs/u46.md). This turns such a string into the type its schema names, through
 * nested objects and arrays, and leaves everything else as the model wrote it for the tool to judge.
 */
export function coerceToSchema(raw: unknown, value: unknown): unknown {
  if (typeof raw !== 'object' || raw === null) return value;
  const schema = raw as Schema;
  const type = typeof schema.type === 'string' ? schema.type : undefined;
  if (typeof value === 'string' && type !== undefined && type in SCALARS) return SCALARS[type]!(value);
  if (Array.isArray(value)) return schema.items === undefined ? value : value.map((item) => coerceToSchema(schema.items, item));
  if (typeof value === 'object' && value !== null && schema.properties !== undefined) {
    const properties = schema.properties;
    return Object.fromEntries(Object.entries(value).map(([key, field]) => [key, Object.hasOwn(properties, key) ? coerceToSchema(properties[key], field) : field]));
  }
  return value;
}
