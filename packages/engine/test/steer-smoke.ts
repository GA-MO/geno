// Run from the repository root: pnpm tsx packages/engine/test/steer-smoke.ts
// GCODE_ENV_FILE names the .env holding DASHSCOPE_API_KEY and DASHSCOPE_BASE_URL; it defaults to the repo's.
// A multi-step read task goes through serve on Model Studio qwen3.8-flash, and the user steers it after its first read.
// Under $0.05.
import { mkdtemp, readFile, realpath, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { parseEnv } from 'node:util';
import * as acp from '@agentclientprotocol/sdk';
import { asSessionId, costOf, STEER_META, type SteerOutcome } from '@g-code/core';
import type { Io } from '../src/command.js';
import { gcodeAgent } from '../src/serve.js';
import { readSessionLog, sessionFile } from '../src/sessions.js';
import { openStore } from '../src/store.js';
import { rgCommand } from './helpers.js';

const MODEL = 'qwen3.8-flash';
const BUDGET_USD = 0.05;
const FRUITS: Readonly<Record<string, string>> = { 'a.txt': 'apple', 'b.txt': 'banana', 'c.txt': 'cherry', 'd.txt': 'date' };
const TASK =
  'The folder notes/ holds a.txt, b.txt, c.txt and d.txt, each naming one fruit. Read them one at a time, in that order, with exactly one read call per message and never several at once. When you have read all four, answer with the fruits as a comma-separated list.';
const STEER = 'Change of plan: do not read c.txt or d.txt. Once you have read b.txt, stop and answer with only the fruits you found so far, in UPPERCASE.';

async function main(): Promise<number> {
  const repo = path.resolve(import.meta.dirname, '../../..');
  const dotenv = parseEnv(await readFile(process.env['GCODE_ENV_FILE'] || path.join(repo, '.env'), 'utf8'));
  const key = dotenv['DASHSCOPE_API_KEY'];
  const baseUrl = dotenv['DASHSCOPE_BASE_URL'];
  if (!key || !baseUrl) throw new Error('the .env needs DASHSCOPE_API_KEY and DASHSCOPE_BASE_URL');

  const workspace = await realpath(await mkdtemp(path.join(tmpdir(), 'gcode-steer-smoke-ws-')));
  await mkdir(path.join(workspace, 'notes'));
  for (const [file, fruit] of Object.entries(FRUITS)) await writeFile(path.join(workspace, 'notes', file), `${fruit}\n`);
  const home = await realpath(await mkdtemp(path.join(tmpdir(), 'gcode-steer-smoke-')));
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
  const reads: string[] = [];
  let steered: Promise<acp.PromptResponse> | undefined;
  let send: (() => Promise<acp.PromptResponse>) | undefined;
  const client = acp
    .client({ name: 'steer-smoke' })
    .onRequest(acp.methods.client.fs.readTextFile, async ({ params }) => {
      reads.push(path.basename(params.path));
      // The first read holds until the steer is queued, so it lands after this tool round.
      if (steered === undefined && send !== undefined) {
        steered = send();
        await new Promise((resolve) => setTimeout(resolve, 200));
      }
      return { content: await readFile(params.path, 'utf8') };
    })
    .onRequest(acp.methods.client.fs.writeTextFile, () => ({}))
    .onRequest(acp.methods.client.session.requestPermission, () => ({ outcome: { outcome: 'selected', optionId: 'reject' } }));
  const store = openStore(env);
  const started = Date.now();
  const { sessionId, stopReason, outcome } = await client.connectWith(gcodeAgent(io, store, { maxTurns: 8, maxCostUsd: BUDGET_USD }), async (ctx) => {
    await ctx.request(acp.methods.agent.initialize, { protocolVersion: acp.PROTOCOL_VERSION, clientCapabilities: { fs: { readTextFile: true, writeTextFile: true } } });
    const { sessionId } = await ctx.request(acp.methods.agent.session.new, { cwd: workspace, mcpServers: [] });
    send = () => ctx.request(acp.methods.agent.session.prompt, { sessionId, prompt: [{ type: 'text', text: STEER }], _meta: { [STEER_META]: true } });
    const { stopReason } = await ctx.request(acp.methods.agent.session.prompt, { sessionId, prompt: [{ type: 'text', text: TASK }] });
    const outcome = steered === undefined ? undefined : ((await steered)._meta?.[STEER_META] as SteerOutcome | undefined);
    return { sessionId, stopReason, outcome };
  });
  const seconds = (Date.now() - started) / 1000;

  const log = await readSessionLog(sessionFile(store, asSessionId(sessionId)));
  const calls = log.events.flatMap((e) => (e.kind === 'assistant' ? [e] : []));
  const costUsd = calls.reduce((sum, e) => sum + (e.costUsd ?? costOf('modelstudio', MODEL, e.usage) ?? 0), 0);
  const final = calls.at(-1)?.content.flatMap((b) => (b.type === 'text' ? [b.text] : [])).join('').trim() ?? '';
  const order = log.events.flatMap((e) => (e.kind === 'session-start' ? [] : [e.kind === 'user' && e.steer === true ? 'steer' : e.kind])).filter((k) => k !== 'checkpoint');

  console.log(`stop: ${stopReason}, ${calls.length} model calls, ${seconds.toFixed(1)}s, $${costUsd.toFixed(6)}`);
  console.log(`steer: ${JSON.stringify(outcome)}`);
  console.log(`reads: ${reads.join(', ')}`);
  console.log(`log: ${order.join(' > ')}`);
  console.log(`answer: ${final}`);
  const leaked = logs.some((line) => line.includes(key));
  const checks: [string, boolean][] = [
    ['the steer was delivered mid-turn', outcome?.kind === 'delivered'],
    ['c.txt and d.txt were never read', !reads.includes('c.txt') && !reads.includes('d.txt')],
    ['the answer is APPLE and BANANA in uppercase', /APPLE/.test(final) && /BANANA/.test(final) && !/cherry|date/i.test(final)],
    ['one turn', log.events.filter((e) => e.kind === 'user' && e.steer !== true).length === 1],
    [`under $${BUDGET_USD}`, costUsd < BUDGET_USD],
    ['the key is in no log line', !leaked],
  ];
  for (const [name, ok] of checks) console.log(`${ok ? 'ok' : 'FAIL'}: ${name}`);
  return checks.every(([, ok]) => ok) ? 0 : 1;
}

process.exitCode = await main();
