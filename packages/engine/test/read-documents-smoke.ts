// Run from the repository root: pnpm tsx packages/engine/test/read-documents-smoke.ts
// GCODE_ENV_FILE names the .env holding DASHSCOPE_API_KEY and DASHSCOPE_BASE_URL; it defaults to the repo's.
import { copyFile, mkdir, mkdtemp, readdir, readFile, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { parseEnv } from 'node:util';
import * as acp from '@agentclientprotocol/sdk';
import type { Io } from '../src/command.js';
import { gcodeAgent } from '../src/serve.js';
import { openStore } from '../src/store.js';
import { rgCommand } from './helpers.js';

const MODEL = 'qwen3.8-flash';
const BUDGET_USD = 0.03;

async function main(): Promise<number> {
  const root = path.resolve(import.meta.dirname, '../../..');
  const dotenv = parseEnv(await readFile(process.env['GCODE_ENV_FILE'] || path.join(root, '.env'), 'utf8'));
  const key = dotenv['DASHSCOPE_API_KEY'];
  const baseUrl = dotenv['DASHSCOPE_BASE_URL'];
  if (!key || !baseUrl) throw new Error('the .env needs DASHSCOPE_API_KEY and DASHSCOPE_BASE_URL');

  const work = await realpath(await mkdtemp(path.join(tmpdir(), 'gcode-pdf-smoke-')));
  const workspace = path.join(work, 'workspace');
  const home = path.join(work, 'home');
  await mkdir(workspace, { recursive: true });
  await copyFile(path.join(import.meta.dirname, 'fixtures', 'read', 'report.pdf'), path.join(workspace, 'report.pdf'));
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
  const tools: string[] = [];
  const client = acp
    .client({ name: 'read-documents-smoke' })
    .onRequest(acp.methods.client.session.requestPermission, () => ({ outcome: { outcome: 'selected', optionId: 'reject' } }))
    .onNotification(acp.methods.client.session.update, ({ params }) => {
      const { update } = params;
      if (update.sessionUpdate === 'agent_message_chunk' && update.content.type === 'text') answer += update.content.text;
      if (update.sessionUpdate === 'tool_call') tools.push(update.title ?? '');
    });

  await client.connectWith(gcodeAgent(io, openStore(env), { maxTurns: 6, maxCostUsd: BUDGET_USD }), async (ctx) => {
    await ctx.request(acp.methods.agent.initialize, { protocolVersion: acp.PROTOCOL_VERSION, clientCapabilities: {} });
    const { sessionId } = await ctx.request(acp.methods.agent.session.new, { cwd: workspace, mcpServers: [] });
    const prompt = 'Use the read tool on report.pdf. How many pages does it have, how many units did revenue grow to, and what heading starts its last page? Answer in one short sentence.';
    const { stopReason } = await ctx.request(acp.methods.agent.session.prompt, { sessionId, prompt: [{ type: 'text', text: prompt }] });
    console.log(`stop reason: ${stopReason}`);
  });

  const sessions = path.join(home, 'sessions');
  let cost = 0;
  let results: string[] = [];
  for (const file of (await readdir(sessions)).filter((f) => f.endsWith('.jsonl'))) {
    const events = (await readFile(path.join(sessions, file), 'utf8')).trim().split('\n').map((line) => JSON.parse(line));
    cost += events.filter((e) => e.kind === 'assistant').reduce((sum, e) => sum + (e.costUsd ?? 0), 0);
    results = events.filter((e) => e.kind === 'tool-result').map((e) => `${e.name}:${e.status}`);
  }
  const named = /4,?210/.test(answer) && /appendix/i.test(answer) && /\b(2|two)\b/i.test(answer);
  console.log(`answer: ${answer.trim()}`);
  console.log(`tool calls: ${tools.join(', ')}; results: ${results.join(', ')}`);
  console.log(`named 2 pages, 4,210 units and Appendix: ${named}`);
  console.log(`estimated cost: $${cost.toFixed(6)} (budget $${BUDGET_USD})`);
  const leaked = logs.some((line) => line.includes(key)) || answer.includes(key);
  const passed = named && results.includes('read:ok') && cost < BUDGET_USD && !leaked;
  console.log(`smoke: ${passed ? 'passed' : 'failed'}`);
  return passed ? 0 : 1;
}

void main().then((code) => (process.exitCode = code));
