// Run from the repository root: pnpm tsx packages/engine/test/background-smoke.ts
// GCODE_ENV_FILE names the .env holding DASHSCOPE_API_KEY and DASHSCOPE_BASE_URL; it defaults to the repo's.
// One prompt on Model Studio where the model starts a dev server in the background, polls it with curl and stops it, under $0.05.
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, realpath, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { parseEnv } from 'node:util';
import * as acp from '@agentclientprotocol/sdk';
import { asSessionId } from '@g-code/core';
import type { Io } from '../src/command.js';
import { engineShared, gcodeAgent } from '../src/serve.js';
import { mcpSessions } from '../src/mcp/sessions.js';
import { sessionFile } from '../src/sessions.js';
import { openStore } from '../src/store.js';
import { rgCommand } from './helpers.js';

const MODEL = 'qwen3.8-flash';
const BUDGET_USD = 0.05;
const PORT = 40_000 + Math.floor(Math.random() * 20_000);
const PROMPT = `This project has a small dev server in server.js. Start it with \`node server.js\` (it listens on port ${PORT}), check that it answers by fetching http://127.0.0.1:${PORT}/ with curl, then stop the server and tell me what it answered.`;

const FILES: Readonly<Record<string, string>> = {
  'server.js': `const http = require('node:http');\nhttp.createServer((req, res) => res.end('hello from the dev server\\n')).listen(${PORT}, '127.0.0.1', () => console.log('listening on ${PORT}'));\n`,
  'package.json': '{ "name": "smoke", "scripts": { "dev": "node server.js" } }\n',
};

type Call = { readonly name: string; readonly input: Record<string, unknown>; output?: string };

async function main(): Promise<number> {
  const repo = path.resolve(import.meta.dirname, '../../..');
  const dotenv = parseEnv(await readFile(process.env['GCODE_ENV_FILE'] || path.join(repo, '.env'), 'utf8'));
  const key = dotenv['DASHSCOPE_API_KEY'];
  const baseUrl = dotenv['DASHSCOPE_BASE_URL'];
  if (!key || !baseUrl) throw new Error('the .env needs DASHSCOPE_API_KEY and DASHSCOPE_BASE_URL');

  const work = await realpath(await mkdtemp(path.join(tmpdir(), 'gcode-background-smoke-')));
  const workspace = path.join(work, 'workspace');
  const home = path.join(work, 'home');
  for (const [file, text] of Object.entries(FILES)) {
    await mkdir(path.dirname(path.join(workspace, file)), { recursive: true });
    await writeFile(path.join(workspace, file), text);
  }
  const env = { GCODE_HOME: home, GCODE_PROVIDER: 'modelstudio', GCODE_MODEL: MODEL, DASHSCOPE_API_KEY: key, DASHSCOPE_BASE_URL: baseUrl, GCODE_RG: rgCommand(), PATH: process.env['PATH'] ?? '/usr/bin:/bin' };
  const logs: string[] = [];
  const io: Io = { env, cwd: workspace, out: (line) => logs.push(line), err: (line) => logs.push(line), write: () => {}, interrupts: () => new AbortController().signal, confirm: async () => false, fetch: globalThis.fetch };

  const client = acp
    .client({ name: 'background-smoke' })
    .onNotification(acp.methods.client.session.update, () => {})
    .onRequest(acp.methods.client.session.requestPermission, () => ({ outcome: { outcome: 'selected', optionId: 'reject' } }));
  const store = openStore(env);
  const shared = engineShared(io);
  let sessionId = '';
  await client.connectWith(gcodeAgent(io, store, { maxTurns: 10, maxCostUsd: BUDGET_USD }, mcpSessions(store, env), shared), async (ctx) => {
    await ctx.request(acp.methods.agent.initialize, { protocolVersion: acp.PROTOCOL_VERSION, clientCapabilities: {} });
    sessionId = (await ctx.request(acp.methods.agent.session.new, { cwd: workspace, mcpServers: [] })).sessionId;
    await ctx.request(acp.methods.agent.session.prompt, { sessionId, prompt: [{ type: 'text', text: PROMPT }] });
  });

  const events = (await readFile(sessionFile(store, asSessionId(sessionId)), 'utf8')).trim().split('\n').map((l) => JSON.parse(l));
  const calls = new Map<string, Call>();
  for (const event of events) {
    if (event.kind === 'assistant') for (const block of event.content) if (block.type === 'tool_use') calls.set(block.id, { name: block.name, input: block.input });
    if (event.kind === 'tool-result' && calls.has(event.toolUseId)) calls.get(event.toolUseId)!.output = event.output ?? event.spill?.tail;
  }
  const assistants = events.filter((e) => e.kind === 'assistant') as { usage?: { input: number; cacheRead: number; cacheWrite: number; output: number }; costUsd?: number | null; content: { type: string; text?: string }[] }[];
  const cost = assistants.reduce((sum, e) => sum + (e.costUsd ?? 0), 0);
  const tokensIn = assistants.reduce((sum, e) => sum + (e.usage?.input ?? 0) + (e.usage?.cacheRead ?? 0) + (e.usage?.cacheWrite ?? 0), 0);
  const tokensOut = assistants.reduce((sum, e) => sum + (e.usage?.output ?? 0), 0);
  // Model Studio does not price qwen3.8-flash in the cost table, so fall back to the U37 probe's per-token estimate.
  const estimate = cost > 0 ? cost : (tokensIn * 0.15 + tokensOut * 0.47) / 1e6;

  for (const call of calls.values()) console.log(`${call.name} ${JSON.stringify(call.input)}\n  -> ${(call.output ?? '').split('\n').slice(0, 3).join(' | ')}`);
  console.log(`answer: ${assistants.at(-1)?.content.flatMap((b) => (b.type === 'text' ? [b.text] : [])).join('')}`);
  const list = [...calls.values()];
  const started = list.some((c) => c.name === 'bash' && c.input['run_in_background'] === true && /^Started background command bg-\d+\./.test(c.output ?? ''));
  const polled = list.some((c) => c.name === 'bash' && String(c.input['command']).includes('curl') && (c.output ?? '').includes('hello from the dev server'));
  const stopped = list.some((c) => c.name === 'bash_stop' && /was stopped/.test(c.output ?? ''));
  const lingering = (() => {
    try {
      return execFileSync('lsof', ['-ti', `tcp:${PORT}`], { encoding: 'utf8' }).trim() !== '';
    } catch {
      return false;
    }
  })();
  await shared.jobs.kill('engine-exit', 'all');
  console.log(`started in background: ${started}; polled with curl: ${polled}; stopped with bash_stop: ${stopped}; server left running: ${lingering}`);
  console.log(`tokens: ${tokensIn} in, ${tokensOut} out; estimated cost: $${estimate.toFixed(6)} (budget $${BUDGET_USD})`);
  const leaked = logs.some((line) => line.includes(key));
  const passed = started && polled && stopped && !lingering && estimate < BUDGET_USD && !leaked;
  console.log(`smoke: ${passed ? 'passed' : 'failed'}`);
  return passed ? 0 : 1;
}

void main().then((code) => (process.exitCode = code));
