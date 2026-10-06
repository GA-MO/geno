// Run from the repository root: pnpm tsx packages/engine/test/wake-smoke.ts
// GCODE_ENV_FILE names the .env holding DASHSCOPE_API_KEY and DASHSCOPE_BASE_URL; it defaults to the repo's.
// One prompt on Model Studio: the model starts `sleep 20 && echo done` in the background and ends its turn, and the
// engine wakes it with the result. Under $0.10.
import { mkdtemp, readFile, realpath, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { parseEnv } from 'node:util';
import * as acp from '@agentclientprotocol/sdk';
import { asSessionId, type TurnEvent } from '@g-code/core';
import type { Io } from '../src/command.js';
import { engineShared, gcodeAgent } from '../src/serve.js';
import { mcpSessions } from '../src/mcp/sessions.js';
import { sessionFile } from '../src/sessions.js';
import { openStore } from '../src/store.js';
import { rgCommand } from './helpers.js';

const MODEL = 'qwen3.8-flash';
const BUDGET_USD = 0.1;
const COMMAND = 'sleep 20 && echo done';
const PROMPT = `Make exactly one tool call now: bash with run_in_background: true and the command \`${COMMAND}\`, exactly as written. Then reply "Started." and end your turn: run nothing else, and do not wait or poll. Geno wakes you when it ends; then tell me in one line what it printed.`;
const WAKE_BY_MS = 90_000;

async function main(): Promise<number> {
  const repo = path.resolve(import.meta.dirname, '../../..');
  const dotenv = parseEnv(await readFile(process.env['GCODE_ENV_FILE'] || path.join(repo, '.env'), 'utf8'));
  const key = dotenv['DASHSCOPE_API_KEY'];
  const baseUrl = dotenv['DASHSCOPE_BASE_URL'];
  if (!key || !baseUrl) throw new Error('the .env needs DASHSCOPE_API_KEY and DASHSCOPE_BASE_URL');

  const workspace = await realpath(await mkdtemp(path.join(tmpdir(), 'gcode-wake-smoke-')));
  const home = await mkdtemp(path.join(tmpdir(), 'gcode-wake-smoke-home-'));
  await writeFile(path.join(workspace, 'README.md'), '# smoke\n');
  const env = { GCODE_HOME: home, GCODE_PROVIDER: 'modelstudio', GCODE_MODEL: MODEL, DASHSCOPE_API_KEY: key, DASHSCOPE_BASE_URL: baseUrl, GCODE_RG: rgCommand(), PATH: process.env['PATH'] ?? '/usr/bin:/bin' };
  const logs: string[] = [];
  const io: Io = { env, cwd: workspace, out: (line) => logs.push(line), err: (line) => logs.push(line), write: () => {}, interrupts: () => new AbortController().signal, confirm: async () => false, fetch: globalThis.fetch };

  const client = acp
    .client({ name: 'wake-smoke' })
    .onNotification(acp.methods.client.session.update, () => {})
    .onRequest(acp.methods.client.session.requestPermission, ({ params }) => ({
      outcome: { outcome: 'selected', optionId: params.options.find((o) => o.kind === 'allow_once')?.optionId ?? params.options[0]!.optionId },
    }));
  const store = openStore(env);
  const shared = engineShared(io);
  let sessionId = '';
  const read = async (): Promise<TurnEvent[]> =>
    (await readFile(sessionFile(store, asSessionId(sessionId)), 'utf8'))
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as TurnEvent);
  const timing = { firstTurnMs: 0, wokeAtMs: 0 };
  const started = Date.now();
  await client.connectWith(gcodeAgent(io, store, { maxTurns: 10, maxCostUsd: BUDGET_USD }, mcpSessions(store, env), shared), async (ctx) => {
    await ctx.request(acp.methods.agent.initialize, { protocolVersion: acp.PROTOCOL_VERSION, clientCapabilities: {} });
    sessionId = (await ctx.request(acp.methods.agent.session.new, { cwd: workspace, mcpServers: [] })).sessionId;
    await ctx.request(acp.methods.agent.session.prompt, { sessionId, prompt: [{ type: 'text', text: PROMPT }] });
    timing.firstTurnMs = Date.now() - started;
    // The window stays connected while the engine wakes the session and its woken turn ends.
    const deadline = Date.now() + WAKE_BY_MS;
    for (;;) {
      const events = await read();
      const woke = events.findIndex((e) => e.kind === 'user' && e.from === 'wake');
      if (woke !== -1 && timing.wokeAtMs === 0) timing.wokeAtMs = Date.parse((events[woke] as { at: string }).at) - started;
      const answered = woke !== -1 && events.slice(woke).some((e) => e.kind === 'assistant' && e.stopReason === 'end_turn');
      if (answered || Date.now() > deadline) break;
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
  });
  await shared.jobs.kill('engine-exit', 'all');

  const events = await read();
  const assistants = events.filter((e): e is Extract<TurnEvent, { kind: 'assistant' }> => e.kind === 'assistant');
  const uses = assistants.flatMap((e) => e.content.flatMap((b) => (b.type === 'tool_use' ? [b] : [])));
  const results = new Map(events.flatMap((e) => (e.kind === 'tool-result' && 'output' in e ? [[e.toolUseId, e.output] as const] : [])));
  const background = uses.find((u) => u.name === 'bash' && (u.input as { run_in_background?: boolean }).run_in_background === true);
  const startedInBackground = background !== undefined && /^Started background command bg-\d+\./.test(results.get(background.id) ?? '');
  const ended = events.find((e) => e.kind === 'background-end');
  const wake = events.find((e) => e.kind === 'user' && e.from === 'wake');
  const prompts = events.filter((e) => e.kind === 'user' && e.steer !== true);
  const last = assistants.at(-1);
  const answer = last?.content.flatMap((b) => (b.type === 'text' ? [b.text] : [])).join('') ?? '';
  const tokensIn = assistants.reduce((sum, e) => sum + e.usage.input + e.usage.cacheRead + e.usage.cacheWrite, 0);
  const tokensOut = assistants.reduce((sum, e) => sum + e.usage.output, 0);
  const cost = assistants.reduce((sum, e) => sum + (e.costUsd ?? 0), 0);
  // Model Studio does not price qwen3.8-flash in the cost table, so fall back to the U37 probe's per-token estimate.
  const estimate = cost > 0 ? cost : (tokensIn * 0.15 + tokensOut * 0.47) / 1e6;

  for (const use of uses) console.log(`${use.name} ${JSON.stringify(use.input)}\n  -> ${(results.get(use.id) ?? '').split('\n').slice(0, 2).join(' | ')}`);
  console.log(`first turn ended after ${(timing.firstTurnMs / 1000).toFixed(1)}s; woken at ${(timing.wokeAtMs / 1000).toFixed(1)}s`);
  console.log(`log: ${events.map((e) => (e.kind === 'user' ? (e.from === 'wake' ? 'wake' : e.steer === true ? 'steer' : 'prompt') : e.kind)).filter((k) => k !== 'checkpoint').join(', ')}`);
  console.log(`answer: ${answer}`);
  const endedFirst = timing.firstTurnMs > 0 && timing.firstTurnMs < 20_000;
  const wokeAfterEnd = ended?.kind === 'background-end' && wake?.kind === 'user' && Date.parse(wake.at) >= Date.parse(ended.at);
  const leaked = logs.some((line) => line.includes(key));
  const passed = startedInBackground && endedFirst && wokeAfterEnd && prompts.length === 2 && /done/i.test(answer) && estimate < BUDGET_USD && !leaked;
  console.log(`started in background: ${startedInBackground}; turn ended before the command: ${endedFirst}; woken after its end: ${wokeAfterEnd}; one wake: ${prompts.length === 2}`);
  console.log(`tokens: ${tokensIn} in, ${tokensOut} out; estimated cost: $${estimate.toFixed(6)} (budget $${BUDGET_USD}); key in logs: ${leaked}`);
  console.log(`smoke: ${passed ? 'passed' : 'failed'}`);
  return passed ? 0 : 1;
}

void main().then((code) => (process.exitCode = code));
