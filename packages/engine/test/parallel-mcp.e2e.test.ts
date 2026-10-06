import { mkdir, mkdtemp, realpath, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import type { SessionMode, ToolResultEvent } from '@g-code/core';
import { startSession } from '../src/chat.js';
import type { Io } from '../src/command.js';
import { drive } from '../src/drive.js';
import { openMcpHub, type McpHub } from '../src/mcp/hub.js';
import { openStore } from '../src/store.js';
import type { Approval, PermissionAnswer } from '../src/tools/agent.js';
import { answer, fakeTransport, toolCall, type FakeToolUse } from './fake-transport.js';

const FIXTURE = fileURLToPath(new URL('./fake-mcp-server.ts', import.meta.url));
const TSX = import.meta.resolve('tsx');
const usage = { input: 2000, cacheRead: 0, cacheWrite: 0 };
const APPROVE_MS = 100;

const hubs: McpHub[] = [];
afterEach(async () => {
  await Promise.all(hubs.splice(0).map((hub) => hub.stop()));
});

/** Three echo calls, then an env call, in one turn, in `mode`, answering every question with `reply`. */
async function runEchoes(mode: SessionMode, reply: PermissionAnswer) {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), 'gcode-parallel-mcp-')));
  const workspace = path.join(root, 'ws');
  const home = path.join(root, 'home');
  const env = { GCODE_HOME: home, HOME: home, PATH: process.env['PATH'] ?? '/usr/bin:/bin', GCODE_PROVIDER: 'modelstudio', DASHSCOPE_API_KEY: 'sk-test', DASHSCOPE_BASE_URL: 'https://ws-1.example.com/apps/anthropic' };
  const store = openStore(env);
  await mkdir(workspace, { recursive: true });
  await mkdir(path.dirname(store.mcpConfigFile), { recursive: true });
  await writeFile(store.mcpConfigFile, JSON.stringify({ mcpServers: { fake: { command: process.execPath, args: ['--import', TSX, FIXTURE] } } }));
  const hub = await openMcpHub({ store, env, workspace, acp: [] });
  hubs.push(hub);
  await hub.start();

  const asked: string[] = [];
  let inFlight = 0;
  let mostInFlight = 0;
  const approval: Approval = {
    kind: 'interactive',
    mode: () => mode,
    approve: async (denial) => {
      asked.push(denial.command);
      mostInFlight = Math.max(mostInFlight, ++inFlight);
      await new Promise((resolve) => setTimeout(resolve, APPROVE_MS));
      inFlight--;
      return reply;
    },
    classify: async () => ({ verdict: 'ask', reason: 'unsure', model: 'fake', latencyMs: 1, costUsd: 0 }),
  };
  const toolset = await hub.toolset(approval);
  const uses: FakeToolUse[] = [
    { id: 'tu_1', name: 'mcp__fake__echo', input: { text: 'one' } },
    { id: 'tu_2', name: 'mcp__fake__echo', input: { text: 'two' } },
    { id: 'tu_3', name: 'mcp__fake__echo', input: { text: 'three' } },
    { id: 'tu_4', name: 'mcp__fake__env', input: {} },
  ];
  const transport = fakeTransport([toolCall('Echoing.', uses, usage), answer('Done.', usage)]);
  const io: Io = { env, cwd: workspace, out: () => {}, err: () => {}, write: () => {}, interrupts: () => new AbortController().signal, confirm: async () => false, fetch: transport.fetch };
  const opened = await startSession(store, io, { workspace, provider: undefined, model: undefined, effort: undefined });
  const result = await drive(io, store, opened, 'Echo three words.', { maxTurns: 5, maxCostUsd: 1 }, { tools: toolset.tools, executors: toolset.executors });
  expect(result.reason).toBe('end_turn');
  const logged = result.events.filter((e): e is ToolResultEvent => e.kind === 'tool-result');
  return { asked, mostInFlight, logged, executors: toolset.executors };
}

const output = (event: ToolResultEvent) => ('output' in event ? event.output : '');

describe('read-only MCP tools of one turn', () => {
  it('asks about each call one at a time and in the order of the calls when the mode asks', async () => {
    const { asked, mostInFlight, logged } = await runEchoes('ask', 'allow');

    expect(asked).toEqual(['mcp__fake__echo', 'mcp__fake__echo', 'mcp__fake__echo', 'mcp__fake__env']);
    expect(mostInFlight, 'never two questions at once').toBe(1);
    expect(logged.map((e) => [e.toolUseId, output(e)])).toEqual([
      ['tu_1', 'echo: one'],
      ['tu_2', 'echo: two'],
      ['tu_3', 'echo: three'],
      ['tu_4', expect.stringContaining('PATH')],
    ]);
    for (let i = 1; i < 4; i++) expect(logged[i]!.timing!.startAt).toBeGreaterThanOrEqual(logged[i - 1]!.timing!.endAt);
  });

  it('runs the calls after an "allow for the session" together, and still asks about a tool that is not read-only', async () => {
    const { asked, mostInFlight, logged } = await runEchoes('ask', 'allow-session');

    expect(asked).toEqual(['mcp__fake__echo', 'mcp__fake__env']);
    expect(mostInFlight).toBe(1);
    expect(logged.map((e) => output(e).slice(0, 11))).toEqual(['echo: one', 'echo: two', 'echo: three', expect.any(String)]);
    const [first, second, third] = logged.map((e) => e.timing!);
    expect(second!.startAt, 'the first call asked alone').toBeGreaterThanOrEqual(first!.endAt);
    expect(third!.startAt, 'the next two ran together').toBeLessThan(second!.endAt);
  });

  it('runs read-only calls together in Auto, which asks nobody about them', async () => {
    const { asked, logged, executors } = await runEchoes('auto', 'reject');

    expect(asked, 'env goes to the classifier, which sends it on to the user').toEqual(['mcp__fake__env']);
    const [first, second, third] = logged.map((e) => e.timing!);
    expect(Math.max(first!.startAt, second!.startAt, third!.startAt)).toBeLessThan(Math.min(first!.endAt, second!.endAt, third!.endAt) + 1);
    expect(executors['mcp__fake__echo']!.concurrent?.({})).toBe(true);
    expect(executors['mcp__fake__env']!.concurrent?.({}) ?? false).toBe(false);
  });
});
