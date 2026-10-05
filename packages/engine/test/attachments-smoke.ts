// Live smoke for attachments on Model Studio: the engine as the editor drives it over ACP, with a real model.
// It sends a generated two-color image and expects the answer to name both colors, then asks the agent to read a
// PNG in the workspace and describe it. Run from the repository root: pnpm tsx packages/engine/test/attachments-smoke.ts
// GCODE_ENV_FILE names the .env holding DASHSCOPE_API_KEY and DASHSCOPE_BASE_URL; it defaults to the repo's.
import { mkdir, mkdtemp, readdir, readFile, realpath, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { parseEnv } from 'node:util';
import * as acp from '@agentclientprotocol/sdk';
import { ATTACHMENT_META } from '@g-code/core';
import type { Io } from '../src/command.js';
import { gcodeAgent } from '../src/serve.js';
import { openStore } from '../src/store.js';
import { twoColorPng } from '../../core/test/png.js';
import { rgCommand } from './helpers.js';

const MODEL = 'qwen3.8-flash';
const BUDGET_USD = 0.02;

const named = (answer: string, colors: readonly string[]) => colors.every((color) => answer.toLowerCase().includes(color));

async function main(): Promise<number> {
  const root = path.resolve(import.meta.dirname, '../../..');
  const dotenv = parseEnv(await readFile(process.env['GCODE_ENV_FILE'] || path.join(root, '.env'), 'utf8'));
  const key = dotenv['DASHSCOPE_API_KEY'];
  const baseUrl = dotenv['DASHSCOPE_BASE_URL'];
  if (!key || !baseUrl) throw new Error('the .env needs DASHSCOPE_API_KEY and DASHSCOPE_BASE_URL');

  const work = await realpath(await mkdtemp(path.join(tmpdir(), 'gcode-attach-smoke-')));
  const workspace = path.join(work, 'workspace');
  const home = path.join(work, 'home');
  await mkdir(workspace, { recursive: true });
  await writeFile(path.join(workspace, 'shot.png'), twoColorPng(256, 128, [0, 170, 0], [255, 215, 0]));
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
  const answers: string[] = [];
  let current = '';
  const tools: string[] = [];
  const client = acp
    .client({ name: 'attachments-smoke' })
    .onRequest(acp.methods.client.session.requestPermission, () => ({ outcome: { outcome: 'selected', optionId: 'reject' } }))
    .onNotification(acp.methods.client.session.update, ({ params }) => {
      const { update } = params;
      if (update.sessionUpdate === 'agent_message_chunk' && update.content.type === 'text') current += update.content.text;
      if (update.sessionUpdate === 'tool_call') tools.push(update.title ?? '');
    });

  await client.connectWith(gcodeAgent(io, openStore(env), { maxTurns: 6, maxCostUsd: BUDGET_USD }), async (ctx) => {
    await ctx.request(acp.methods.agent.initialize, { protocolVersion: acp.PROTOCOL_VERSION, clientCapabilities: {} });
    const { sessionId } = await ctx.request(acp.methods.agent.session.new, { cwd: workspace, mcpServers: [] });
    const ask = async (prompt: acp.ContentBlock[]) => {
      current = '';
      const { stopReason } = await ctx.request(acp.methods.agent.session.prompt, { sessionId, prompt });
      answers.push(current.trim());
      return stopReason;
    };
    const flag = twoColorPng(256, 128, [230, 0, 0], [0, 60, 230]).toString('base64');
    console.log(
      `attached image: ${await ask([
        { type: 'text', text: 'What color is the left half of this image, and what color is the right half? Answer in one short sentence and do not use any tools.' },
        { type: 'image', data: flag, mimeType: 'image/png', _meta: { [ATTACHMENT_META]: { name: 'flag.png' } } },
      ])}`,
    );
    console.log(
      `workspace image: ${await ask([
        { type: 'text', text: 'Use the read tool to look at shot.png in the workspace. In one sentence, say what color its left half is and what color its right half is.' },
      ])}`,
    );
  });

  const sessions = path.join(home, 'sessions');
  let cost = 0;
  let toolResults: string[] = [];
  for (const file of (await readdir(sessions)).filter((f) => f.endsWith('.jsonl'))) {
    const events = (await readFile(path.join(sessions, file), 'utf8')).trim().split('\n').map((line) => JSON.parse(line));
    cost += events.filter((e) => e.kind === 'assistant').reduce((sum, e) => sum + (e.costUsd ?? 0), 0);
    toolResults = events.filter((e) => e.kind === 'tool-result').map((e) => `${e.name}:${e.status}:${e.images?.length ?? 0} image`);
  }
  const [first = '', second = ''] = answers;
  const sawFlag = named(first, ['red', 'blue']);
  const sawShot = named(second, ['green', 'yellow']) && toolResults.some((r) => r === 'read:ok:1 image');
  console.log(`answer 1: ${first}`);
  console.log(`answer 2: ${second}`);
  console.log(`tool calls: ${tools.join(', ')}; results: ${toolResults.join(', ')}`);
  console.log(`named red and blue: ${sawFlag}; read shot.png and named green and yellow: ${sawShot}`);
  console.log(`estimated cost: $${cost.toFixed(6)} (budget $${BUDGET_USD})`);
  const leaked = logs.some((line) => line.includes(key)) || answers.some((a) => a.includes(key));
  const passed = sawFlag && sawShot && cost < BUDGET_USD && !leaked;
  console.log(`smoke: ${passed ? 'passed' : 'failed'}`);
  return passed ? 0 : 1;
}

void main().then((code) => (process.exitCode = code));
