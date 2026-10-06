import type { Tool } from '@anthropic-ai/sdk/resources/messages/messages';
import { describe, expect, it } from 'vitest';
import { AGENT_MODE_TOOL_DEFINITIONS } from '../src/agent.js';
import { BROWSER_TOOLS } from '../src/browser-tools.generated.js';
import {
  coerceToSchema,
  hintOf,
  loadedTools,
  MAX_BLOCK_CHARS,
  searchTools,
  toolRoster,
  TOOL_SEARCH_TOOL,
  unloadedCallError,
} from '../src/deferred-tools.js';
import { mcpCatalog, mcpToolDefinitions } from '../src/mcp.js';
import type { TurnEvent } from '../src/session.js';

const tool = (name: string, description = `The ${name} tool. It does ${name} things.`, padding = 0): Tool => ({
  name,
  description: `${description}${' '.repeat(padding)}`,
  input_schema: { type: 'object', properties: { x: { type: 'string' } } },
});

const names = (tools: readonly Tool[]) => tools.map((t) => t.name);
const core = ['read', 'grep', 'glob', 'list', 'edit', 'bash', 'check', 'ask_user', 'agent'].map((name) => tool(name));
const browser = mcpToolDefinitions(mcpCatalog(BROWSER_TOOLS));

describe('tool roster', () => {
  it.each([
    { case: 'only core tools', tools: core, offered: names(core), deferred: [] },
    { case: 'one small rare tool, which tool_search would cost as much as it saves', tools: [...core, tool('remember')], offered: [...names(core), 'remember'], deferred: [] },
    {
      case: 'large rare tools',
      tools: [...core, tool('show_widget', 'Draw a widget.', 2000), tool('monitor', 'Watch a command.', 1000)],
      offered: [...names(core), TOOL_SEARCH_TOOL],
      deferred: ['monitor', 'show_widget'],
    },
    { case: 'the browser', tools: [...core, ...browser], offered: [...names(core), TOOL_SEARCH_TOOL], deferred: names(browser).toSorted() },
  ])('$case', ({ tools, offered, deferred }) => {
    const roster = toolRoster(tools);
    expect(names(roster.offered)).toEqual(offered);
    expect([...roster.deferred.keys()]).toEqual(deferred);
  });

  it('sends the input unchanged when nothing is deferred, so a run without deferral keeps its old prefix', () => {
    const tools = [...core, tool('remember')];
    expect(toolRoster(tools).offered).toBe(tools);
  });

  it('defers what eval runs offer beyond the core: background reads and stops, wakes and skill', () => {
    const roster = toolRoster(AGENT_MODE_TOOL_DEFINITIONS['non-interactive']);
    expect([...roster.deferred.keys()]).toEqual(['bash_output', 'bash_stop', 'monitor', 'schedule_wakeup', 'skill']);
    expect(names(roster.offered)).toEqual(['bash', 'check', 'edit', 'glob', 'grep', 'list', 'read', 'todo', TOOL_SEARCH_TOOL]);
  });

  it('writes the same tool_search bytes whatever order the tools arrive in', () => {
    const tools = [...core, ...browser];
    const a = toolRoster(tools).offered.at(-1);
    const b = toolRoster(tools.toReversed()).offered.find((t) => t.name === TOOL_SEARCH_TOOL);
    expect(JSON.stringify(b)).toBe(JSON.stringify(a));
    expect(a?.description).toContain('- mcp__browser__click: Clicks on the provided element');
  });

  it('keeps the block within its budget and counts what it leaves out', () => {
    const many = Array.from({ length: 400 }, (_, i) => tool(`mcp__srv__tool_${String(i).padStart(3, '0')}`, 'A tool with a long enough description to fill the line well past the hint.'));
    const search = toolRoster([...core, ...many]).offered.at(-1)!;
    const block = search.description!.slice(search.description!.indexOf('The tools:\n') + 'The tools:\n'.length);
    expect(block.length).toBeLessThanOrEqual(MAX_BLOCK_CHARS + 60);
    expect(block).toMatch(/- \.\.\. and \d+ more tools, found with query$/);
  });
});

describe('hints', () => {
  it.each([
    ['Clicks on the provided element', 'Clicks on the provided element'],
    ['Read a file. Returns its lines with numbers.', 'Read a file.'],
    ['  Spaced\n  out.  More.', 'Spaced out.'],
    [undefined, ''],
    [`${'word '.repeat(40)}end.`, `${'word '.repeat(17).trimEnd()}...`],
  ])('%j -> %j', (description, hint) => {
    expect(hintOf(description)).toBe(hint);
  });
});

