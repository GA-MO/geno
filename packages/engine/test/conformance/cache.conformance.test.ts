import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { NOT_USER_LINE } from '@g-code/core';
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
});
