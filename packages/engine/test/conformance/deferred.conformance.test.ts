import { describe, expect, it } from 'vitest';
import type { FakeToolUse } from '../fake-transport.js';
import { call, say, scripted, WIRES, type SeenResult, type Wire } from './scripted.js';

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
    const both = search({ query: 'select:bash_output,task_stop' });
    const mixed = search({ query: 'select:bash_output,no_such_tool' });
    const unknown = search({ query: 'select:no_such_tool' });
    const result = await searched(wire, [both, mixed, unknown]);

    expect(result(both).error).toBe(false);
    expect(loadedNames(result(both))).toEqual(['bash_output', 'task_stop']);
    expect(result(mixed).error).toBe(false);
    expect(loadedNames(result(mixed))).toEqual(['bash_output']);
    expect(result(mixed).text).toMatch(/Not deferred tools: no_such_tool\./);
    expect(result(unknown), 'nothing to load is still an error, so the model learns the name is wrong').toMatchObject({ error: true, text: expect.stringMatching(/no_such_tool/) });
  });

  it('T-DEFER-04 a +word query loads only tools whose name has the word, best match to the rest first', async () => {
    const required = search({ query: '+stop task' });
    const result = await searched(wire, [required]);
    expect(result(required).error).toBe(false);
    const names = loadedNames(result(required));
    expect(names[0]).toBe('task_stop');
    expect(names.length).toBeGreaterThan(0);
    expect(names.every((name) => name.includes('stop')), names.join(', ')).toBe(true);
  });
});

describe.each(WIRES)('a deferred tool called before tool_search on the %s wire', (wire) => {
  /** One non-interactive turn in which the model makes each call in its own step: the results, and the session log. */
  async function called(calls: readonly FakeToolUse[]) {
    const run = await scripted(wire, [...calls.map((use) => call('', [use])), say('Done.')]);
    const { code, stdout } = await run.cli(['agent', '--workspace', run.workspace, '--non-interactive', 'Go.']);
    expect(code).toBe(0);
    const byId = new Map(run.seen().flatMap((request) => request.results.map((result) => [result.id, result] as const)));
    const results = (await run.log(stdout)).flatMap((e) => (e.kind === 'tool-result' ? [e] : []));
    return { result: (use: FakeToolUse) => byId.get(use.id)!, logged: (use: FakeToolUse) => results.find((e) => e.toolUseId === use.id)! };
  }

  it('T-DEFER-05 runs when its input is valid, shows its definition once, and stays loaded', async () => {
    const first = { id: 'tu_list_1', name: 'list_agents', input: {} };
    const again = { id: 'tu_list_2', name: 'list_agents', input: {} };
    const { result, logged } = await called([first, again]);

    expect(result(first).error).toBe(false);
    expect(result(first).text).toMatch(/^You called list_agents before loading it with tool_search\. Geno loaded it for this call/);
    expect(loadedNames(result(first))).toEqual(['list_agents']);
    expect(logged(first)).toMatchObject({ status: 'ok', loaded: ['list_agents'] });
    expect(result(again).error).toBe(false);
    expect(result(again).text, 'the second call is an ordinary call of a loaded tool').not.toMatch(/before loading it|"name":"list_agents"/);
    expect(logged(again).loaded).toBeUndefined();
  });

  it('T-DEFER-06 runs nothing when its input is invalid, and answers with the definition and what was wrong', async () => {
    const wrong = { id: 'tu_wake', name: 'schedule_wakeup', input: { delay: 60 } };
    const list = { id: 'tu_list', name: 'list_agents', input: {} };
    const { result, logged } = await called([wrong, list]);

    expect(result(wrong).error).toBe(true);
    expect(result(wrong).text).toMatch(/^You called schedule_wakeup before loading it with tool_search\. Its input does not match the input_schema, so it did not run: /);
    expect(result(wrong).text).toMatch(/delay_s/);
    expect(loadedNames(result(wrong))).toEqual(['schedule_wakeup']);
    expect(logged(wrong)).toMatchObject({ status: 'error' });
    expect(result(list).text, 'no wake-up was scheduled').not.toMatch(/wake-1/);
  });

  it('T-DEFER-07 keeps its approval: a fetch that needs the user is refused when nobody can answer, and loads nothing', async () => {
    const fetch = { id: 'tu_fetch', name: 'web_fetch', input: { url: 'https://example.com/docs', question: 'What does it say?' } };
    const { result, logged } = await called([fetch]);

    expect(result(fetch)).toMatchObject({ error: true, text: expect.stringMatching(/^denied: .*example\.com.*nobody can answer here\./) });
    expect(logged(fetch)).toMatchObject({ status: 'denied', approval: { verdict: 'deny' } });
    expect(logged(fetch).loaded).toBeUndefined();
  });
});
