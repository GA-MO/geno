import { mkdtemp, realpath } from 'node:fs/promises';
import { connect as connectSocket } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Readable, Writable } from 'node:stream';
import * as acp from '@agentclientprotocol/sdk';
import { describe, expect, it } from 'vitest';
import { RUNNING_META, TASK_UPDATE_METHOD, TASKS_CAPABILITY, TASKS_METHOD, type TaskUpdate, type TasksResponse } from '@g-code/core';
import type { Io } from '../src/command.js';
import { serveSocket } from '../src/daemon.js';
import { mcpSessions } from '../src/mcp/sessions.js';
import { engineShared, gcodeAgent } from '../src/serve.js';
import { openStore } from '../src/store.js';
import { answer, sseBody, toolCall, type FakeToolUse, type Reply } from './fake-transport.js';
import { makeRepo } from './git-fixture.js';
import { rgCommand } from './helpers.js';

const usage = { input: 1000, cacheRead: 0, cacheWrite: 0 };
const LIMITS = { maxTurns: 10, maxCostUsd: 1 };

/** A fake model that answers in order; a reply whose index has a gate waits until the test opens it. */
function gatedModel(replies: readonly Reply[], gated: readonly number[]) {
  const opens = new Map<number, () => void>();
  const gates = new Map(gated.map((i) => [i, new Promise<void>((resolve) => opens.set(i, resolve))]));
  const requests: unknown[] = [];
  let reached: (count: number) => void = () => {};
  const fetch: typeof globalThis.fetch = async (_input, init) => {
    const index = requests.push(JSON.parse(String(init?.body))) - 1;
    reached(requests.length);
    await gates.get(index);
    const reply = replies[index];
    if (reply === undefined) throw new Error(`no reply ${index}`);
    return new Response(sseBody(reply), { status: 200, headers: { 'content-type': 'text/event-stream' } });
  };
  const waitFor = (count: number) =>
    new Promise<void>((resolve) => {
      if (requests.length >= count) return resolve();
      reached = (now) => {
        if (now >= count) resolve();
      };
    });
  return { fetch, requests, open: (i: number) => opens.get(i)?.(), waitFor };
}

async function setup(replies: readonly Reply[], gated: readonly number[]) {
  const workspace = await realpath(makeRepo('ws', [{ message: 'start', files: { 'a.ts': 'export const a = 1;\n' } }]));
  const home = await mkdtemp(path.join(tmpdir(), 'gcode-home-'));
  const env = { GCODE_HOME: home, GCODE_PROVIDER: 'modelstudio', DASHSCOPE_API_KEY: 'sk-fake', DASHSCOPE_BASE_URL: 'https://ws-1.example.com/apps/anthropic', GCODE_RG: rgCommand(), PATH: process.env['PATH'] ?? '/usr/bin:/bin' };
  const model = gatedModel(replies, gated);
  const errors: string[] = [];
  const io: Io = { env, cwd: workspace, out: (l) => errors.push(l), err: (l) => errors.push(l), write: () => {}, interrupts: () => new AbortController().signal, confirm: async () => false, fetch: model.fetch };
  const store = openStore(env);
  const shared = engineShared(io);
  const mcp = mcpSessions(store, env);
  return { workspace, home, env, io, store, model, errors, shared, agent: () => gcodeAgent(io, store, LIMITS, mcp, shared) };
}

