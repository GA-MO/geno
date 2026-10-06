// Run from the repository root: pnpm tsx packages/engine/test/usage-smoke.ts
// GCODE_ENV_FILE names the .env holding DASHSCOPE_API_KEY and DASHSCOPE_BASE_URL; it defaults to the repo's.
// One `gcode agent` turn on Model Studio qwen3.8-flash reads a file and answers, under $0.02. Each request's
// estimate, the sum of the parts it logged, must land within 5% of the input tokens the provider reported.
// `--log <session.jsonl>` checks a log an earlier run left, without a model call.
import { mkdtemp, readFile, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { parseEnv } from 'node:util';
import { asSessionId, sessionSpend, spendLines, type TurnEvent } from '@g-code/core';
import { run } from '../src/run.js';
import { readSessionLog, sessionFile } from '../src/sessions.js';
import { openStore } from '../src/store.js';
import { makeRepo } from './git-fixture.js';
import { rgCommand } from './helpers.js';

const MODEL = 'qwen3.8-flash';
const TOLERANCE = 0.05;
const SOURCE = `/** Prices in baht, per item, as the shop lists them. */
export const PRICES = { tea: 45, coffee: 60, cake: 85 } as const;

export function total(items: readonly (keyof typeof PRICES)[]): number {
  return items.reduce((sum, item) => sum + PRICES[item], 0);
}
`;

async function liveRun(): Promise<readonly TurnEvent[]> {
  const repo = path.resolve(import.meta.dirname, '../../..');
  const dotenv = parseEnv(await readFile(process.env['GCODE_ENV_FILE'] || path.join(repo, '.env'), 'utf8'));
  const key = dotenv['DASHSCOPE_API_KEY'];
  const baseUrl = dotenv['DASHSCOPE_BASE_URL'];
  if (!key || !baseUrl) throw new Error('the .env needs DASHSCOPE_API_KEY and DASHSCOPE_BASE_URL');
  const workspace = await realpath(makeRepo('shop', [{ message: 'start', files: { 'prices.ts': SOURCE } }]));
  const home = await realpath(await mkdtemp(path.join(tmpdir(), 'gcode-usage-smoke-')));
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
  const out: string[] = [];
  const io = { env, cwd: workspace, out: (line: string) => out.push(line), err: (line: string) => out.push(line), write: () => {}, confirm: async () => false, interrupts: () => new AbortController().signal };
  // A turn the turn cap stops still logged its requests, which is all the check needs.
  await run(['agent', '--workspace', workspace, '--non-interactive', '--max-turns', '6', '--max-cost', '0.02', 'Read prices.ts in the workspace root, then say in one sentence what total() returns.'], io);
  const text = out.join('\n').replaceAll(key, '[key]');
  const id = /^session: (\S+)$/m.exec(text)?.[1];
  if (id === undefined) throw new Error(`gcode agent started no session:\n${text}`);
  const file = sessionFile(openStore(env), asSessionId(id));
  console.log(`log: ${file}`);
  return (await readSessionLog(file)).events;
}

async function main(): Promise<number> {
  const at = process.argv.indexOf('--log');
  const events = at < 0 ? await liveRun() : (await readSessionLog(process.argv[at + 1]!)).events;
  const calls = events.filter((e): e is Extract<TurnEvent, { kind: 'assistant' }> => e.kind === 'assistant');
  let ok = calls.length > 0;
  for (const [i, c] of calls.entries()) {
    const reported = c.usage.input + c.usage.cacheRead + c.usage.cacheWrite;
    const estimated = (c.promptParts ?? []).reduce((s, [, n]) => s + n, 0);
    const error = (estimated - reported) / reported;
    ok &&= Math.abs(error) <= TOLERANCE;
    console.log(`request ${i + 1}: reported ${reported} input tokens, estimated ${estimated}, error ${(error * 100).toFixed(2)}%, cost $${c.costUsd?.toFixed(6)}`);
  }
  for (const line of spendLines(sessionSpend(events), 33)) console.log(line);
  console.log(ok ? `PASS: every request within ${TOLERANCE * 100}%` : `FAIL: a request is off by more than ${TOLERANCE * 100}%`);
  return ok ? 0 : 1;
}

process.exitCode = await main();
