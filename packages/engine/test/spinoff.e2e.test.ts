import { readFileSync, writeFileSync } from 'node:fs';
import { mkdtemp, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import * as acp from '@agentclientprotocol/sdk';
import { describe, expect, it, vi } from 'vitest';
import {
  parseSpinoffShown,
  SPINOFF_CAPABILITY,
  SPINOFF_DISMISS_METHOD,
  SPINOFF_META,
  SPINOFF_START_METHOD,
  spinoffIdOf,
  spinoffsOf,
  TASK_UPDATE_METHOD,
  TASKS_CAPABILITY,
  type SpinoffResponse,
  type SpinoffShown,
  type TaskUpdate,
} from '@g-code/core';
import type { Io } from '../src/command.js';
import { mcpSessions } from '../src/mcp/sessions.js';
import { engineShared, gcodeAgent } from '../src/serve.js';
import { readSessionLog, sessionFile } from '../src/sessions.js';
import { openStore } from '../src/store.js';
import { answer, fakeTransport, loadTools, offeredTools, toolCall, type FakeToolUse } from './fake-transport.js';
import { makeRepo } from './git-fixture.js';
import { rgCommand } from './helpers.js';

vi.setConfig({ testTimeout: 30_000 });

const usage = { input: 1000, cacheRead: 0, cacheWrite: 0 };
const spawn = (id: string, title: string): FakeToolUse => ({
  id,
  name: 'spawn_task',
  input: { title, tldr: `Noticed while fixing the parser: ${title}.`, prompt: `${title}. The file is src/util.ts. Run the tests after.` },
});
const dismiss = (id: string, taskId: string): FakeToolUse => ({ id, name: 'dismiss_task', input: { task_id: taskId } });

const A = spinoffIdOf('tu_a', []);
const B = spinoffIdOf('tu_b', []);
const C = spinoffIdOf('tu_c', []);

/** What the panel was told about each suggestion, folded in order: the offer, then each move by id. */
function shown(updates: readonly acp.SessionNotification[], sessionId: string): Record<string, string> {
  const states: Record<string, string> = {};
  for (const { sessionId: id, update } of updates) {
    const raw = update.sessionUpdate === 'tool_call_update' ? update._meta?.[SPINOFF_META] : undefined;
    if (id !== sessionId || raw === undefined) continue;
    const parsed: SpinoffShown | undefined = parseSpinoffShown(raw);
    expect(parsed, 'the meta parses on the panel side').toBeDefined();
    if (parsed!.kind === 'offer') states[parsed!.spinoff.id] = `${parsed!.spinoff.state.kind} on ${parsed!.spinoff.toolUseId}`;
    else states[parsed!.id] = `${parsed!.state.kind}`;
  }
  return states;
}

const resultOf = (updates: readonly acp.SessionNotification[], toolCallId: string) =>
  updates.flatMap(({ update }) => (update.sessionUpdate === 'tool_call_update' && update.toolCallId === toolCallId && update.status !== undefined && update.content != null ? [update] : [])).at(-1);
const textOf = (update: acp.SessionUpdate | undefined): string =>
  update?.sessionUpdate === 'tool_call_update' ? (update.content ?? []).flatMap((c) => (c.type === 'content' && c.content.type === 'text' ? [c.content.text] : [])).join('') : '';

describe('gcode serve: spin-off tasks', () => {
  it('offers in Plan without asking, withdraws, starts one in its own lane, dismisses one, and replays each where it ended', async () => {
    const repo = await realpath(makeRepo('main', [{ message: 'start', files: { 'src/util.ts': 'export const unused = 1;\n' } }]));
    const home = await mkdtemp(path.join(tmpdir(), 'gcode-home-'));
    const env = { GCODE_HOME: home, HOME: home, GCODE_PROVIDER: 'modelstudio', DASHSCOPE_API_KEY: 'sk-fake', DASHSCOPE_BASE_URL: 'https://ws-1.example.com/apps/anthropic', GCODE_RG: rgCommand(), PATH: process.env['PATH'] ?? '/usr/bin:/bin' };
    const model = fakeTransport([
      toolCall('Loading.', [loadTools('spawn_task', 'dismiss_task')], usage),
      toolCall('Noting three things.', [spawn('tu_a', 'Remove the unused helper'), spawn('tu_b', 'Fix the stale README'), spawn('tu_c', 'Test parseRange')], usage),
      answer('The plan is ready; I suggested three tasks.', usage),
      toolCall('Cleaning up.', [dismiss('tu_wb', B), dismiss('tu_wc', C), spawn('tu_a2', 'remove the UNUSED helper')], usage),
      answer('Withdrew one.', usage),
      answer('Removed the helper.', usage),
    ]);
    const io: Io = { env, cwd: repo, out: () => {}, err: () => {}, write: () => {}, interrupts: () => new AbortController().signal, confirm: async () => false, fetch: model.fetch };
    const store = openStore(env);
    const updates: acp.SessionNotification[] = [];
    const tasks: TaskUpdate[] = [];
    let asked = 0;
    const window = acp
      .client({ name: 'test-window' })
      .onRequest(acp.methods.client.fs.readTextFile, ({ params }) => ({ content: readFileSync(params.path, 'utf8') }))
      .onRequest(acp.methods.client.fs.writeTextFile, ({ params }) => {
        writeFileSync(params.path, params.content);
        return {};
      })
      .onRequest(acp.methods.client.session.requestPermission, ({ params }) => {
        asked++;
        return { outcome: { outcome: 'selected', optionId: params.options[0]!.optionId } };
      })
      .onNotification(acp.methods.client.session.update, ({ params }) => void updates.push(params))
      .onNotification(TASK_UPDATE_METHOD, (raw) => raw as TaskUpdate, ({ params }) => void tasks.push(params));
    const open = async (shared = engineShared(io)) => {
      const connection = window.connect(gcodeAgent(io, store, { maxTurns: 10, maxCostUsd: 1 }, mcpSessions(store, env), shared));
      await connection.agent.request(acp.methods.agent.initialize, {
        protocolVersion: acp.PROTOCOL_VERSION,
        clientCapabilities: { fs: { readTextFile: true, writeTextFile: true }, _meta: { [TASKS_CAPABILITY]: true, [SPINOFF_CAPABILITY]: true } },
      });
      return connection.agent;
    };
    const prompt = (agent: acp.AgentContext, sessionId: string, text: string) => agent.request(acp.methods.agent.session.prompt, { sessionId, prompt: [{ type: 'text', text }] });
    const log = async (id: string) => (await readSessionLog(sessionFile(store, id as never))).events;

    const agent = await open();
    const { sessionId: chat } = await agent.request(acp.methods.agent.session.new, { cwd: repo, mcpServers: [] });
    await agent.request(acp.methods.agent.session.setMode, { sessionId: chat, modeId: 'plan' });
    await prompt(agent, chat, 'plan the parser fix');
    expect(offeredTools(model.requests[0]!.body), 'Plan offers both tools').toEqual(expect.arrayContaining(['spawn_task', 'dismiss_task']));
    expect(model.requests[0]!.body.tools.map((tool: { name: string }) => tool.name), 'both are deferred, by name in tool_search').not.toContain('spawn_task');
    expect(shown(updates, chat), 'each offer reaches the panel live, open').toEqual({ [A]: 'offered on tu_a', [B]: 'offered on tu_b', [C]: 'offered on tu_c' });
    expect(textOf(resultOf(updates, 'tu_a'))).toBe(`Suggested ${A} "Remove the unused helper". The user sees it as a card and can start it in its own lane; nothing was started. Go on with the current task. If it stops being worth doing, withdraw it with dismiss_task.`);
    expect(asked, 'no suggestion asks for approval, in Plan too').toBe(0);
    expect(tasks.filter((u) => u.task.sessionId !== chat), 'nothing started by itself').toEqual([]);

    const dismissed = await agent.request<SpinoffResponse>(SPINOFF_DISMISS_METHOD, { sessionId: chat, id: C });
    expect(dismissed.spinoff).toMatchObject({ id: C, title: 'Test parseRange', state: { kind: 'dismissed' } });
    await expect(agent.request(SPINOFF_DISMISS_METHOD, { sessionId: chat, id: C }), 'a second dismissal is refused').rejects.toThrow(`${C} cannot change: the user already dismissed it`);

    await agent.request(acp.methods.agent.session.setMode, { sessionId: chat, modeId: 'ask' });
    await prompt(agent, chat, 'go on');
    expect(resultOf(updates, 'tu_wb')?._meta?.[SPINOFF_META]).toEqual({ kind: 'move', id: B, state: { kind: 'withdrawn' } });
    expect(textOf(resultOf(updates, 'tu_wb'))).toBe(`Withdrew ${B} "Fix the stale README"; its card is gone.`);
    expect(resultOf(updates, 'tu_wc')).toMatchObject({ status: 'failed' });
    expect(textOf(resultOf(updates, 'tu_wc')), "the agent learns the user's decision stands").toContain(`${C} cannot change: the user already dismissed it`);
    expect(resultOf(updates, 'tu_a2')).toMatchObject({ status: 'failed' });
    expect(textOf(resultOf(updates, 'tu_a2'))).toContain(`${A} already suggests "Remove the unused helper"`);

    const started = await agent.request<SpinoffResponse>(SPINOFF_START_METHOD, { sessionId: chat, id: A });
    expect(started.spinoff.state).toEqual({ kind: 'started', sessionId: expect.any(String), lane: 'remove-the-unused-helper' });
    const task = started.spinoff.state.kind === 'started' ? started.spinoff.state.sessionId : '';
    await expect(agent.request(SPINOFF_START_METHOD, { sessionId: chat, id: A }), 'a second Start starts nothing').rejects.toThrow(`${A} cannot change: the user already started it as a task in lane remove-the-unused-helper`);
    while (!tasks.some((u) => u.task.sessionId === task && u.task.status === 'done')) await new Promise((resolve) => setTimeout(resolve, 20));
    expect(tasks.findLast((u) => u.task.sessionId === task)!.task).toMatchObject({ title: 'Remove the unused helper', lane: 'remove-the-unused-helper', status: 'done' });
    const laneCall = model.requests.at(-1)!.body;
    expect(laneCall.messages[0].content.at(-1), "the task's first message is the suggestion's prompt").toMatchObject({ type: 'text', text: 'Remove the unused helper. The file is src/util.ts. Run the tests after.' });
    expect(execFileSync('git', ['status', '--porcelain'], { cwd: repo, encoding: 'utf8' }), 'the main checkout is untouched').toBe('');
    expect(model.requests).toHaveLength(6);

    expect(spinoffsOf(await log(chat)).map((s) => [s.id, s.state.kind])).toEqual([
      [A, 'started'],
      [B, 'withdrawn'],
      [C, 'dismissed'],
    ]);

    const seen = updates.length;
    const later = await open(engineShared(io));
    await later.request(acp.methods.agent.session.load, { sessionId: chat, cwd: repo, mcpServers: [] });
    expect(shown(updates.slice(seen), chat), 'a reload on a fresh engine replays each card where it ended').toEqual({ [A]: 'started on tu_a', [B]: 'withdrawn', [C]: 'dismissed on tu_c' });
    const replayedA = parseSpinoffShown(resultOf(updates.slice(seen), 'tu_a')?._meta?.[SPINOFF_META]);
    expect(replayedA).toEqual({ kind: 'offer', spinoff: expect.objectContaining({ state: { kind: 'started', sessionId: task, lane: 'remove-the-unused-helper' } }) });
  });
});
