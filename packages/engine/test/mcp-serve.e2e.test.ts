import { existsSync } from 'node:fs';
import { mkdtemp, readFile, realpath, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as acp from '@agentclientprotocol/sdk';
import { afterEach, describe, expect, it } from 'vitest';
import {
  APPROVAL_META,
  MCP_ENABLE_METHOD,
  MCP_SERVERS_METHOD,
  MCP_TRUST_METHOD,
  type McpEnableRequest,
  type McpServersResponse,
  type McpTrustRequest,
} from '@g-code/core';
import type { Io } from '../src/command.js';
import { mcpSessions, type McpSessions } from '../src/mcp/sessions.js';
import { gcodeAgent } from '../src/serve.js';
import { openStore } from '../src/store.js';
import { answer, fakeTransport, loadTools, offeredTools, toolCall, type Reply } from './fake-transport.js';
import { rgCommand } from './helpers.js';

const FIXTURE = fileURLToPath(new URL('./fake-mcp-server.ts', import.meta.url));
const TSX = import.meta.resolve('tsx');
const usage = { input: 1000, cacheRead: 0, cacheWrite: 0 };

const sessions: McpSessions[] = [];
afterEach(async () => {
  await Promise.all(sessions.splice(0).map((mcp) => mcp.stopAll()));
});

async function setup(replies: readonly Reply[], mcpJson?: unknown) {
  const workspace = await realpath(await mkdtemp(path.join(tmpdir(), 'gcode-mcp-serve-')));
  if (mcpJson !== undefined) await writeFile(path.join(workspace, '.mcp.json'), JSON.stringify(mcpJson));
  const env = {
    GCODE_HOME: await mkdtemp(path.join(tmpdir(), 'gcode-home-')),
    GCODE_PROVIDER: 'modelstudio',
    DASHSCOPE_API_KEY: 'sk-fake',
    DASHSCOPE_BASE_URL: 'https://ws-1.example.com/apps/anthropic',
    GCODE_RG: rgCommand(),
    PATH: process.env['PATH'] ?? '/usr/bin:/bin',
  };
  const transport = fakeTransport(replies);
  // Runs before the model call with this index answers, to change the world in the middle of a turn.
  let gate: (index: number) => Promise<void> = async () => {};
  const io: Io = {
    env,
    cwd: workspace,
    out: () => {},
    err: () => {},
    write: () => {},
    interrupts: () => new AbortController().signal,
    confirm: async () => false,
    fetch: async (input, init) => {
      await gate(transport.requests.length);
      return transport.fetch(input, init);
    },
  };
  const permissions: acp.RequestPermissionRequest[] = [];
  const updates: acp.SessionUpdate[] = [];
  let optionId = 'allow-session';
  const client = acp
    .client({ name: 'test-editor' })
    .onRequest(acp.methods.client.session.requestPermission, ({ params }) => {
      permissions.push(params);
      return { outcome: { outcome: 'selected', optionId } };
    })
    .onNotification(acp.methods.client.session.update, ({ params }) => {
      updates.push(params.update);
    });
  const store = openStore(env);
  const connect = <T>(servers: acp.McpServer[], work: (ctx: acp.ClientContext, sessionId: string) => Promise<T>) => {
    const mcp = mcpSessions(store, env);
    sessions.push(mcp);
    return client.connectWith(gcodeAgent(io, store, { maxTurns: 10, maxCostUsd: 1 }, mcp), async (ctx) => {
      const init = await ctx.request(acp.methods.agent.initialize, { protocolVersion: acp.PROTOCOL_VERSION, clientCapabilities: {} });
      expect(init.agentCapabilities?.mcpCapabilities).toEqual({ http: true, sse: true });
      const { sessionId } = await ctx.request(acp.methods.agent.session.new, { cwd: workspace, mcpServers: servers });
      return work(ctx, sessionId);
    });
  };
  return { workspace, transport, permissions, updates, connect, setAnswer: (id: string) => (optionId = id), setGate: (next: typeof gate) => (gate = next) };
}

/** Asks for the servers until `ready` holds of them, as the panel does while one is starting. */
async function serversUntil(ctx: acp.ClientContext, sessionId: string, ready: (servers: McpServersResponse['servers']) => boolean): Promise<McpServersResponse> {
  const until = Date.now() + 20_000;
  for (;;) {
    const response = await ctx.request<McpServersResponse, { sessionId: string }>(MCP_SERVERS_METHOD, { sessionId });
    if (ready(response.servers)) return response;
    if (Date.now() > until) throw new Error(`timed out; the servers are ${JSON.stringify(response.servers.map((s) => [s.name, s.state]))}`);
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

const allReady = (servers: McpServersResponse['servers']) => servers.every((server) => server.state.status === 'ready');

const isAlive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

async function until(check: () => boolean): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (!check()) {
    if (Date.now() > deadline) throw new Error('timed out');
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

const editorServer = (): acp.McpServer => ({ name: 'fake', command: process.execPath, args: ['--import', TSX, FIXTURE], env: [] });

describe('gcode serve with MCP', () => {
  it('offers an editor-provided server tool to the model, asks once with allow-for-session and allow-for-workspace options, and logs the approval', async () => {
    const first = { id: 'tu_mcp_1', name: 'mcp__fake__echo', input: { text: 'one' } };
    const second = { id: 'tu_mcp_2', name: 'mcp__fake__echo', input: { text: 'two' } };
    const { transport, permissions, updates, connect } = await setup([toolCall('', [loadTools('mcp__fake__echo')], usage), toolCall('Echoing.', [first], usage), toolCall('Again.', [second], usage), answer('Done.', usage)]);

    const stop = await connect([editorServer()], async (ctx, sessionId) => {
      await serversUntil(ctx, sessionId, allReady);
      return (await ctx.request(acp.methods.agent.session.prompt, { sessionId, prompt: [{ type: 'text', text: 'echo twice' }] })).stopReason;
    });

    expect(stop).toBe('end_turn');
    const tools = offeredTools(transport.requests[0]!.body);
    expect(tools.filter((name) => name.startsWith('mcp__'))).toEqual(['mcp__fake__crash', 'mcp__fake__echo', 'mcp__fake__env', 'mcp__fake__fail', 'mcp__fake__image', 'mcp__fake__screenshot']);
    expect((transport.requests[0]!.body.tools as { name: string }[]).map((tool) => tool.name), 'the core tools in full, the rest behind tool_search').toEqual(['bash', 'check', 'edit', 'glob', 'grep', 'list', 'read', 'skill', 'todo', 'tool_search']);
    for (const later of transport.requests.slice(1)) expect(JSON.stringify(later.body.tools), 'the tool list is the same bytes on every call, loads included').toBe(JSON.stringify(transport.requests[0]!.body.tools));

    expect(permissions).toHaveLength(1);
    expect(permissions[0]!.options.map((option) => option.optionId)).toEqual(['allow', 'allow-session', 'reject', 'allow-workspace', 'reject-with-comment']);
    expect(permissions[0]!.toolCall.rawInput).toEqual({ command: 'mcp__fake__echo', reason: 'a tool its MCP server calls read-only, which Geno cannot check', rule: 'mcp__fake__echo', subject: { kind: 'mcp', server: 'fake', tool: 'echo', arguments: '{\n  "text": "one"\n}' } });
    expect(JSON.stringify(transport.requests[2]!.body.messages)).toContain('echo: one');
    expect(JSON.stringify(transport.requests[3]!.body.messages)).toContain('echo: two');
    expect(updates).toContainEqual(
      expect.objectContaining({ sessionUpdate: 'tool_call_update', toolCallId: first.id, _meta: { [APPROVAL_META]: expect.objectContaining({ rule: 'mcp-read-only', decidedBy: 'user', verdict: 'allow' }) } }),
    );
  });

  it('shows an untrusted workspace server through the servers method, never starts it, and starts it once trusted over ACP', async () => {
    const marker = path.join(await mkdtemp(path.join(tmpdir(), 'gcode-mcp-marker-')), 'spawned');
    const server = { command: process.execPath, args: ['--import', TSX, FIXTURE], env: { MARKER: marker } };
    const { transport, connect } = await setup([answer('No tools.', usage), answer('Now with tools.', usage)], { mcpServers: { fake: server } });

    await connect([], async (ctx, sessionId) => {
      const before = await ctx.request<McpServersResponse, { sessionId: string }>(MCP_SERVERS_METHOD, { sessionId });
      expect(before.servers).toEqual([expect.objectContaining({ name: 'fake', source: 'mcp-json', state: { status: 'untrusted' }, tools: [] })]);

      await ctx.request(acp.methods.agent.session.prompt, { sessionId, prompt: [{ type: 'text', text: 'hi' }] });
      expect(offeredTools(transport.requests[0]!.body).some((name) => name.startsWith('mcp__'))).toBe(false);
      expect(existsSync(marker), 'an untrusted workspace server never spawns').toBe(false);

      const trusted = await ctx.request<McpServersResponse, McpTrustRequest>(MCP_TRUST_METHOD, { sessionId, name: 'fake', hash: before.servers[0]!.hash });
      expect(trusted.servers[0]!.state).toEqual({ status: 'stopped' });
      await expect(ctx.request(MCP_TRUST_METHOD, { sessionId, name: 'nope', hash: before.servers[0]!.hash })).rejects.toThrow(/no MCP server nope/);
      await serversUntil(ctx, sessionId, allReady);

      await ctx.request(acp.methods.agent.session.prompt, { sessionId, prompt: [{ type: 'text', text: 'again' }] });
      expect(offeredTools(transport.requests[1]!.body)).toContain('mcp__fake__echo');
      expect(existsSync(marker)).toBe(true);
    });
  });

  it('answers the first prompt without waiting for a cold server, keeps a turn\'s tools the same bytes, and adds the server\'s tools on the next turn', async () => {
    const pidFile = path.join(await mkdtemp(path.join(tmpdir(), 'gcode-mcp-pid-')), 'pid');
    const slow: acp.McpServer = { ...editorServer(), name: 'slow', env: [{ name: 'DELAY_MS', value: '2500' }, { name: 'MARKER', value: pidFile }] };
    const { transport, connect, setGate } = await setup([toolCall('Looking around.', [{ id: 'tu_list', name: 'list', input: {} }], usage), answer('First.', usage), answer('Second.', usage)]);
    const statesAtCall: string[] = [];

    await connect([slow], async (ctx, sessionId) => {
      const stateNow = async () => (await ctx.request<McpServersResponse, { sessionId: string }>(MCP_SERVERS_METHOD, { sessionId })).servers[0]!.state.status;
      setGate(async (index) => {
        statesAtCall.push(await stateNow());
        // The server finishes starting in the middle of the first turn, between its two model calls.
        if (index === 1) await serversUntil(ctx, sessionId, allReady);
      });

      const first = await ctx.request(acp.methods.agent.session.prompt, { sessionId, prompt: [{ type: 'text', text: 'look around' }] });
      expect(first.stopReason).toBe('end_turn');
      await ctx.request(acp.methods.agent.session.prompt, { sessionId, prompt: [{ type: 'text', text: 'again' }] });

      await ctx.request(acp.methods.agent.session.close, { sessionId });
      await expect(ctx.request(acp.methods.agent.session.prompt, { sessionId, prompt: [{ type: 'text', text: 'closed' }] })).rejects.toThrow(/no session/);
    });

    const names = (index: number) => offeredTools(transport.requests[index]!.body);
    expect(statesAtCall[0], 'the first model call went out while the server was still starting').toBe('starting');
    expect(names(0).some((name) => name.startsWith('mcp__')), 'the first prompt does not wait for the cold server').toBe(false);
    expect(statesAtCall[1]).toBe('starting');
    expect(JSON.stringify(transport.requests[1]!.body.tools), 'a server ready mid-turn does not change that turn\'s tool bytes').toBe(JSON.stringify(transport.requests[0]!.body.tools));
    expect(names(2), 'the next turn has the server\'s tools').toContain('mcp__slow__echo');
    const pid = Number(await readFile(pidFile, 'utf8'));
    await until(() => !isAlive(pid));
  });

  it('turns a server off and on over ACP, and refuses to trust a definition other than the one shown', async () => {
    const marker = path.join(await mkdtemp(path.join(tmpdir(), 'gcode-mcp-marker-')), 'spawned');
    const server = { command: process.execPath, args: ['--import', TSX, FIXTURE], env: { MARKER: marker } };
    const { transport, connect } = await setup([answer('Off.', usage), answer('On.', usage)], { mcpServers: { fake: server } });

    await connect([], async (ctx, sessionId) => {
      const { servers } = await ctx.request<McpServersResponse, { sessionId: string }>(MCP_SERVERS_METHOD, { sessionId });
      expect(servers[0]!.definition).toEqual({ kind: 'stdio', commandLine: `${process.execPath} --import ${TSX} ${FIXTURE}`, cwd: undefined, env: [['MARKER', marker]] });
      await expect(ctx.request(MCP_TRUST_METHOD, { sessionId, name: 'fake', hash: 'sha256:stale' })).rejects.toThrow(/changed since it was shown/);
      expect(existsSync(marker)).toBe(false);

      const off = await ctx.request<McpServersResponse, McpEnableRequest>(MCP_ENABLE_METHOD, { sessionId, name: 'fake', enabled: false });
      expect(off.servers[0]!.state).toEqual({ status: 'disabled', trusted: false });
      await ctx.request<McpServersResponse, McpTrustRequest>(MCP_TRUST_METHOD, { sessionId, name: 'fake', hash: servers[0]!.hash });
      await ctx.request(acp.methods.agent.session.prompt, { sessionId, prompt: [{ type: 'text', text: 'off' }] });
      expect(existsSync(marker), 'a disabled server does not start, even once trusted').toBe(false);

      await ctx.request<McpServersResponse, McpEnableRequest>(MCP_ENABLE_METHOD, { sessionId, name: 'fake', enabled: true });
      await serversUntil(ctx, sessionId, allReady);
      await ctx.request(acp.methods.agent.session.prompt, { sessionId, prompt: [{ type: 'text', text: 'on' }] });
    });
    expect(offeredTools(transport.requests[0]!.body).some((name) => name.startsWith('mcp__'))).toBe(false);
    expect(offeredTools(transport.requests[1]!.body)).toContain('mcp__fake__echo');
  });
});
