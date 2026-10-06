import { mkdtemp, realpath, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import * as acp from '@agentclientprotocol/sdk';
import { describe, expect, it } from 'vitest';
import {
  asSessionId,
  CHECKPOINT_TEXT_METHOD,
  EDITOR_ACTION_META,
  EDITOR_ACTION_METHOD,
  EDITOR_ACTIONS_CAPABILITY,
  type CheckpointTextResponse,
  type EditorAction,
  type EditorActionRequest,
  type TurnEvent,
} from '@g-code/core';
import { runAgent } from '../src/agent.js';
import { startSession } from '../src/chat.js';
import type { Io } from '../src/command.js';
import { gcodeAgent } from '../src/serve.js';
import { readSessionLog, sessionFile } from '../src/sessions.js';
import { openStore } from '../src/store.js';
import { answer, fakeTransport, toolCall, type FakeToolUse, type Reply } from './fake-transport.js';
import { makeRepo } from './git-fixture.js';

const usage = { input: 1000, cacheRead: 0, cacheWrite: 0 };
const EDITOR_TOOLS = ['open_file', 'reveal', 'show_diff'];

async function setup(replies: readonly Reply[], capable = true) {
  const workspace = await realpath(makeRepo('ws', [{ message: 'start', files: { 'a.ts': 'export const a = 1;\n', 'b.ts': 'export const b = 1;\n', 'src/c.ts': 'export const c = 1;\n' } }]));
  const home = await mkdtemp(path.join(tmpdir(), 'gcode-home-'));
  const env = { GCODE_HOME: home, GCODE_PROVIDER: 'modelstudio', DASHSCOPE_API_KEY: 'sk-fake', DASHSCOPE_BASE_URL: 'https://ws-1.example.com/apps/anthropic' };
  const transport = fakeTransport(replies);
  const io: Io = { env, cwd: workspace, out: () => {}, err: () => {}, write: () => {}, interrupts: () => new AbortController().signal, confirm: async () => false, fetch: transport.fetch };
  const updates: acp.SessionUpdate[] = [];
  const actions: EditorAction[] = [];
  const permissions: string[] = [];
  const client = acp
    .client({ name: 'test-editor' })
    .onNotification(acp.methods.client.session.update, ({ params }) => {
      updates.push(params.update);
    })
    .onRequest(acp.methods.client.session.requestPermission, ({ params }) => {
      permissions.push(params.toolCall.title ?? '');
      return { outcome: { outcome: 'cancelled' } };
    })
    .onRequest(EDITOR_ACTION_METHOD, (raw) => raw as EditorActionRequest, ({ params }) => {
      actions.push(params.action);
      return {};
    });
  const connect = <T>(work: (ctx: acp.ClientContext) => Promise<T>) =>
    client.connectWith(gcodeAgent(io, openStore(env), { maxTurns: 10, maxCostUsd: 1 }), async (ctx) => {
      await ctx.request(acp.methods.agent.initialize, { protocolVersion: acp.PROTOCOL_VERSION, clientCapabilities: capable ? { _meta: { [EDITOR_ACTIONS_CAPABILITY]: true } } : {} });
      return work(ctx);
    });
  const open = async (ctx: acp.ClientContext) => (await ctx.request(acp.methods.agent.session.new, { cwd: workspace, mcpServers: [] })).sessionId;
  const say = (ctx: acp.ClientContext, sessionId: string, text: string) => ctx.request(acp.methods.agent.session.prompt, { sessionId, prompt: [{ type: 'text', text }] });
  const results = async (sessionId: string) =>
    (await readSessionLog(sessionFile(openStore(env), asSessionId(sessionId)))).events.filter((e): e is Extract<TurnEvent, { kind: 'tool-result' }> => e.kind === 'tool-result');
  const checkpoints = async (sessionId: string) =>
    (await readSessionLog(sessionFile(openStore(env), asSessionId(sessionId)))).events.filter((e): e is Extract<TurnEvent, { kind: 'checkpoint' }> => e.kind === 'checkpoint');
  return { workspace, home, env, io, transport, updates, actions, permissions, connect, open, say, results, checkpoints };
}

const toolNames = (body: { tools: { name: string }[] }) => body.tools.map((t) => t.name);
const call = (id: string, name: string, input: unknown): FakeToolUse => ({ id, name, input });
const outputOf = (result: Extract<TurnEvent, { kind: 'tool-result' }>) => ('output' in result ? result.output : '');

describe('gcode serve: editor actions', () => {
  it('are offered, sorted after the other tools, only to an editor that carries them out', async () => {
    const attached = await setup([answer('a', usage)]);
    await attached.connect(async (ctx) => attached.say(ctx, await attached.open(ctx), 'hi'));
    const names = toolNames(attached.transport.requests[0]!.body);
    expect(names.filter((name) => EDITOR_TOOLS.includes(name))).toEqual(EDITOR_TOOLS);
    expect(names.slice(names.indexOf('open_file'), names.indexOf('open_file') + 3), 'one sorted block').toEqual(EDITOR_TOOLS);

    const headless = await setup([answer('a', usage)], false);
    await headless.connect(async (ctx) => headless.say(ctx, await headless.open(ctx), 'hi'));
    expect(toolNames(headless.transport.requests[0]!.body).filter((name) => EDITOR_TOOLS.includes(name))).toEqual([]);
  });

  it('are never offered to a run with nobody watching, whatever the caller passes', async () => {
    const { transport, workspace, io } = await setup([answer('Done.', usage)]);
    const store = openStore(io.env);
    const opened = await startSession(store, io, { workspace, provider: undefined, model: undefined, effort: undefined });
    const editor = async () => {
      throw new Error('a headless run must not reach the editor');
    };
    await runAgent(io, store, opened, 'open it', { limits: { maxTurns: 2, maxCostUsd: 1 }, check: undefined, checkAfterEdit: false, approval: { kind: 'non-interactive', mcp: false }, editor });
    expect(toolNames(transport.requests[0]!.body).filter((name) => EDITOR_TOOLS.includes(name))).toEqual([]);
  });

  it('run in Plan mode without asking, and the step carries the action to repeat', async () => {
    const { connect, open, say, actions, permissions, results, updates, workspace } = await setup([
      toolCall('', [call('tu_o', 'open_file', { path: 'a.ts', line: 1, column: 8 }), call('tu_r', 'reveal', { path: 'src' })], usage),
      answer('There.', usage),
    ]);
    await connect(async (ctx) => {
      const id = await open(ctx);
      await ctx.request(acp.methods.agent.session.setMode, { sessionId: id, modeId: 'plan' });
      await say(ctx, id, 'where is a defined? open it for me');
      return id;
    }).then(async (id) => {
      const [opened, revealed] = await results(id);
      expect(opened!.status).toBe('ok');
      expect(outputOf(opened!)).toBe("Opened a.ts:1:8 in the user's editor.");
      expect(revealed!.status).toBe('ok');
      expect(opened!.editorAction).toEqual({ kind: 'open', path: path.join(workspace, 'a.ts'), line: 1, column: 8 });
    });
    expect(permissions, 'nothing asked').toEqual([]);
    expect(actions).toEqual([
      { kind: 'open', path: path.join(workspace, 'a.ts'), line: 1, column: 8 },
      { kind: 'reveal', path: path.join(workspace, 'src') },
    ]);
    const done = (updates as (acp.SessionUpdate & { toolCallId?: string; status?: string; _meta?: Record<string, unknown> })[]).find((u) => u.toolCallId === 'tu_o' && u.status === 'completed' && u._meta !== undefined);
    expect(done!._meta![EDITOR_ACTION_META]).toEqual(actions[0]);
  });

  it('refuse a path outside the workspace, through a symlink too, and never reach the editor', async () => {
    const outside = await realpath(await mkdtemp(path.join(tmpdir(), 'gcode-outside-')));
    await writeFile(path.join(outside, 'secret.ts'), 'secret\n');
    const { connect, open, say, actions, results, workspace } = await setup([
      toolCall(
        '',
        [
          call('tu_1', 'open_file', { path: '../secret.ts' }),
          call('tu_2', 'open_file', { path: path.join(outside, 'secret.ts') }),
          call('tu_3', 'reveal', { path: 'link/secret.ts' }),
          call('tu_4', 'show_diff', { path: '/etc/hosts' }),
          call('tu_5', 'open_file', { path: 'src' }),
        ],
        usage,
      ),
      answer('Cannot.', usage),
    ]);
    await symlink(outside, path.join(workspace, 'link'));
    const id = await connect(async (ctx) => {
      const sessionId = await open(ctx);
      await say(ctx, sessionId, 'open the secret');
      return sessionId;
    });
    const refused = await results(id);
    expect(refused.map((r) => r.status)).toEqual(['error', 'error', 'error', 'error', 'error']);
    expect(refused.slice(0, 4).map(outputOf)).toEqual([
      '../secret.ts is outside the workspace',
      `${path.join(outside, 'secret.ts')} is outside the workspace`,
      'link/secret.ts is outside the workspace',
      '/etc/hosts is outside the workspace',
    ]);
    expect(outputOf(refused[4]!)).toContain('src is a folder');
    expect(refused.every((r) => r.editorAction === undefined)).toBe(true);
    expect(actions).toEqual([]);
  });

  it("show_diff diffs against the turn's checkpoint when the turn changed the file, else the session's first", async () => {
    const { connect, open, say, actions, results, checkpoints, workspace } = await setup([
      toolCall('', [call('tu_ra', 'read', { path: 'a.ts' })], usage),
      toolCall('', [call('tu_ea', 'edit', { path: 'a.ts', old_str: 'a = 1', new_str: 'a = 2' })], usage),
      answer('Changed a.', usage),
      toolCall('', [call('tu_rb', 'read', { path: 'b.ts' })], usage),
      toolCall('', [call('tu_eb', 'edit', { path: 'b.ts', old_str: 'b = 1', new_str: 'b = 2' })], usage),
      toolCall('', [call('tu_db', 'show_diff', { path: 'b.ts' }), call('tu_da', 'show_diff', { path: 'a.ts' })], usage),
      answer('Here are both.', usage),
    ]);
    const texts = await connect(async (ctx) => {
      const id = await open(ctx);
      await ctx.request(acp.methods.agent.session.setMode, { sessionId: id, modeId: 'auto' });
      await say(ctx, id, 'change a');
      await say(ctx, id, 'change b and show me both');
      const sides = [];
      for (const action of actions) {
        if (action.kind !== 'diff') continue;
        sides.push((await ctx.request<CheckpointTextResponse>(CHECKPOINT_TEXT_METHOD, { sessionId: id, path: action.path, sha: action.base.sha })).text);
      }
      await expect(ctx.request(CHECKPOINT_TEXT_METHOD, { sessionId: id, path: path.join(workspace, 'a.ts'), sha: 'f'.repeat(40) })).rejects.toThrow(/no such checkpoint/);
      return { id, sides };
    });
    const all = await checkpoints(texts.id);
    const diffs = (await results(texts.id)).filter((r) => r.name === 'show_diff');
    expect(actions).toEqual([
      { kind: 'diff', path: path.join(workspace, 'b.ts'), base: { sha: expect.any(String), since: 'turn' } },
      { kind: 'diff', path: path.join(workspace, 'a.ts'), base: { sha: all[0]!.sha, since: 'session' } },
    ]);
    const bBase = (actions[0] as Extract<EditorAction, { kind: 'diff' }>).base.sha;
    expect(bBase, "the second turn's checkpoint, not the session's first").not.toBe(all[0]!.sha);
    expect(all.map((c) => c.sha)).toContain(bBase);
    expect(texts.sides, 'the left sides hold the files before the change').toEqual(['export const b = 1;\n', 'export const a = 1;\n']);
    expect(diffs.map(outputOf)).toEqual([
      'Showed the user the diff of b.ts against the file before this turn.',
      'Showed the user the diff of a.ts against the file when the session began, since this turn did not change it.',
    ]);
  });

  it('replays the action with the step when the session is loaded', async () => {
    const { connect, open, say, updates, workspace } = await setup([toolCall('', [call('tu_o', 'open_file', { path: 'b.ts', line: 1 })], usage), answer('Done.', usage)]);
    const id = await connect(async (ctx) => {
      const sessionId = await open(ctx);
      await say(ctx, sessionId, 'open b');
      return sessionId;
    });
    updates.length = 0;
    await connect((ctx) => ctx.request(acp.methods.agent.session.load, { sessionId: id, cwd: workspace, mcpServers: [] }));
    const replayed = (updates as (acp.SessionUpdate & { toolCallId?: string; _meta?: Record<string, unknown> })[]).find((u) => u.sessionUpdate === 'tool_call_update' && u.toolCallId === 'tu_o');
    expect(replayed!._meta![EDITOR_ACTION_META]).toEqual({ kind: 'open', path: path.join(workspace, 'b.ts'), line: 1 });
  });
});
