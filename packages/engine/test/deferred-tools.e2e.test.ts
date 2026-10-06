import { mkdtemp, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as acp from '@agentclientprotocol/sdk';
import { afterEach, describe, expect, it } from 'vitest';
import { asSessionId, DEFERRED_TOOLS_NOTE, MCP_SERVERS_METHOD, TOOL_SEARCH_TOOL, type McpServersResponse, type TurnEvent } from '@g-code/core';
import type { Io } from '../src/command.js';
import { mcpSessions, type McpSessions } from '../src/mcp/sessions.js';
import { gcodeAgent } from '../src/serve.js';
import { readSessionLog, sessionFile } from '../src/sessions.js';
import { openStore } from '../src/store.js';
import { answer, fakeTransport, offeredTools, toolCall } from './fake-transport.js';
import { rgCommand } from './helpers.js';

const FIXTURE = fileURLToPath(new URL('./fake-mcp-server.ts', import.meta.url));
const TSX = import.meta.resolve('tsx');
const usage = { input: 1000, cacheRead: 0, cacheWrite: 0 };
const server: acp.McpServer = { name: 'fake', command: process.execPath, args: ['--import', TSX, FIXTURE], env: [] };
const ECHO = 'mcp__fake__echo';

const sessions: McpSessions[] = [];
afterEach(async () => {
  await Promise.all(sessions.splice(0).map((mcp) => mcp.stopAll()));
});

async function serversReady(ctx: acp.ClientContext, sessionId: string): Promise<void> {
  const until = Date.now() + 20_000;
  for (;;) {
    const { servers } = await ctx.request<McpServersResponse, { sessionId: string }>(MCP_SERVERS_METHOD, { sessionId });
    if (servers.every((s) => s.state.status === 'ready')) return;
    if (Date.now() > until) throw new Error('the MCP server did not start');
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

type Body = { tools: { name: string; description?: string }[]; system: { text: string }[]; messages: { content: string | { type: string; tool_use_id?: string; content?: string; is_error?: boolean }[] }[] };
const resultIn = (body: Body, id: string) => body.messages.flatMap((m) => (typeof m.content === 'string' ? [] : m.content)).find((b) => b.type === 'tool_result' && b.tool_use_id === id);

describe('deferred tools through gcode serve', () => {
  it('refuses an unloaded MCP tool, loads it with tool_search, calls it, and calls it again after a reload, with the same tool and system bytes on every call', async () => {
    const workspace = await realpath(await mkdtemp(path.join(tmpdir(), 'gcode-deferred-')));
    const env = {
      GCODE_HOME: await mkdtemp(path.join(tmpdir(), 'gcode-home-')),
      GCODE_PROVIDER: 'modelstudio',
      DASHSCOPE_API_KEY: 'sk-fake',
      DASHSCOPE_BASE_URL: 'https://ws-1.example.com/apps/anthropic',
      GCODE_RG: rgCommand(),
      PATH: process.env['PATH'] ?? '/usr/bin:/bin',
    };
    const early = { id: 'tu_early', name: ECHO, input: { text: 'too soon' } };
    const load = { id: 'tu_load', name: TOOL_SEARCH_TOOL, input: { query: 'echo' } };
    const first = { id: 'tu_first', name: ECHO, input: { text: 'one' } };
    const later = { id: 'tu_later', name: ECHO, input: { text: 'two' } };
    const transport = fakeTransport([
      toolCall('Echoing.', [early], usage),
      toolCall('Loading it.', [load], usage),
      toolCall('Echoing.', [first], usage),
      answer('Done.', usage),
      toolCall('Echoing again.', [later], usage),
      answer('Done again.', usage),
    ]);
    const io: Io = { env, cwd: workspace, out: () => {}, err: () => {}, write: () => {}, interrupts: () => new AbortController().signal, confirm: async () => false, fetch: transport.fetch };
    const store = openStore(env);
    const client = acp.client({ name: 'test-editor' }).onRequest(acp.methods.client.session.requestPermission, () => ({ outcome: { outcome: 'selected', optionId: 'allow-session' } }));
    // Each connection is a fresh engine on the same store, as after a restart of the editor.
    const engine = <T>(work: (ctx: acp.ClientContext) => Promise<T>) => {
      const mcp = mcpSessions(store, env);
      sessions.push(mcp);
      return client.connectWith(gcodeAgent(io, store, { maxTurns: 10, maxCostUsd: 1 }, mcp), async (ctx) => {
        await ctx.request(acp.methods.agent.initialize, { protocolVersion: acp.PROTOCOL_VERSION, clientCapabilities: {} });
        return work(ctx);
      });
    };
    const prompt = (ctx: acp.ClientContext, sessionId: string, text: string) => ctx.request(acp.methods.agent.session.prompt, { sessionId, prompt: [{ type: 'text', text }] });

    const sessionId = await engine(async (ctx) => {
      const { sessionId } = await ctx.request(acp.methods.agent.session.new, { cwd: workspace, mcpServers: [server] });
      await serversReady(ctx, sessionId);
      expect((await prompt(ctx, sessionId, 'echo one')).stopReason).toBe('end_turn');
      return sessionId;
    });
    await engine(async (ctx) => {
      await ctx.request(acp.methods.agent.session.load, { sessionId, cwd: workspace, mcpServers: [server] });
      await serversReady(ctx, sessionId);
      expect((await prompt(ctx, sessionId, 'echo two')).stopReason).toBe('end_turn');
    });

    const bodies = transport.requests.map((r) => r.body as Body);
    expect(bodies).toHaveLength(6);
    expect(bodies[0]!.tools.map((t) => t.name)).not.toContain(ECHO);
    expect(offeredTools(bodies[0]!), 'the MCP tool is listed by name in the deferred block').toContain(ECHO);
    expect(bodies[0]!.system[0]!.text).toContain(DEFERRED_TOOLS_NOTE);
    for (const body of bodies.slice(1)) {
      expect(JSON.stringify(body.tools), 'the tools are the same bytes on every call, across the load and the reload').toBe(JSON.stringify(bodies[0]!.tools));
      expect(body.system, 'and so is the system prompt').toEqual(bodies[0]!.system);
    }

    expect(resultIn(bodies[1]!, early.id)).toMatchObject({
      is_error: true,
      content: `${ECHO} is a deferred tool and is not loaded yet. Call tool_search with select: ["${ECHO}"] first, then call ${ECHO} with the input its schema asks for.`,
    });
    const loaded = resultIn(bodies[2]!, load.id)!;
    expect(loaded.is_error).toBeUndefined();
    expect(loaded.content).toContain(`"name":"${ECHO}"`);
    expect(loaded.content).toContain('"input_schema":');
    expect(resultIn(bodies[3]!, first.id)).toMatchObject({ content: 'echo: one' });
    expect(resultIn(bodies[5]!, later.id), 'the load survives the reload: no second tool_search').toMatchObject({ content: 'echo: two' });

    const { events } = await readSessionLog(sessionFile(store, asSessionId(sessionId)));
    const results = events.filter((e): e is Extract<TurnEvent, { kind: 'tool-result' }> => e.kind === 'tool-result');
    expect(results.map((e) => [e.name, e.status, e.loaded])).toEqual([
      [ECHO, 'error', undefined],
      [TOOL_SEARCH_TOOL, 'ok', [ECHO]],
      [ECHO, 'ok', undefined],
      [ECHO, 'ok', undefined],
    ]);
  }, 60_000);
});
