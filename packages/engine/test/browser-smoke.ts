// Run from the repository root: pnpm tsx packages/engine/test/browser-smoke.ts
// GCODE_ENV_FILE names the .env holding DASHSCOPE_API_KEY and DASHSCOPE_BASE_URL; it defaults to the repo's.
// It starts the browser the way users get it, through npx at the pinned version, headless.
import { mkdir, mkdtemp, readFile, realpath } from 'node:fs/promises';
import http from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { parseEnv } from 'node:util';
import * as acp from '@agentclientprotocol/sdk';
import { BROWSER_META, TURN_USAGE_META } from '@g-code/core';
import type { Io } from '../src/command.js';
import { gcodeAgent } from '../src/serve.js';
import { openStore } from '../src/store.js';
import { rgCommand } from './helpers.js';

const MODEL = 'qwen3.8-flash';
const BUDGET_USD = 0.05;
const HEADING = 'Welcome to the Geno smoke page';

const PAGE = `<title>Smoke</title><h1 id="h">${HEADING}</h1>
<button onclick="document.getElementById('out').textContent = 'Thanks for clicking, the order is placed.'">Place order</button>
<p id="out"></p>`;

async function main(): Promise<number> {
  const root = path.resolve(import.meta.dirname, '../../..');
  const dotenv = parseEnv(await readFile(process.env['GCODE_ENV_FILE'] || path.join(root, '.env'), 'utf8'));
  const key = dotenv['DASHSCOPE_API_KEY'];
  const baseUrl = dotenv['DASHSCOPE_BASE_URL'];
  if (!key || !baseUrl) throw new Error('the .env needs DASHSCOPE_API_KEY and DASHSCOPE_BASE_URL');

  const server = http.createServer((_req, res) => res.writeHead(200, { 'content-type': 'text/html' }).end(PAGE));
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${(server.address() as { port: number }).port}/`;

  const work = await realpath(await mkdtemp(path.join(tmpdir(), 'gcode-browser-smoke-')));
  const workspace = path.join(work, 'workspace');
  await mkdir(workspace, { recursive: true });
  const env = {
    GCODE_HOME: path.join(work, 'home'),
    GCODE_PROVIDER: 'modelstudio',
    GCODE_MODEL: MODEL,
    DASHSCOPE_API_KEY: key,
    DASHSCOPE_BASE_URL: baseUrl,
    GCODE_RG: rgCommand(),
    PATH: process.env['PATH'] ?? '/usr/bin:/bin',
    HOME: process.env['HOME'] ?? work,
  };
  const io: Io = {
    env,
    cwd: workspace,
    out: () => {},
    err: () => {},
    write: () => {},
    interrupts: () => new AbortController().signal,
    confirm: async () => false,
    fetch: globalThis.fetch,
  };
  let answer = '';
  const steps: string[] = [];
  const asked: string[] = [];
  let cost = 0;
  const client = acp
    .client({ name: 'browser-smoke' })
    .onRequest(acp.methods.client.session.requestPermission, ({ params }) => {
      asked.push(String(params.toolCall.title));
      return { outcome: { outcome: 'selected', optionId: 'allow' } };
    })
    .onNotification(acp.methods.client.session.update, ({ params }) => {
      const { update } = params;
      if (update.sessionUpdate === 'agent_message_chunk' && update.content.type === 'text') answer += update.content.text;
      if (update.sessionUpdate === 'tool_call') steps.push(update.title ?? '');
    });

  const stop = await client.connectWith(gcodeAgent(io, openStore(env), { maxTurns: 10, maxCostUsd: BUDGET_USD }), async (ctx) => {
    await ctx.request(acp.methods.agent.initialize, { protocolVersion: acp.PROTOCOL_VERSION, clientCapabilities: {} });
    const { sessionId } = await ctx.request(acp.methods.agent.session.new, { cwd: workspace, mcpServers: [], _meta: { [BROWSER_META]: { enabled: true, headless: true } } });
    await ctx.request(acp.methods.agent.session.setMode, { sessionId, modeId: 'auto' });
    const response = await ctx.request(acp.methods.agent.session.prompt, {
      sessionId,
      prompt: [{ type: 'text', text: `Open ${url} in the browser. What does the heading say? Then click the button and tell me what the page shows afterwards. Answer in two short sentences.` }],
    });
    const meta = response._meta?.[TURN_USAGE_META] as { costUsd?: number } | undefined;
    cost = meta?.costUsd ?? Number.NaN;
    await ctx.request(acp.methods.agent.session.close, { sessionId });
    return response.stopReason;
  });
  server.close();

  console.log(`stop: ${stop}`);
  console.log(`steps: ${steps.join(' | ')}`);
  console.log(`asked: ${asked.length === 0 ? 'nothing' : asked.join(' | ')}`);
  console.log(`answer: ${answer.trim()}`);
  console.log(`cost: $${cost.toFixed(4)}`);
  const ok = answer.includes(HEADING) && /order is placed/i.test(answer);
  console.log(ok ? 'PASS' : 'FAIL');
  return ok ? 0 : 1;
}

process.exitCode = await main();
