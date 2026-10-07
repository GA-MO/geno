import { afterEach, describe, expect, it } from 'vitest';
import type { FakeToolUse } from '../fake-transport.js';
import { call, closeServers, say, scripted, WIRES, type SeenResult, type Wire } from './scripted.js';

afterEach(closeServers);

let ids = 0;
const search = (input: Readonly<Record<string, unknown>>): FakeToolUse => ({ id: `tu_search_${ids++}`, name: 'tool_search', input });

/** The results of one non-interactive turn in which the model makes each tool_search call in its own step. */
async function searched(wire: Wire, calls: readonly FakeToolUse[]): Promise<(use: FakeToolUse) => SeenResult> {
  const run = await scripted(wire, [...calls.map((use) => call('', [use])), say('Done.')]);
  expect((await run.cli(['agent', '--workspace', run.workspace, '--non-interactive', 'Load them.'])).code).toBe(0);
  const byId = new Map(run.seen().flatMap((request) => request.results.map((result) => [result.id, result] as const)));
  return (use) => byId.get(use.id)!;
}

/** The names of the tool definitions a tool_search result loaded. */
const loadedNames = (result: SeenResult): string[] => [...result.text.matchAll(/^\{"name":"([^"]+)"/gm)].map((match) => match[1]!);

describe.each(WIRES)('tool_search on the %s wire', (wire) => {
  it('T-DEFER-03 a select:A,B query loads the named tools, and an unknown name among them is skipped with a note, not an error', async () => {
    const both = search({ query: 'select:bash_output,bash_stop' });
    const mixed = search({ query: 'select:bash_output,no_such_tool' });
    const unknown = search({ query: 'select:no_such_tool' });
    const result = await searched(wire, [both, mixed, unknown]);

    expect(result(both).error).toBe(false);
    expect(loadedNames(result(both))).toEqual(['bash_output', 'bash_stop']);
    expect(result(mixed).error).toBe(false);
    expect(loadedNames(result(mixed))).toEqual(['bash_output']);
    expect(result(mixed).text).toMatch(/Not deferred tools: no_such_tool\./);
    expect(result(unknown), 'nothing to load is still an error, so the model learns the name is wrong').toMatchObject({ error: true, text: expect.stringMatching(/no_such_tool/) });
  });

  it('T-DEFER-04 a +word query loads only tools whose name has the word, best match to the rest first', async () => {
    const required = search({ query: '+bash stop' });
    const result = await searched(wire, [required]);
    expect(result(required).error).toBe(false);
    const names = loadedNames(result(required));
    expect(names[0]).toBe('bash_stop');
    expect(names.length).toBeGreaterThan(0);
    expect(names.every((name) => name.includes('bash')), names.join(', ')).toBe(true);
  });
});
