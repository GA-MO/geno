import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { NOT_USER_LINE, TODO_REMINDER_CALLS, type TodoList } from '@g-code/core';
import { memoryStore } from '../../src/memory.js';
import { homeOf } from '../../src/store.js';
import { call, say, scripted, sessionIdOf, WIRES, type Wire } from './scripted.js';

type Block = { readonly type: string; readonly text?: string; readonly cache_control?: unknown };
type Message = { readonly role: string; readonly content: string | readonly Block[] };
type Body = { readonly system?: readonly Block[]; readonly tools?: readonly unknown[]; readonly messages: readonly Message[] };

const textOf = (content: string | readonly Block[]): string => (typeof content === 'string' ? content : content.flatMap((b) => (b.text === undefined ? [] : [b.text])).join('\n'));

/** The system prompt as either wire sends it: Anthropic's system blocks, or Chat Completions' system message. */
const systemOf = (body: Body): string => (body.system !== undefined ? JSON.stringify(body.system) : JSON.stringify(body.messages.filter((m) => m.role === 'system')));

/** The conversation without the system message, and without the breakpoint that moves to the newest message on each call. */
const conversationOf = (body: Body): unknown[] =>
  body.messages
    .filter((m) => m.role !== 'system')
    .map((m) => ({ ...m, content: typeof m.content === 'string' ? m.content : m.content.map(({ cache_control: _, ...block }) => block) }));

const openingOf = (body: Body): string => textOf(body.messages.find((m) => m.role === 'user')!.content);
const newestOf = (body: Body): string => textOf(body.messages.at(-1)!.content);

/** Whether `later` repeats `earlier`'s whole request before its own new messages, which is what a cache read needs. */
function expectPrefix(earlier: Body, later: Body): void {
  expect(systemOf(later), 'the system prompt').toBe(systemOf(earlier));
  expect(JSON.stringify(later.tools), 'the tools').toBe(JSON.stringify(earlier.tools));
  const before = conversationOf(earlier);
  expect(conversationOf(later).slice(0, before.length), 'the earlier messages').toEqual(before);
}

