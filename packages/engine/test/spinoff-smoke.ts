// Run from the repository root: pnpm tsx packages/engine/test/spinoff-smoke.ts
// GCODE_ENV_FILE names the .env holding DASHSCOPE_API_KEY and DASHSCOPE_BASE_URL; it defaults to the repo's.
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readdir, readFile, realpath, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { parseEnv } from 'node:util';
import * as acp from '@agentclientprotocol/sdk';
import { parseSpinoffShown, SPINOFF_CAPABILITY, SPINOFF_META, type Spinoff } from '@g-code/core';
import type { Io } from '../src/command.js';
import { gcodeAgent } from '../src/serve.js';
import { openStore } from '../src/store.js';
import { rgCommand } from './helpers.js';

const MODEL = 'qwen3.8-flash';
const BUDGET_USD = 0.012;

const MATH = `export const add = (a: number, b: number) => a + b;

export const sub = (a: number, b: number) => a + b;

// TODO: delete legacyMul once nothing imports it; it is the pre-v2 multiply.
export const legacyMul = (a: number, b: number) => Array.from({ length: b }, () => a).reduce((n, x) => n + x, 0);
`;

async function main(): Promise<number> {
  const root = path.resolve(import.meta.dirname, '../../..');
  const dotenv = parseEnv(await readFile(process.env['GCODE_ENV_FILE'] || path.join(root, '.env'), 'utf8'));
  const key = dotenv['DASHSCOPE_API_KEY'];
  const baseUrl = dotenv['DASHSCOPE_BASE_URL'];
  if (!key || !baseUrl) throw new Error('the .env needs DASHSCOPE_API_KEY and DASHSCOPE_BASE_URL');

  const work = await realpath(await mkdtemp(path.join(tmpdir(), 'gcode-spinoff-smoke-')));
  const workspace = path.join(work, 'workspace');
  const home = path.join(work, 'home');
  await mkdir(path.join(workspace, 'src'), { recursive: true });
  await writeFile(path.join(workspace, 'src', 'math.ts'), MATH);
  await writeFile(path.join(workspace, 'src', 'main.ts'), "import { add, sub } from './math.js';\n\nconsole.log(add(2, 3), sub(5, 2));\n");
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: workspace });
  execFileSync('git', ['-c', 'user.name=smoke', '-c', 'user.email=smoke@example.com', 'add', '.'], { cwd: workspace });
  execFileSync('git', ['-c', 'user.name=smoke', '-c', 'user.email=smoke@example.com', 'commit', '-q', '-m', 'start'], { cwd: workspace });
  const env = {
    GCODE_HOME: home,
    HOME: home,
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
  const steps: string[] = [];
  const offered = new Map<string, Spinoff>();
  const moves: string[] = [];
  const client = acp
    .client({ name: 'spinoff-smoke' })
    .onRequest(acp.methods.client.session.requestPermission, () => ({ outcome: { outcome: 'selected', optionId: 'reject' } }))
    .onNotification(acp.methods.client.session.update, ({ params }) => {
      const { update } = params;
      if (update.sessionUpdate === 'agent_message_chunk' && update.content.type === 'text') answer += update.content.text;
      if (update.sessionUpdate === 'tool_call') steps.push(update.title);
      const shown = update.sessionUpdate === 'tool_call_update' ? parseSpinoffShown(update._meta?.[SPINOFF_META]) : undefined;
      if (shown?.kind === 'offer') offered.set(shown.spinoff.id, shown.spinoff);
      if (shown?.kind === 'move') moves.push(`${shown.id} ${shown.state.kind}`);
    });

  await client.connectWith(gcodeAgent(io, openStore(env), { maxTurns: 14, maxCostUsd: BUDGET_USD }), async (ctx) => {
    await ctx.request(acp.methods.agent.initialize, { protocolVersion: acp.PROTOCOL_VERSION, clientCapabilities: { _meta: { [SPINOFF_CAPABILITY]: true } } });
    const { sessionId } = await ctx.request(acp.methods.agent.session.new, { cwd: workspace, mcpServers: [] });
    await ctx.request(acp.methods.agent.session.setMode, { sessionId, modeId: 'auto' });
    const prompt = '`sub` in src/math.ts adds instead of subtracting. Fix only that function, then tell me in one sentence what you changed.';
    const { stopReason } = await ctx.request(acp.methods.agent.session.prompt, { sessionId, prompt: [{ type: 'text', text: prompt }] });
    console.log(`stop reason: ${stopReason}`);
  });

  let cost = 0;
  const sessions = path.join(home, 'sessions');
  for (const file of (await readdir(sessions)).filter((f) => f.endsWith('.jsonl'))) {
    const events = (await readFile(path.join(sessions, file), 'utf8')).trim().split('\n').map((line) => JSON.parse(line));
    cost += events.filter((e) => e.kind === 'assistant').reduce((sum, e) => sum + (e.costUsd ?? 0), 0);
  }
  const source = await readFile(path.join(workspace, 'src', 'math.ts'), 'utf8');
  console.log(`steps: ${steps.join(' | ')}`);
  for (const spinoff of offered.values()) console.log(`suggested ${spinoff.id}: ${spinoff.title}\n  tldr: ${spinoff.tldr}\n  prompt: ${spinoff.prompt}`);
  for (const move of moves) console.log(`moved: ${move}`);
  const fixed = /export const sub = \(a: number, b: number\) => a - b;/.test(source);
  const named = [...offered.values()].some((spinoff) => /legacyMul/.test(`${spinoff.title} ${spinoff.prompt}`) && /math\.ts/.test(spinoff.prompt) && spinoff.title.length <= 60);
  console.log(`answer: ${answer.trim()}`);
  console.log(`sub fixed: ${fixed}; suggested the legacyMul cleanup on its own, with the file path: ${named}`);
  console.log(`estimated cost: $${cost.toFixed(6)} (budget $${BUDGET_USD})`);
  const leaked = logs.some((line) => line.includes(key)) || answer.includes(key);
  const passed = fixed && named && cost < BUDGET_USD && !leaked;
  console.log(`smoke: ${passed ? 'passed' : 'failed'}`);
  return passed ? 0 : 1;
}

void main().then((code) => (process.exitCode = code));
