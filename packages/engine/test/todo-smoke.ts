// Run from the repository root: pnpm tsx packages/engine/test/todo-smoke.ts
// GCODE_ENV_FILE names the .env holding DASHSCOPE_API_KEY and DASHSCOPE_BASE_URL; it defaults to the repo's.
import { mkdir, mkdtemp, readdir, readFile, realpath, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { parseEnv } from 'node:util';
import * as acp from '@agentclientprotocol/sdk';
import { TODO_META, todoLine, type TodoList } from '@g-code/core';
import type { Io } from '../src/command.js';
import { gcodeAgent } from '../src/serve.js';
import { openStore } from '../src/store.js';
import { rgCommand } from './helpers.js';

const MODEL = 'qwen3.8-flash';
const BUDGET_USD = 0.04;

async function main(): Promise<number> {
  const root = path.resolve(import.meta.dirname, '../../..');
  const dotenv = parseEnv(await readFile(process.env['GCODE_ENV_FILE'] || path.join(root, '.env'), 'utf8'));
  const key = dotenv['DASHSCOPE_API_KEY'];
  const baseUrl = dotenv['DASHSCOPE_BASE_URL'];
  if (!key || !baseUrl) throw new Error('the .env needs DASHSCOPE_API_KEY and DASHSCOPE_BASE_URL');

  const work = await realpath(await mkdtemp(path.join(tmpdir(), 'gcode-todo-smoke-')));
  const workspace = path.join(work, 'workspace');
  const home = path.join(work, 'home');
  await mkdir(workspace, { recursive: true });
  await writeFile(path.join(workspace, 'math.ts'), 'export const add = (a: number, b: number) => a + b;\n');
  const env = {
    GCODE_HOME: home,
    GCODE_PROVIDER: 'modelstudio',
    GCODE_MODEL: MODEL,
    DASHSCOPE_API_KEY: key,
    DASHSCOPE_BASE_URL: baseUrl,
    GCODE_RG: rgCommand(),
    PATH: process.env['PATH'] ?? '/usr/bin:/bin',
  };
  const logs: string[] = [];
  const io: Io = {
    env,
    cwd: workspace,
    out: (line) => logs.push(line),
    err: (line) => logs.push(line),
    write: () => {},
    interrupts: () => new AbortController().signal,
    confirm: async () => false,
    fetch: globalThis.fetch,
  };
  let answer = '';
  const shown = new Map<string, TodoList>();
  const client = acp
    .client({ name: 'todo-smoke' })
    .onRequest(acp.methods.client.session.requestPermission, () => ({ outcome: { outcome: 'selected', optionId: 'reject' } }))
    .onNotification(acp.methods.client.session.update, ({ params }) => {
      const { update } = params;
      if (update.sessionUpdate === 'agent_message_chunk' && update.content.type === 'text') answer += update.content.text;
      const meta = update.sessionUpdate === 'tool_call_update' ? (update._meta?.[TODO_META] as { items: TodoList } | undefined) : undefined;
      if (meta !== undefined && update.sessionUpdate === 'tool_call_update') shown.set(update.toolCallId, meta.items);
    });

  await client.connectWith(gcodeAgent(io, openStore(env), { maxTurns: 12, maxCostUsd: BUDGET_USD }), async (ctx) => {
    await ctx.request(acp.methods.agent.initialize, { protocolVersion: acp.PROTOCOL_VERSION, clientCapabilities: {} });
    const { sessionId } = await ctx.request(acp.methods.agent.session.new, { cwd: workspace, mcpServers: [] });
    const prompt =
      'Use the todo tool to keep a list of these three steps, and tick each off as you finish it: 1. add a `sub` export to math.ts that subtracts b from a; 2. add a `mul` export that multiplies them; 3. read math.ts back and tell me how many exports it has. Answer in one short sentence.';
    const { stopReason } = await ctx.request(acp.methods.agent.session.prompt, { sessionId, prompt: [{ type: 'text', text: prompt }] });
    console.log(`stop reason: ${stopReason}`);
  });

  let cost = 0;
  const sessions = path.join(home, 'sessions');
  for (const file of (await readdir(sessions)).filter((f) => f.endsWith('.jsonl'))) {
    const events = (await readFile(path.join(sessions, file), 'utf8')).trim().split('\n').map((line) => JSON.parse(line));
    cost += events.filter((e) => e.kind === 'assistant').reduce((sum, e) => sum + (e.costUsd ?? 0), 0);
  }
  const lists = [...shown.values()];
  for (const list of lists) console.log(`list: ${todoLine(list)} [${list.map((item) => `${item.id}:${item.status}`).join(' ')}]`);
  const source = await readFile(path.join(workspace, 'math.ts'), 'utf8');
  const kept = lists.length >= 2 && lists.every((list) => list.length === 3) && lists.at(-1)!.every((item) => item.status === 'done');
  const built = /export const sub\b/.test(source) && /export const mul\b/.test(source);
  console.log(`answer: ${answer.trim()}`);
  console.log(`kept a 3-item list to the end, all done: ${kept}; math.ts has sub and mul: ${built}`);
  console.log(`estimated cost: $${cost.toFixed(6)} (budget $${BUDGET_USD})`);
  const leaked = logs.some((line) => line.includes(key)) || answer.includes(key);
  const passed = kept && built && cost < BUDGET_USD && !leaked;
  console.log(`smoke: ${passed ? 'passed' : 'failed'}`);
  return passed ? 0 : 1;
}

void main().then((code) => (process.exitCode = code));