describe('tool_search', () => {
  const { deferred } = toolRoster([...core, ...browser]);

  it.each([
    { case: 'select by exact name', input: { select: ['mcp__browser__navigate_page'] }, loaded: ['mcp__browser__navigate_page'] },
    { case: 'select twice the same', input: { select: ['mcp__browser__click', 'mcp__browser__click'] }, loaded: ['mcp__browser__click'] },
    { case: 'a core tool is not deferred', input: { select: ['read'] }, loaded: [] },
    { case: 'query by words', input: { query: 'screenshot' }, loaded: ['mcp__browser__take_screenshot'] },
    { case: 'query that matches nothing', input: { query: 'kubernetes' }, loaded: [] },
    { case: 'neither select nor query', input: {}, loaded: [] },
  ])('$case', ({ input, loaded }) => {
    expect(searchTools(deferred, input).loaded.slice(0, Math.max(loaded.length, 1))).toEqual(loaded.length === 0 ? [] : loaded);
  });

  it('returns each loaded definition in full', () => {
    const { text } = searchTools(deferred, { select: ['mcp__browser__navigate_page'] });
    const definition = deferred.get('mcp__browser__navigate_page')!.definition;
    expect(text).toContain(JSON.stringify({ name: definition.name, description: definition.description, input_schema: definition.input_schema }));
  });

  it('names what it could not load', () => {
    expect(searchTools(deferred, { select: ['read', 'mcp__browser__click'] }).text).toContain('Not deferred tools: read.');
  });
});

describe('loaded tools', () => {
  const result = (seq: number, loaded: string[] | undefined, status: 'ok' | 'error' = 'ok'): TurnEvent => ({
    kind: 'tool-result',
    seq,
    at: '',
    toolUseId: `t${seq}`,
    name: TOOL_SEARCH_TOOL,
    status,
    output: '',
    ...(loaded === undefined ? {} : { loaded }),
  });

  it.each([
    { case: 'no loads', events: [], loaded: [] },
    { case: 'two loads add up', events: [result(1, ['a']), result(2, ['b', 'a'])], loaded: ['a', 'b'] },
    { case: 'a failed search loads nothing', events: [result(1, ['a'], 'error')], loaded: [] },
    { case: 'other results load nothing', events: [result(1, undefined)], loaded: [] },
  ])('$case', ({ events, loaded }) => {
    expect([...loadedTools(events)].sort()).toEqual(loaded);
  });

  it('refuses a deferred tool until it is loaded, with what to call instead', () => {
    const { deferred } = toolRoster([...core, ...browser]);
    expect(unloadedCallError(deferred, new Set(), 'mcp__browser__click')).toBe(
      'mcp__browser__click is a deferred tool and is not loaded yet. Call tool_search with select: ["mcp__browser__click"] first, then call mcp__browser__click with the input its schema asks for.',
    );
    expect(unloadedCallError(deferred, new Set(['mcp__browser__click']), 'mcp__browser__click')).toBeUndefined();
    expect(unloadedCallError(deferred, new Set(), 'read')).toBeUndefined();
  });
});

describe("input typed by a deferred tool's schema", () => {
  const schema = {
    type: 'object',
    properties: {
      pageId: { type: 'number' },
      count: { type: 'integer' },
      verbose: { type: 'boolean' },
      url: { type: 'string' },
      ids: { type: 'array', items: { type: 'number' } },
      nested: { type: 'object', properties: { on: { type: 'boolean' } } },
    },
  };
  it.each([
    { case: 'a number written as a string', input: { pageId: '2' }, typed: { pageId: 2 } },
    { case: 'a boolean in any case', input: { verbose: 'False' }, typed: { verbose: false } },
    { case: 'an integer', input: { count: ' 7 ' }, typed: { count: 7 } },
    { case: 'not an integer stays as written', input: { count: '7.5' }, typed: { count: '7.5' } },
    { case: 'not a number stays as written', input: { pageId: 'two' }, typed: { pageId: 'two' } },
    { case: 'an empty string stays', input: { pageId: '' }, typed: { pageId: '' } },
    { case: 'a string field is left alone', input: { url: '2' }, typed: { url: '2' } },
    { case: 'array items', input: { ids: ['1', 2] }, typed: { ids: [1, 2] } },
    { case: 'nested objects', input: { nested: { on: 'true' } }, typed: { nested: { on: true } } },
    { case: 'unknown fields stay', input: { other: '3' }, typed: { other: '3' } },
    { case: 'right types stay', input: { pageId: 2, verbose: true }, typed: { pageId: 2, verbose: true } },
  ])('$case', ({ input, typed }) => {
    expect(coerceToSchema(schema, input)).toEqual(typed);
  });
});
