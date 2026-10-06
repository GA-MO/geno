// Run from the repository root: pnpm tsx packages/engine/test/subagents-smoke.ts
// GCODE_ENV_FILE names the .env holding DASHSCOPE_API_KEY and DASHSCOPE_BASE_URL; it defaults to the repo's.
// SMOKE_WORKSPACE names the repository explore searches; it defaults to ~/Development/next-15-template, read-only.
// One @explore question goes through serve on Model Studio qwen3.8-flash, under $0.05.
import { mkdtemp, readdir, readFile, realpath, stat } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import path from 'node:path';
import { parseEnv } from 'node:util';
import * as acp from '@agentclientprotocol/sdk';
import { asSessionId, childrenOf, costOf, type ToolResultEvent } from '@g-code/core';
import type { Io } from '../src/command.js';
import { gcodeAgent } from '../src/serve.js';
import { readSessionLog, sessionFile } from '../src/sessions.js';
import { openStore } from '../src/store.js';
import { rgCommand } from './helpers.js';

const MODEL = 'qwen3.8-flash';
const BUDGET_USD = 0.05;
const QUESTION = '@explore where is createFetcher defined, and which services call it?';
/** Read from the repository by hand before the run: the definition, and the two calls in the demo service. */
const EXPECTED = ['src/plugins/createFetcher/index.ts:28', 'src/services/demo/index.ts:11', 'src/services/demo/index.ts:27'];

/** Every file's size and modification time, to prove the run changed nothing in the repository. */
async function snapshot(root: string): Promise<string> {
  const lines: string[] = [];
  const walk = async (dir: string) => {
    for (const entry of (await readdir(dir, { withFileTypes: true })).toSorted((a, b) => a.name.localeCompare(b.name))) {
      if (entry.name === 'node_modules' || entry.name === '.next') continue;
      const file = path.join(dir, entry.name);
      if (entry.isDirectory()) await walk(file);
      else {
        const info = await stat(file);
        lines.push(`${path.relative(root, file)} ${info.size} ${info.mtimeMs}`);
      }
    }
  };
  await walk(root);
  return lines.join('\n');
}

async function main(): Promise<number> {
  const repo = path.resolve(import.meta.dirname, '../../..');
  const dotenv = parseEnv(await readFile(process.env['GCODE_ENV_FILE'] || path.join(repo, '.env'), 'utf8'));
  const key = dotenv['DASHSCOPE_API_KEY'];
  const baseUrl = dotenv['DASHSCOPE_BASE_URL'];
  if (!key || !baseUrl) throw new Error('the .env needs DASHSCOPE_API_KEY and DASHSCOPE_BASE_URL');

  const workspace = await realpath(process.env['SMOKE_WORKSPACE'] || path.join(homedir(), 'Development', 'next-15-template'));
  const home = await realpath(await mkdtemp(path.join(tmpdir(), 'gcode-subagents-smoke-')));
  const env = {
    GCODE_HOME: path.join(home, 'gcode'),
    HOME: home,
    GCODE_PROVIDER: 'modelstudio',
    GCODE_MODEL: MODEL,
    DASHSCOPE_API_KEY: key,
    DASHSCOPE_BASE_URL: baseUrl,
    GCODE_RG: rgCommand(),
    PATH: process.env['PATH'] ?? '/usr/bin:/bin',
  };
  const logs: string[] = [];
  const io: Io = { env, cwd: workspace, out: (line) => logs.push(line), err: (line) => logs.push(line), write: () => {}, interrupts: () => new AbortController().signal, confirm: async () => false, fetch: globalThis.fetch };
  const before = await snapshot(workspace);
  const updates: acp.SessionNotification[] = [];
  const client = acp.client({ name: 'subagents-smoke' }).onNotification(acp.methods.client.session.update, ({ params }) => {
    updates.push(params);
  });
  const store = openStore(env);
  const started = Date.now();
  const { sessionId, stopReason } = await client.connectWith(gcodeAgent(io, store, { maxTurns: 4, maxCostUsd: BUDGET_USD }), async (ctx) => {
    await ctx.request(acp.methods.agent.initialize, { protocolVersion: acp.PROTOCOL_VERSION, clientCapabilities: { subagents: {} } });
    const { sessionId } = await ctx.request(acp.methods.agent.session.new, { cwd: workspace, mcpServers: [] });
    const { stopReason } = await ctx.request(acp.methods.agent.session.prompt, { sessionId, prompt: [{ type: 'text', text: QUESTION }] });
    return { sessionId, stopReason };
  });
  const seconds = (Date.now() - started) / 1000;

  const parent = await readSessionLog(sessionFile(store, asSessionId(sessionId)));
  const [child] = childrenOf(parent.events);
  const result = parent.events.find((e): e is ToolResultEvent => e.kind === 'tool-result');
  const report = result !== undefined && 'output' in result ? result.output : '';
  const own = child === undefined ? undefined : await readSessionLog(sessionFile(store, child.child));
  const calls = own?.events.flatMap((e) => (e.kind === 'assistant' ? [e] : [])) ?? [];
  const tools = own?.events.flatMap((e) => (e.kind === 'tool-result' ? [`${e.name}`] : [])) ?? [];
  // The cost table's own price, else the per-token estimate at qwen3.8-flash's list price.
  const cost = child?.costUsd ?? calls.reduce((sum, e) => sum + (costOf('modelstudio', MODEL, e.usage) ?? (e.usage.input * 0.15 + e.usage.output * 0.47) / 1e6), 0);
  const cited = EXPECTED.filter((cite) => report.includes(cite));
  const unchanged = (await snapshot(workspace)) === before;
  const announced = updates.filter((u) => u.update.sessionUpdate === 'subagent_update').length;
  const leaked = logs.some((line) => line.includes(key)) || report.includes(key);

  console.log(`question: ${QUESTION}`);
  console.log(`report:\n${report}`);
  console.log(`child: ${child?.role} ${child?.status.kind}, ${calls.length} model calls, tools ${tools.join(', ')}, effort ${child?.effort}`);
  console.log(`cited ${cited.length} of ${EXPECTED.length}: ${cited.join(', ')}`);
  console.log(`cost: $${cost.toFixed(6)} (budget $${BUDGET_USD}); ${seconds.toFixed(1)}s; stop ${stopReason}; subagent_update x${announced}; repository unchanged: ${unchanged}`);
  const passed = child?.status.kind === 'done' && cited.length === EXPECTED.length && cost < BUDGET_USD && unchanged && announced === 2 && !leaked;
  console.log(`smoke: ${passed ? 'passed' : 'failed'}`);
  return passed ? 0 : 1;
}

void main().then((code) => (process.exitCode = code));
