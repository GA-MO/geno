import { readFileSync, writeFileSync } from 'node:fs';
import { mkdtemp, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import * as acp from '@agentclientprotocol/sdk';
import { describe, expect, it } from 'vitest';
import {
  LANE_APPLY_META,
  LANE_DISCARD_METHOD,
  LANE_NEW_METHOD,
  LANES_METHOD,
  REPLAYED_CHANGE_META,
  REVIEW_METHOD,
  TASK_UPDATE_METHOD,
  TASKS_CAPABILITY,
  TOOL_CALL_META,
  type LaneNewResponse,
  type LanesResponse,
  type ReviewResponse,
  type TaskUpdate,
} from '@g-code/core';
import type { Io } from '../src/command.js';
import { mcpSessions } from '../src/mcp/sessions.js';
import { engineShared, gcodeAgent } from '../src/serve.js';
import { openStore } from '../src/store.js';
import { answer, fakeTransport, toolCall, type FakeToolUse } from './fake-transport.js';
import { makeRepo } from './git-fixture.js';
import { rgCommand } from './helpers.js';

const usage = { input: 1000, cacheRead: 0, cacheWrite: 0 };
const FILE = 'one\ntwo\nthree\n';
let nextId = 0;
const use = (name: string, input: unknown): FakeToolUse => ({ id: `tu_lane_${nextId++}`, name, input });
/** A lane session's whole turn: read a.ts, change its second line, and say so. */
const laneTurn = (line: string) => [
  toolCall('Reading.', [use('read', { path: 'a.ts' })], usage),
  toolCall('Editing.', [use('edit', { path: 'a.ts', old_str: 'two', new_str: line })], usage),
  answer(`Line two is ${line} now.`, usage),
];

async function setup() {
  const repo = await realpath(makeRepo('main', [{ message: 'start', files: { 'a.ts': FILE, '.gcode.json': '{ "check": "true" }\n' } }]));
  const home = await mkdtemp(path.join(tmpdir(), 'gcode-home-'));
  const env = { GCODE_HOME: home, GCODE_PROVIDER: 'modelstudio', DASHSCOPE_API_KEY: 'sk-fake', DASHSCOPE_BASE_URL: 'https://ws-1.example.com/apps/anthropic', GCODE_RG: rgCommand(), PATH: process.env['PATH'] ?? '/usr/bin:/bin', HOME: home };
  const transport = fakeTransport([...laneTurn('TWO'), ...laneTurn('Two!')]);
  const io: Io = { env, cwd: repo, out: () => {}, err: () => {}, write: () => {}, interrupts: () => new AbortController().signal, confirm: async () => false, fetch: transport.fetch };
  const store = openStore(env);
  const shared = engineShared(io);
  const mcp = mcpSessions(store, env);
  const writes: acp.WriteTextFileRequest[] = [];
  const updates: acp.SessionNotification[] = [];
  const tasks: TaskUpdate[] = [];
  const window = acp
    .client({ name: 'test-window' })
    .onRequest(acp.methods.client.fs.readTextFile, ({ params }) => ({ content: readFileSync(params.path, 'utf8') }))
    .onRequest(acp.methods.client.fs.writeTextFile, ({ params }) => {
      writes.push(params);
      writeFileSync(params.path, params.content);
      return {};
    })
    .onNotification(acp.methods.client.session.update, ({ params }) => void updates.push(params))
    .onNotification(TASK_UPDATE_METHOD, (raw) => raw as TaskUpdate, ({ params }) => void tasks.push(params));
  const open = async () => {
    const connection = window.connect(gcodeAgent(io, store, { maxTurns: 10, maxCostUsd: 1 }, mcp, shared));
    await connection.agent.request(acp.methods.agent.initialize, {
      protocolVersion: acp.PROTOCOL_VERSION,
      clientCapabilities: { fs: { readTextFile: true, writeTextFile: true }, _meta: { [TASKS_CAPABILITY]: true } },
    });
    return connection.agent;
  };
  const ended = async (sessionId: string) => {
    while (!tasks.some((u) => u.task.sessionId === sessionId && u.task.status !== 'running')) await new Promise((resolve) => setTimeout(resolve, 20));
    return tasks.findLast((u) => u.task.sessionId === sessionId)!;
  };
  return { repo, open, writes, updates, tasks, ended };
}

describe('lanes over ACP', () => {
  it('runs a prompt in a new lane, lists it with its diff, check and cost, applies it for review, refuses the conflicting one, and discards', async () => {
    const { repo, open, writes, updates, ended } = await setup();
    const agent = await open();
    const { sessionId: chat } = await agent.request(acp.methods.agent.session.new, { cwd: repo, mcpServers: [] });

    const started = await agent.request<LaneNewResponse>(LANE_NEW_METHOD, { cwd: repo, prompt: 'Make two loud' });
    expect(started.name).toBe('make-two-loud');
    const done = await ended(started.sessionId);
    expect(done).toMatchObject({ notice: 'done', task: { status: 'done', lane: 'make-two-loud', title: 'Make two loud' } });
    expect(updates.filter((u) => u.sessionId === started.sessionId)).toEqual([]);
    expect(writes).toEqual([]);
    expect(readFileSync(path.join(repo, 'a.ts'), 'utf8')).toBe(FILE);

    const { lanes } = await agent.request<LanesResponse>(LANES_METHOD, { cwd: repo });
    expect(lanes).toEqual([
      expect.objectContaining({
        name: 'make-two-loud',
        status: 'changed',
        diff: { files: 1, added: 1, removed: 1 },
        check: 'passed',
        session: { id: started.sessionId, title: 'Make two loud', turns: 1, costUsd: expect.any(Number) },
        task: 'done',
      }),
    ]);

    const applied = await agent.request(acp.methods.agent.session.prompt, { sessionId: chat, prompt: [{ type: 'text', text: 'Apply lane make-two-loud' }], _meta: { [LANE_APPLY_META]: 'make-two-loud' } });
    expect(applied.stopReason).toBe('end_turn');
    expect(writes).toEqual([expect.objectContaining({ path: path.join(repo, 'a.ts'), content: 'one\nTWO\nthree\n', _meta: expect.objectContaining({ [TOOL_CALL_META]: expect.stringMatching(/^lane-/) }) })]);
    const chatUpdates = updates.filter((u) => u.sessionId === chat).map((u) => u.update);
    expect(chatUpdates).toContainEqual(expect.objectContaining({ sessionUpdate: 'tool_call', title: 'edit a.ts', kind: 'edit' }));
    expect(chatUpdates).toContainEqual({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Applied 1 file from lane make-two-loud. Keep or undo each change.' } });
    const review = await agent.request<ReviewResponse>(REVIEW_METHOD, { sessionId: chat, decisions: [] });
    expect(review.hunks).toEqual([expect.objectContaining({ path: path.join(repo, 'a.ts'), oldText: 'two\n', newText: 'TWO\n', status: 'pending' })]);

    const second = await agent.request<LaneNewResponse>(LANE_NEW_METHOD, { cwd: repo, prompt: 'Make two loud' });
    expect(second.name).toBe('make-two-loud-2');
    await ended(second.sessionId);
    const refused = await agent.request(acp.methods.agent.session.prompt, { sessionId: chat, prompt: [{ type: 'text', text: 'Apply lane make-two-loud-2' }], _meta: { [LANE_APPLY_META]: 'make-two-loud-2' } });
    expect(refused.stopReason).toBe('end_turn');
    expect(writes).toHaveLength(1);
    expect(readFileSync(path.join(repo, 'a.ts'), 'utf8')).toBe('one\nTWO\nthree\n');
    expect(updates.filter((u) => u.sessionId === chat).map((u) => u.update)).toContainEqual({
      sessionUpdate: 'agent_message_chunk',
      content: { type: 'text', text: 'Nothing from lane make-two-loud-2 was applied: 1 file conflicts with the main checkout.\n- `a.ts`: the lane and the main checkout changed the same lines' },
    });

    // A later window loads the chat and sees the apply as a turn of its own, its hunk under review.
    const seen = updates.length;
    const later = await open();
    await later.request(acp.methods.agent.session.load, { sessionId: chat, cwd: repo, mcpServers: [] });
    const replay = updates.slice(seen).map((u) => u.update);
    expect(replay).toContainEqual(expect.objectContaining({ sessionUpdate: 'user_message_chunk', content: { type: 'text', text: 'Apply lane make-two-loud' } }));
    expect(replay).toContainEqual(expect.objectContaining({ sessionUpdate: 'tool_call_update', _meta: expect.objectContaining({ [REPLAYED_CHANGE_META]: expect.objectContaining({ path: path.join(repo, 'a.ts') }) }) }));

    await expect(agent.request(LANE_DISCARD_METHOD, { cwd: repo, name: 'make-two-loud-2', discardChanges: false })).rejects.toThrow(/has changes/);
    await agent.request(LANE_DISCARD_METHOD, { cwd: repo, name: 'make-two-loud-2', discardChanges: true });
    await agent.request(LANE_DISCARD_METHOD, { cwd: repo, name: 'make-two-loud', discardChanges: true });
    expect((await agent.request<LanesResponse>(LANES_METHOD, { cwd: repo })).lanes).toEqual([]);
  });
});