/** An editor window: what it heard, and its answer to any permission question. */
function editor() {
  const heard = { updates: [] as { sessionId: string; update: acp.SessionUpdate }[], tasks: [] as TaskUpdate[], permissions: [] as acp.RequestPermissionRequest[] };
  let taskWaiters: ((update: TaskUpdate) => void)[] = [];
  const app = acp
    .client({ name: 'test-window' })
    .onRequest(acp.methods.client.session.requestPermission, ({ params }) => {
      heard.permissions.push(params);
      return { outcome: { outcome: 'selected', optionId: 'reject' } };
    })
    .onNotification(acp.methods.client.session.update, ({ params }) => void heard.updates.push(params))
    .onNotification(TASK_UPDATE_METHOD, (raw) => raw as TaskUpdate, ({ params }) => {
      heard.tasks.push(params);
      for (const waiter of taskWaiters) waiter(params);
    });
  const taskBecomes = (sessionId: string, status: string) =>
    new Promise<TaskUpdate>((resolve) => {
      const done = heard.tasks.find((u) => u.task.sessionId === sessionId && u.task.status === status);
      if (done !== undefined) return resolve(done);
      taskWaiters.push((u) => {
        if (u.task.sessionId === sessionId && u.task.status === status) resolve(u);
      });
    });
  const open = async (agent: acp.AgentApp) => {
    const connection = app.connect(agent);
    await connection.agent.request(acp.methods.agent.initialize, {
      protocolVersion: acp.PROTOCOL_VERSION,
      clientCapabilities: { session: { notices: {} }, _meta: { [TASKS_CAPABILITY]: true } },
    });
    return connection;
  };
  return { heard, open, taskBecomes, reset: () => (taskWaiters = []) };
}

const texts = (updates: readonly { update: acp.SessionUpdate }[]): string =>
  updates.flatMap(({ update }) => (update.sessionUpdate === 'agent_message_chunk' && update.content.type === 'text' ? [update.content.text] : [])).join('');

let nextId = 0;
const use = (name: string, input: unknown): FakeToolUse => ({ id: `tu_bg_${nextId++}`, name, input });

