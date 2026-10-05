import { existsSync } from 'node:fs';
import { mkdtemp, realpath, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as acp from '@agentclientprotocol/sdk';
import { afterEach, describe, expect, it } from 'vitest';
import { APPROVAL_META, MCP_SERVERS_METHOD, MCP_TRUST_METHOD, type McpServersResponse, type McpTrustRequest } from '@g-code/core';
import type { Io } from '../src/command.js';
import { mcpSessions, type McpSessions } from '../src/mcp/sessions.js';
import { gcodeAgent } from '../src/serve.js';
import { openStore } from '../src/store.js';
import { answer, fakeTransport, toolCall, type Reply } from './fake-transport.js';
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
  const io: Io = {
    env,
    cwd: workspace,
    out: () => {},
    err: () => {},
    write: () => {},
    interrupts: () => new AbortController().signal,
    confirm: async () => false,
    fetch: transport.fetch,
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
  return { workspace, transport, permissions, updates, connect, setAnswer: (id: string) => (optionId = id) };
}

const editorServer = (): acp.McpServer => ({ name: 'fake', command: process.execPath, args: ['--import', TSX, FIXTURE], env: [] });

describe('gcode serve with MCP', () => {
  it('offers an editor-provided server tool to the model, asks once with an allow-for-session option, and logs the approval', async () => {
    const first = { id: 'tu_mcp_1', name: 'mcp__fake__echo', input: { text: 'one' } };
    const second = { id: 'tu_mcp_2', name: 'mcp__fake__echo', input: { text: 'two' } };
    const { transport, permissions, updates, connect } = await setup([toolCall('Echoing.', [first], usage), toolCall('Again.', [second], usage), answer('Done.', usage)]);

    const stop = await connect([editorServer()], async (ctx, sessionId) =>
      (await ctx.request(acp.methods.agent.session.prompt, { sessionId, prompt: [{ type: 'text', text: 'echo twice' }] })).stopReason,
    );

    expect(stop).toBe('end_turn');
    const tools = (transport.requests[0]!.body.tools as { name: string }[]).map((tool) => tool.name);
    expect(tools.filter((name) => name.startsWith('mcp__'))).toEqual(['mcp__fake__crash', 'mcp__fake__echo', 'mcp__fake__env', 'mcp__fake__fail', 'mcp__fake__image', 'mcp__fake__screenshot']);
    expect(tools.slice(0, tools.indexOf('mcp__fake__crash')), 'the built-in tools keep their cached place first').toEqual(['bash', 'check', 'edit', 'glob', 'grep', 'list', 'read']);
    expect(JSON.stringify(transport.requests[1]!.body.tools), 'the tool list is the same bytes on the next call').toBe(JSON.stringify(transport.requests[0]!.body.tools));

    expect(permissions).toHaveLength(1);
    expect(permissions[0]!.options.map((option) => option.optionId)).toEqual(['allow', 'allow-session', 'reject']);
    expect(permissions[0]!.toolCall.rawInput).toEqual({ command: 'mcp__fake__echo', reason: 'an MCP tool its server marks read-only' });
    expect(JSON.stringify(transport.requests[1]!.body.messages)).toContain('echo: one');
    expect(JSON.stringify(transport.requests[2]!.body.messages)).toContain('echo: two');
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
      expect((transport.requests[0]!.body.tools as { name: string }[]).some((tool) => tool.name.startsWith('mcp__'))).toBe(false);
      expect(existsSync(marker), 'an untrusted workspace server never spawns').toBe(false);

      const trusted = await ctx.request<McpServersResponse, McpTrustRequest>(MCP_TRUST_METHOD, { sessionId, name: 'fake' });
      expect(trusted.servers[0]!.state).toEqual({ status: 'stopped' });
      await expect(ctx.request(MCP_TRUST_METHOD, { sessionId, name: 'nope' })).rejects.toThrow(/no MCP server nope/);

      await ctx.request(acp.methods.agent.session.prompt, { sessionId, prompt: [{ type: 'text', text: 'again' }] });
      expect((transport.requests[1]!.body.tools as { name: string }[]).map((tool) => tool.name)).toContain('mcp__fake__echo');
      expect(existsSync(marker)).toBe(true);
    });
  });
});
