import { readFileSync } from 'node:fs';
import { mkdtemp, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import * as acp from '@agentclientprotocol/sdk';
import { describe, expect, it } from 'vitest';
import type { Io } from '../src/command.js';
import { gcodeAgent } from '../src/serve.js';
import { openStore } from '../src/store.js';
import { answer, fakeTransport, toolCall, type Reply } from './fake-transport.js';
import { makeRepo } from './git-fixture.js';
import { rgCommand } from './helpers.js';

const usage = { input: 1000, cacheRead: 0, cacheWrite: 0 };

/** One fake model per chat, picked by the marker in the chat's first message, so overlapping turns get their own replies. */
function routedTransport(chats: Readonly<Record<string, readonly Reply[]>>) {
  const routes = Object.entries(chats).map(([marker, replies]) => ({ marker, transport: fakeTransport(replies) }));
  const fetch: typeof globalThis.fetch = (input, init) => {
    const first = JSON.stringify(JSON.parse(String(init?.body)).messages[0]);
    const route = routes.find((r) => first.includes(r.marker));
    if (route === undefined) throw new Error(`no fake model for ${first.slice(0, 200)}`);
    return route.transport.fetch(input, init);
  };
  return { fetch, requests: (marker: string) => routes.find((r) => r.marker === marker)!.transport.requests };
}

const toolResultOf = (body: { messages: { content: unknown }[] }) =>
  (body.messages.at(-1)!.content as { type: string; content: string; is_error?: boolean }[]).find((block) => block.type === 'tool_result')!;

describe('gcode serve: two chats in one engine', () => {
  it('runs a turn in each chat while the other is still running a command', async () => {
    const first = await realpath(makeRepo('first', [{ message: 'start', files: { 'a.ts': 'export const a = 1;\n' } }]));
    const second = await realpath(makeRepo('second', [{ message: 'start', files: { 'b.ts': 'export const b = 1;\n' } }]));
    const home = await mkdtemp(path.join(tmpdir(), 'gcode-home-'));
    const env = {
      GCODE_HOME: home,
      GCODE_PROVIDER: 'modelstudio',
      DASHSCOPE_API_KEY: 'sk-fake',
      DASHSCOPE_BASE_URL: 'https://ws-1.example.com/apps/anthropic',
      GCODE_RG: rgCommand(),
      PATH: process.env['PATH'] ?? '/usr/bin:/bin',
    };
    const transport = routedTransport({
      '[first]': [toolCall('Waiting.', [{ id: 'tu_slow', name: 'bash', input: { command: 'pwd > made.txt && sleep 2' } }], usage), answer('Done.', usage)],
      '[second]': [toolCall('Writing.', [{ id: 'tu_fast', name: 'bash', input: { command: 'pwd > made.txt' } }], usage), answer('Done.', usage)],
    });
    const io: Io = {
      env,
      cwd: first,
      out: () => {},
      err: () => {},
      write: () => {},
      interrupts: () => new AbortController().signal,
      confirm: async () => false,
      fetch: transport.fetch,
    };
    const updates: acp.SessionNotification[] = [];
    let slowStarted!: () => void;
    const slowRunning = new Promise<void>((resolve) => (slowStarted = resolve));
    const client = acp
      .client({ name: 'test-editor' })
      .onRequest(acp.methods.client.session.requestPermission, () => ({ outcome: { outcome: 'selected', optionId: 'reject' } }))
      .onNotification(acp.methods.client.session.update, ({ params }) => {
        updates.push(params);
        if (params.update.sessionUpdate === 'tool_call' && params.update.toolCallId === 'tu_slow') slowStarted();
      });

    const [firstTurn, secondTurn] = await client.connectWith(gcodeAgent(io, openStore(env), { maxTurns: 10, maxCostUsd: 1 }), async (ctx) => {
      await ctx.request(acp.methods.agent.initialize, { protocolVersion: acp.PROTOCOL_VERSION, clientCapabilities: {} });
      const a = await ctx.request(acp.methods.agent.session.new, { cwd: first, mcpServers: [] });
      const b = await ctx.request(acp.methods.agent.session.new, { cwd: second, mcpServers: [] });
      const say = (sessionId: string, text: string) => ctx.request(acp.methods.agent.session.prompt, { sessionId, prompt: [{ type: 'text', text }] });
      const slow = say(a.sessionId, '[first] wait, then write');
      await slowRunning;
      const fast = say(b.sessionId, '[second] write now');
      return Promise.allSettled([slow, fast]);
    });

    expect(secondTurn, 'the second chat starts while the first runs its command').toEqual({ status: 'fulfilled', value: expect.objectContaining({ stopReason: 'end_turn' }) });
    expect(firstTurn).toEqual({ status: 'fulfilled', value: expect.objectContaining({ stopReason: 'end_turn' }) });
    expect(toolResultOf(transport.requests('[second]')[1]!.body).is_error).toBeFalsy();
    expect(toolResultOf(transport.requests('[first]')[1]!.body).is_error).toBeFalsy();
    expect(readFileSync(path.join(second, 'made.txt'), 'utf8')).toBe(`${second}\n`);
    expect(readFileSync(path.join(first, 'made.txt'), 'utf8')).toBe(`${first}\n`);
  });
});
