import { readFileSync, writeFileSync } from 'node:fs';
import { mkdtemp, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import * as acp from '@agentclientprotocol/sdk';
import { describe, expect, it, vi } from 'vitest';
import { FORK_AT_META, REWIND_TURN_METHOD, TODO_META, todoOf, type TodoList, type TodoStatus } from '@g-code/core';
import type { Io } from '../src/command.js';
import { gcodeAgent } from '../src/serve.js';
import { readSessionLog, sessionFile } from '../src/sessions.js';
import { openStore, type Store } from '../src/store.js';
import { answer, fakeTransport, toolCall } from './fake-transport.js';
import { makeRepo } from './git-fixture.js';
import { rgCommand } from './helpers.js';

vi.setConfig({ testTimeout: 30_000 });

const usage = { input: 1000, cacheRead: 0, cacheWrite: 0 };
const list = (...statuses: TodoStatus[]): TodoList => statuses.map((status, i) => ({ id: String(i + 1), text: ['Read a.ts', 'Change it', 'Run the tests'][i]!, status }));
const todo = (id: string, items: TodoList) => ({ id, name: 'todo', input: { items } });
const read = (id: string) => ({ id, name: 'read', input: { path: 'a.ts' } });

const planned = list('pending', 'pending', 'pending');
const reading = list('in_progress', 'pending', 'pending');
const changing = list('done', 'in_progress', 'pending');

type Connection = { readonly ctx: acp.ClientContext; readonly updates: acp.SessionNotification[] };

/** One engine process: a fresh gcodeAgent on the same store, as after a window reload with the engine restarted. */
function connect<T>(io: Io, store: Store, run: (connection: Connection) => Promise<T>): Promise<T> {
  const updates: acp.SessionNotification[] = [];
  const client = acp
    .client({ name: 'test-editor' })
    .onRequest(acp.methods.client.fs.readTextFile, async ({ params }) => ({ content: readFileSync(params.path, 'utf8') }))
    .onRequest(acp.methods.client.fs.writeTextFile, async ({ params }) => {
      writeFileSync(params.path, params.content);
      return {};
    })
    .onRequest(acp.methods.client.session.requestPermission, ({ params }) => ({ outcome: { outcome: 'selected', optionId: params.options[0]!.optionId } }))
    .onNotification(acp.methods.client.session.update, ({ params }) => {
      updates.push(params);
    });
  return client.connectWith(gcodeAgent(io, store, { maxTurns: 10, maxCostUsd: 1 }), async (ctx) => {
    await ctx.request(acp.methods.agent.initialize, { protocolVersion: acp.PROTOCOL_VERSION, clientCapabilities: { fs: { readTextFile: true, writeTextFile: true } } });
    return run({ ctx, updates });
  });
}

/** The list each todo call showed, in order: what the panel draws, live or replayed. Live, a call's end and its result both carry it. */
const shownLists = (updates: readonly acp.SessionNotification[], sessionId: string): TodoList[] => {
  const lists = new Map<string, TodoList>();
  for (const { sessionId: id, update } of updates) {
    const meta = update.sessionUpdate === 'tool_call_update' ? (update._meta?.[TODO_META] as { items: TodoList } | undefined) : undefined;
    if (id === sessionId && meta !== undefined && update.sessionUpdate === 'tool_call_update') {
      expect(lists.get(update.toolCallId) ?? meta.items, 'a call never changes its list').toEqual(meta.items);
      lists.set(update.toolCallId, meta.items);
    }
  }
  return [...lists.values()];
};

const toolNames = (body: { readonly messages: readonly { readonly role: string; readonly content: unknown }[] }): string[] =>
  body.messages.flatMap((m) => (m.role !== 'assistant' || typeof m.content === 'string' ? [] : (m.content as { type: string; name?: string; input?: unknown }[]).flatMap((b) => (b.type === 'tool_use' && b.name === 'todo' ? [JSON.stringify(b.input)] : []))));

describe('gcode serve: the todo list', () => {
  it('survives a reload, goes back with a cut of the turn that changed it, and is copied into a fork', async () => {
    const workspace = await realpath(makeRepo('ws', [{ message: 'start', files: { 'a.ts': 'export const a = 1;\n' } }]));
    const home = await mkdtemp(path.join(tmpdir(), 'gcode-home-'));
    const env = {
      GCODE_HOME: home,
      HOME: home,
      GCODE_PROVIDER: 'modelstudio',
      DASHSCOPE_API_KEY: 'sk-fake',
      DASHSCOPE_BASE_URL: 'https://ws-1.example.com/apps/anthropic',
      GCODE_RG: rgCommand(),
      PATH: process.env['PATH'] ?? '/usr/bin:/bin',
    };
    const store = openStore(env);
    const model = fakeTransport([
      toolCall('Planning.', [todo('t1', planned)], usage),
      answer('Here is the plan.', usage),
      toolCall('Reading.', [todo('t2', reading), read('r1')], usage),
      toolCall('Changing.', [todo('t3', changing)], usage),
      answer('Half way.', usage),
      answer('Half way; a.ts is next, once you say go.', usage),
      answer('Forked.', usage),
      answer('Forked; the change is still to make.', usage),
      answer('Again.', usage),
    ]);
    const io: Io = { env, cwd: workspace, out: () => {}, err: () => {}, write: () => {}, interrupts: () => new AbortController().signal, confirm: async () => false, fetch: model.fetch };
    const log = async (id: string) => (await readSessionLog(sessionFile(store, id as never))).events;
    const prompt = (ctx: acp.ClientContext, sessionId: string, text: string) => ctx.request(acp.methods.agent.session.prompt, { sessionId, prompt: [{ type: 'text', text }] });

    const { sessionId, turn2 } = await connect(io, store, async ({ ctx, updates }) => {
      const { sessionId } = await ctx.request(acp.methods.agent.session.new, { cwd: workspace, mcpServers: [] });
      await prompt(ctx, sessionId, 'plan it');
      const second = await prompt(ctx, sessionId, 'build it');
      expect(shownLists(updates, sessionId), 'each call sends its whole list live').toEqual([planned, reading, changing]);
      return { sessionId, turn2: second._meta?.['gcode/turnSeq'] as number };
    });
    expect(todoOf(await log(sessionId))).toEqual(changing);

    await connect(io, store, async ({ ctx, updates }) => {
      await ctx.request(acp.methods.agent.session.load, { sessionId, cwd: workspace, mcpServers: [] });
      expect(shownLists(updates, sessionId), 'a reload replays every list where it was set').toEqual([planned, reading, changing]);

      const { sessionId: forkId } = await ctx.request(acp.methods.agent.session.fork, { sessionId, cwd: workspace, mcpServers: [], _meta: { [FORK_AT_META]: turn2 } });
      expect(todoOf(await log(forkId)), 'the fork starts with the list as it stood after the turn it forked at').toEqual(changing);
      updates.length = 0;
      await ctx.request(acp.methods.agent.session.load, { sessionId: forkId, cwd: workspace, mcpServers: [] });
      expect(shownLists(updates, forkId)).toEqual([planned, reading, changing]);
      await prompt(ctx, forkId, 'go on');
      expect(toolNames(model.requests.at(-1)!.body), "the fork's model sees its earlier calls").toHaveLength(3);

      await ctx.request(REWIND_TURN_METHOD, { sessionId, turnSeq: turn2, choice: { kind: 'conversation' } });
      expect(todoOf(await log(sessionId)), 'the cut takes the list back to the plan').toEqual(planned);
      expect(todoOf(await log(forkId)), 'the fork keeps its own copy').toEqual(changing);
      updates.length = 0;
      await ctx.request(acp.methods.agent.session.load, { sessionId, cwd: workspace, mcpServers: [] });
      expect(shownLists(updates, sessionId), 'the replay after the cut shows only the plan').toEqual([planned]);
      await prompt(ctx, sessionId, 'build it again');
      expect(toolNames(model.requests.at(-1)!.body), "the cut turn's calls never reach the model again").toEqual([JSON.stringify({ items: planned })]);
    });
  });
});
