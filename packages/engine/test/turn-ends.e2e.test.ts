import { mkdtemp, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import * as acp from '@agentclientprotocol/sdk';
import { describe, expect, it } from 'vitest';
import { TASK_UPDATE_METHOD, TASKS_CAPABILITY, type TaskUpdate } from '@g-code/core';
import type { Io } from '../src/command.js';
import { mcpSessions } from '../src/mcp/sessions.js';
import { engineShared, gcodeAgent } from '../src/serve.js';
import { openStore } from '../src/store.js';
import { answer, fakeTransport, httpError, toolCall, type Reply } from './fake-transport.js';
import { makeRepo } from './git-fixture.js';
import { rgCommand } from './helpers.js';

const usage = { input: 1000, cacheRead: 0, cacheWrite: 0 };
const LIMITS = { maxTurns: 10, maxCostUsd: 1 };

const until = async (what: string, probe: () => boolean, ms = 5_000): Promise<void> => {
  const deadline = Date.now() + ms;
  while (!probe()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
};

/** The real engine over ACP against a fake model, and a window that hears the task updates and leaves cards waiting. */
async function setup(replies: readonly Reply[], limits = LIMITS) {
  const workspace = await realpath(makeRepo('ws', [{ message: 'start', files: { 'a.ts': 'export const a = 1;\n' } }]));
  const home = await mkdtemp(path.join(tmpdir(), 'gcode-home-'));
  const env = { GCODE_HOME: home, GCODE_PROVIDER: 'modelstudio', DASHSCOPE_API_KEY: 'sk-fake', DASHSCOPE_BASE_URL: 'https://ws-1.example.com/apps/anthropic', GCODE_RG: rgCommand(), PATH: process.env['PATH'] ?? '/usr/bin:/bin' };
  const io: Io = { env, cwd: workspace, out: () => {}, err: () => {}, write: () => {}, interrupts: () => new AbortController().signal, confirm: async () => false, fetch: fakeTransport(replies).fetch };
  const store = openStore(env);
  const updates: TaskUpdate[] = [];
  const connection = acp
    .client({ name: 'test-window' })
    .onRequest(acp.methods.client.session.requestPermission, () => new Promise<acp.RequestPermissionResponse>(() => {}))
    .onNotification(acp.methods.client.session.update, () => {})
    .onNotification(TASK_UPDATE_METHOD, (raw) => raw as TaskUpdate, ({ params }) => void updates.push(params))
    .connect(gcodeAgent(io, store, limits, mcpSessions(store, env), engineShared(io)));
  await connection.agent.request(acp.methods.agent.initialize, { protocolVersion: acp.PROTOCOL_VERSION, clientCapabilities: { _meta: { [TASKS_CAPABILITY]: true } } });
  const { sessionId } = await connection.agent.request(acp.methods.agent.session.new, { cwd: workspace, mcpServers: [] });
  /** One turn to its end: ACP's answer, and the task update that ended it. */
  const turn = async (text: string) => {
    const response = await connection.agent.request(acp.methods.agent.session.prompt, { sessionId, prompt: [{ type: 'text', text }] });
    const endOf = () => updates.findLast((u) => u.task.sessionId === sessionId && u.task.endedAt !== null);
    await until('the task to end', () => endOf() !== undefined);
    return { response, ended: endOf()! };
  };
  const asking = () => updates.some((u) => u.task.sessionId === sessionId && u.task.status === 'needs-input');
  const cancel = () => connection.agent.notify(acp.methods.agent.session.cancel, { sessionId });
  return { turn, asking, cancel, close: () => connection.close() };
}

/** A turn that reads a file, then is out of model calls or of budget. */
const reading = (): Reply => toolCall('Reading a.ts.', [{ id: `tu_read_${Math.random()}`, name: 'read', input: { path: 'a.ts' } }], usage);
const BAD_REQUEST = httpError(400, { type: 'error', error: { type: 'invalid_request_error', message: 'messages.1.content.0: unexpected tool_use_id' } });

describe('how each end of a turn reaches its task', () => {
  const ENDS = [
    { end: 'an answer', replies: [answer('Done.', usage)], limits: LIMITS, stopReason: 'end_turn', status: 'done' },
    { end: 'a model error the gateway does not retry (HTTP 400)', replies: [BAD_REQUEST], limits: LIMITS, stopReason: 'end_turn', status: 'failed' },
    { end: 'the model stopping at its output limit', replies: [answer('And then', usage, { stopReason: 'max_tokens' })], limits: LIMITS, stopReason: 'end_turn', status: 'failed' },
    { end: 'a refusal', replies: [answer('I will not do that.', usage, { stopReason: 'refusal' })], limits: LIMITS, stopReason: 'refusal', status: 'failed' },
    { end: 'the limit on model calls', replies: [reading()], limits: { maxTurns: 1, maxCostUsd: 1 }, stopReason: 'max_turn_requests', status: 'failed' },
    { end: 'the cost limit', replies: [reading()], limits: { maxTurns: 10, maxCostUsd: 1e-9 }, stopReason: 'max_turn_requests', status: 'failed' },
  ] as const;

  it.each(ENDS)('a turn that ends on $end ends its task $status, with the $status notice', async ({ replies, limits, stopReason, status }) => {
    const engine = await setup(replies, limits);
    const { response, ended } = await engine.turn('Explain a.ts');
    expect(response.stopReason, 'ACP still gets one of its own stop reasons').toBe(stopReason);
    expect({ status: ended.task.status, notice: ended.notice }).toEqual({ status, notice: status });
    engine.close();
  });

  it('a turn the user stops ends its task stopped, with no notice', async () => {
    const engine = await setup([toolCall('Removing src.', [{ id: 'tu_rm', name: 'bash', input: { command: 'rm -rf src' } }], usage)]);
    const turn = engine.turn('Remove src');
    await until('the permission card', engine.asking);
    await engine.cancel();
    const { response, ended } = await turn;
    expect(response.stopReason).toBe('cancelled');
    expect({ status: ended.task.status, notice: ended.notice }).toEqual({ status: 'stopped', notice: null });
    engine.close();
  });
});