describe.each(WIRES)('cache-stable session text on the %s wire', (wire: Wire) => {
  it('A/B-07, C/C-71 memory opens the first message as a snapshot, and a note added between runs arrives as a notice', async () => {
    const { workspace, cli, bodies, store } = await scripted(wire, [say('One.'), say('Two.')]);
    const memory = memoryStore(homeOf(store), workspace);
    await memory.add('Reply in plain English.', 'global', null);
    const id = sessionIdOf((await cli(['agent', '--workspace', workspace, 'Hi.'])).stdout);
    await memory.add('Prefer named exports.', 'project', null);
    expect((await cli(['agent', '--session', id, 'Again.'])).code).toBe(0);

    const [first, second] = bodies() as Body[];
    expect(systemOf(first!)).not.toContain('Reply in plain English.');
    expect(openingOf(first!)).toContain('Reply in plain English.');
    expect(openingOf(first!)).toMatch(/may be stale/);
    expect(openingOf(first!)).not.toContain('Prefer named exports.');
    expectPrefix(first!, second!);
    expect(newestOf(second!)).toContain(NOT_USER_LINE);
    expect(newestOf(second!)).toContain('Prefer named exports.');
    expect(newestOf(second!).indexOf('Prefer named exports.'), 'the notice comes before the prompt').toBeLessThan(newestOf(second!).indexOf('Again.'));
  });

  it('A/B-07 two workspaces send the same system prompt and tools, whatever their memory', async () => {
    const one = await scripted(wire, [say('One.')]);
    const two = await scripted(wire, [say('Two.')], { 'b.ts': 'export const b = 2;\n' });
    await memoryStore(homeOf(one.store), one.workspace).add('Use tabs in this project.', 'project', null);
    expect((await one.cli(['agent', '--workspace', one.workspace, 'Hi.'])).code).toBe(0);
    expect((await two.cli(['agent', '--workspace', two.workspace, 'Hi.'])).code).toBe(0);
    const [a] = one.bodies() as Body[];
    const [b] = two.bodies() as Body[];
    expect(systemOf(b!)).toBe(systemOf(a!));
    expect(JSON.stringify(b!.tools)).toBe(JSON.stringify(a!.tools));
  });

  it('A/B-13 a switch from Ask to Plan keeps the request prefix, tells the model in a message, and still refuses an edit', async () => {
    const { workspace, cli, bodies, seen } = await scripted(wire, [
      say('Ready.'),
      call('Changing it.', [{ id: 'tu_edit', name: 'edit', input: { path: 'a.ts', old_str: 'a = 1', new_str: 'a = 2' } }]),
      say('Planned.'),
    ]);
    const id = sessionIdOf((await cli(['agent', '--workspace', workspace, '--mode', 'ask', 'Hi.'])).stdout);
    expect((await cli(['agent', '--session', id, '--mode', 'plan', 'Set a to 2.'])).code).toBe(0);

    const [ask, plan] = bodies() as Body[];
    expectPrefix(ask!, plan!);
    expect(newestOf(plan!)).toMatch(/Plan mode/);
    expect(newestOf(plan!)).toMatch(/read-only/);
    const [result] = seen()[2]!.results;
    expect(result).toMatchObject({ id: 'tu_edit', error: true });
    expect(result!.text).toContain('edit is not available: Plan mode is read-only');
    expect(readFileSync(path.join(workspace, 'a.ts'), 'utf8')).toBe('export const a = 1;\n');
  });

  const items: TodoList = [
    { id: '1', text: 'Read a.ts', status: 'done' },
    { id: '2', text: 'Change it', status: 'in_progress' },
    { id: '3', text: 'Run the tests', status: 'pending' },
  ];
  const todo = (id: string) => call('Planning.', [{ id, name: 'todo', input: { items } }]);
  const read = (id: string) => call('Reading.', [{ id, name: 'read', input: { path: 'a.ts' } }]);
  const REMINDED = /\[~\] 2: Change it[\s\S]*clear it by calling todo with an empty list/;

  it(`a list left alone for ${TODO_REMINDER_CALLS} calls comes back once as a notice, and the prefix holds`, async () => {
    const reads = Array.from({ length: TODO_REMINDER_CALLS + 1 }, (_, i) => read(`tu_r${i}`));
    const { workspace, cli, bodies, log } = await scripted(wire, [todo('tu_t'), ...reads, say('Done.')]);
    const result = await cli(['agent', '--workspace', workspace, '--max-turns', '40', 'Change a.ts']);
    expect(result.code).toBe(0);

    const sent = bodies() as Body[];
    const reminded = sent.flatMap((body, i) => (REMINDED.test(newestOf(body)) ? [i] : []));
    expect(reminded, 'once, on the call after the tenth without a todo call').toEqual([TODO_REMINDER_CALLS + 1]);
    expect(newestOf(sent[TODO_REMINDER_CALLS + 1]!)).toMatch(/not updated your todo list in your last 10 model calls/);
    for (let i = 1; i < sent.length; i++) expectPrefix(sent[i - 1]!, sent[i]!);
    expect((await log(result.stdout)).filter((e) => e.kind === 'notice' && e.todo !== undefined)).toHaveLength(1);
  });

  it.each([
    ['stopped at its limit mid-call', ['--max-turns', '2'], [todo('tu_t'), read('tu_r')], 'stopped'],
    ['capped by its limit with a closing report', ['--max-turns', '3'], [todo('tu_t'), read('tu_r'), say('I ran out of calls: a.ts is read, the change is still to do.')], 'stopped'],
    ['that ended on its own', [], [todo('tu_t'), read('tu_r'), say('a.ts is read; I will change it next.')], 'earlier'],
  ] as const)('a prompt after a turn %s shows the unfinished list before the prompt, and the prefix holds', async (_how, limit, first, why) => {
    const { workspace, cli, bodies, events } = await scripted(wire, [...first, say('The build fails on a missing import.')]);
    const id = sessionIdOf((await cli(['agent', '--workspace', workspace, ...limit, 'Change a.ts'])).stdout);
    expect((await cli(['agent', '--session', id, 'Why does the build fail?'])).code).toBe(0);

    const sent = bodies() as Body[];
    const asked = newestOf(sent.at(-1)!);
    expect(sent.slice(0, -1).some((body) => REMINDED.test(newestOf(body))), 'not while the first turn runs').toBe(false);
    expect(asked).toMatch(why === 'stopped' ? /last turn ended before your todo list was finished/ : /Your todo list from earlier still has unfinished items/);
    expect(asked.search(REMINDED), 'the list comes before the prompt').toBeLessThan(asked.indexOf('Why does the build fail?'));
    expectPrefix(sent.at(-2)!, sent.at(-1)!);
    expect((await events(id)).find((e) => e.kind === 'notice' && e.todo !== undefined)).toMatchObject({ todo: { why, list: items } });
  });
});