describe('background sessions', () => {
  it('keeps a turn running after its window goes away, and the next window that loads the session sees it end', async () => {
    const { workspace, model, agent } = await setup([toolCall('Reading a.ts.', [use('read', { path: 'a.ts' })], usage), answer('a.ts exports a.', usage)], [1]);
    const first = editor();
    const window1 = await first.open(agent());
    const { sessionId } = await window1.agent.request(acp.methods.agent.session.new, { cwd: workspace, mcpServers: [] });
    const turn = window1.agent.request(acp.methods.agent.session.prompt, { sessionId, prompt: [{ type: 'text', text: 'What is in a.ts?' }] });
    turn.catch(() => {});
    await model.waitFor(2);
    await first.taskBecomes(sessionId, 'running');
    window1.close();

    const second = editor();
    const window2 = await second.open(agent());
    const listed = await window2.agent.request<TasksResponse>(TASKS_METHOD, {});
    expect(listed.tasks).toEqual([expect.objectContaining({ sessionId, status: 'running', title: 'What is in a.ts?', workspace, lane: null })]);
    const loaded = await window2.agent.request(acp.methods.agent.session.load, { sessionId, cwd: workspace, mcpServers: [] });
    expect(loaded._meta?.[RUNNING_META]).toBe(true);
    const replayed = second.heard.updates.length;
    expect(second.heard.updates.map(({ update }) => update.sessionUpdate)).toContain('user_message_chunk');
    expect(texts(second.heard.updates)).toBe('Reading a.ts.');

    model.open(1);
    const ended = await second.taskBecomes(sessionId, 'done');
    expect(ended.notice).toBe('done');
    expect(ended.task.usage).toMatchObject({ inputTokens: 2000, costUsd: expect.any(Number) });
    expect(texts(second.heard.updates.slice(replayed))).toBe('a.ts exports a.');
    expect((await window2.agent.request<TasksResponse>(TASKS_METHOD, {})).tasks[0]).toMatchObject({ sessionId, status: 'done' });
    window2.close();
  });

  it('holds a question until a window shows the session, reads needs-input meanwhile, and keeps the notices no window heard', async () => {
    const remove = use('bash', { command: 'rm -rf src' });
    const { workspace, model, agent } = await setup([toolCall('Removing src.', [remove], usage), answer('Kept src.', usage)], [0]);
    const first = editor();
    const window1 = await first.open(agent());
    const { sessionId } = await window1.agent.request(acp.methods.agent.session.new, { cwd: workspace, mcpServers: [] });
    const turn = window1.agent.request(acp.methods.agent.session.prompt, { sessionId, prompt: [{ type: 'text', text: 'Remove src' }] });
    turn.catch(() => {});
    await model.waitFor(1);
    await window1.agent.request('_gcode/detach', { sessionId });
    model.open(0);
    const waiting = await first.taskBecomes(sessionId, 'needs-input');
    expect(waiting.notice).toBe('needs-input');
    expect(first.heard.permissions).toEqual([]);
    window1.close();

    const second = editor();
    const window2 = await second.open(agent());
    expect((await window2.agent.request<TasksResponse>(TASKS_METHOD, {})).missed).toEqual([]);
    await window2.agent.request(acp.methods.agent.session.load, { sessionId, cwd: workspace, mcpServers: [] });
    const done = await second.taskBecomes(sessionId, 'done');
    expect(second.heard.permissions).toEqual([expect.objectContaining({ sessionId, toolCall: expect.objectContaining({ toolCallId: remove.id }) })]);
    expect(done.notice).toBe('done');
    expect(model.requests, 'the rejection ends the turn without another model call').toHaveLength(1);
    window2.close();
  });

  it('gives the notice of a turn that ended while no window was connected to the next window that lists the tasks', async () => {
    const { workspace, model, agent, shared } = await setup([answer('Hello.', usage)], [0]);
    const first = editor();
    const window1 = await first.open(agent());
    const { sessionId } = await window1.agent.request(acp.methods.agent.session.new, { cwd: workspace, mcpServers: [] });
    window1.agent.request(acp.methods.agent.session.prompt, { sessionId, prompt: [{ type: 'text', text: 'Hi' }] }).catch(() => {});
    await model.waitFor(1);
    window1.close();
    await new Promise((resolve) => setTimeout(resolve, 50));
    model.open(0);
    while (shared.tasks.get(sessionId)?.status !== 'done') await new Promise((resolve) => setTimeout(resolve, 20));

    const window2 = await editor().open(agent());
    expect((await window2.agent.request<TasksResponse>(TASKS_METHOD, {})).missed).toEqual([{ sessionId, kind: 'done' }]);
    expect((await window2.agent.request<TasksResponse>(TASKS_METHOD, {})).missed).toEqual([]);
    window2.close();
  });
});

describe('gcode serve --socket', () => {
  it('serves windows that come and go, and exits once none is connected and no turn runs', async () => {
    const { workspace, io, store } = await setup([answer('Hello.', usage)], []);
    const socket = path.join(await mkdtemp(path.join(tmpdir(), 'gs-')), 'e.sock');
    const served = serveSocket(io, store, LIMITS, socket, 300);
    const dial = async () => {
      for (;;) {
        const connection = await new Promise<import('node:net').Socket | undefined>((resolve) => {
          const s = connectSocket(socket);
          s.once('connect', () => resolve(s));
          s.once('error', () => resolve(undefined));
        });
        if (connection !== undefined) return connection;
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
    };
    const wire = await dial();
    const stream = acp.ndJsonStream(Writable.toWeb(wire) as WritableStream<Uint8Array>, Readable.toWeb(wire) as ReadableStream<Uint8Array>);
    const client = acp.client({ name: 'socket-window' }).connect(stream);
    await client.agent.request(acp.methods.agent.initialize, { protocolVersion: acp.PROTOCOL_VERSION, clientCapabilities: {} });
    const { sessionId } = await client.agent.request(acp.methods.agent.session.new, { cwd: workspace, mcpServers: [] });
    expect((await client.agent.request(acp.methods.agent.session.prompt, { sessionId, prompt: [{ type: 'text', text: 'Hi' }] })).stopReason).toBe('end_turn');
    wire.destroy();
    expect(await served).toBe(0);
  });
});
