// Run from the repository root: pnpm tsx packages/engine/test/cache-smoke.ts
// GCODE_ENV_FILE names the .env holding DASHSCOPE_API_KEY and DASHSCOPE_BASE_URL; it defaults to the repo's.
// One session on Model Studio qwen3.8-flash, four runs: a second run with nothing changed (T-ASM-07), a run after a
// memory note was added, and a run after a switch from Ask to Plan. Each run's first call should read the earlier
// runs' prefix from the cache. Under $0.05.
import { mkdtemp, readFile, realpath } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { parseEnv } from 'node:util';
import { asSessionId, costOf, toolUsesOf, type TokenUsage } from '@g-code/core';
import { memoryStore } from '../src/memory.js';
import { readSessionLog, sessionFile } from '../src/sessions.js';
import { homeOf, openStore } from '../src/store.js';
import { makeRepo } from './git-fixture.js';
import { rgCommand, runCli } from './helpers.js';

const MODEL = 'qwen3.8-flash';
const BUDGET_USD = 0.05;
const HIT_RATE = 0.9;

type Step = { readonly name: string; readonly mode: 'ask' | 'plan'; readonly prompt: string; readonly before?: () => Promise<unknown>; readonly hit: number };

const share = (usage: TokenUsage): number => usage.cacheRead / (usage.input + usage.cacheRead + usage.cacheWrite);

async function main(): Promise<number> {
  const repo = path.resolve(import.meta.dirname, '../../..');
  const dotenv = parseEnv(await readFile(process.env['GCODE_ENV_FILE'] || path.join(repo, '.env'), 'utf8'));
  const key = dotenv['DASHSCOPE_API_KEY'];
  const baseUrl = dotenv['DASHSCOPE_BASE_URL'];
  if (!key || !baseUrl) throw new Error('the .env needs DASHSCOPE_API_KEY and DASHSCOPE_BASE_URL');
  const home = await realpath(await mkdtemp(path.join(tmpdir(), 'gcode-cache-smoke-')));
  const env = {
    GCODE_HOME: path.join(home, 'gcode'),
    HOME: home,
    SHELL: process.env['SHELL'] ?? '/bin/zsh',
    GCODE_PROVIDER: 'modelstudio',
    GCODE_MODEL: MODEL,
    DASHSCOPE_API_KEY: key,
    DASHSCOPE_BASE_URL: baseUrl,
    GCODE_RG: rgCommand(),
    PATH: process.env['PATH'] ?? '/usr/bin:/bin',
  };
  const store = openStore(env);
  const workspace = await realpath(makeRepo('ws', [{ message: 'start', files: { 'a.ts': 'export const answer = 42;\n' } }]));
  const memory = memoryStore(homeOf(store), workspace);
  await memory.add('Reply in plain English, without headings.', 'global', null);

  const steps: readonly Step[] = [
    { name: 'first run', mode: 'ask', prompt: 'Read a.ts and reply with the name it exports, in one line.', hit: 0 },
    { name: 'T-ASM-07 same system and tools', mode: 'ask', prompt: 'Reply with the word ok.', hit: HIT_RATE },
    {
      name: 'after a memory note',
      mode: 'ask',
      prompt: 'Reply with the word ok again.',
      before: () => memory.add('In this project, prefer named exports over default exports.', 'project', null),
      hit: HIT_RATE,
    },
    { name: 'after Ask to Plan', mode: 'plan', prompt: 'In two lines, how would you rename that export? Plan only.', hit: HIT_RATE },
  ];

  let session: string | undefined;
  let total = 0;
  let passed = true;
  for (const step of steps) {
    await step.before?.();
    const where = session === undefined ? ['--workspace', workspace] : ['--session', session];
    const run = await runCli(['agent', ...where, '--mode', step.mode, '--max-turns', '4', '--max-cost', '0.02', step.prompt], env, { fetch: globalThis.fetch });
    session ??= /^session: (\S+)$/m.exec(run.stdout)?.[1];
    if (session === undefined) throw new Error(`${step.name}: no session (exit ${run.code})`);
    if (`${run.stdout}\n${run.stderr}`.includes(key)) throw new Error('the key reached the output');
    const { events } = await readSessionLog(sessionFile(store, asSessionId(session)));
    const asked = events.findLast((e) => e.kind === 'user' && e.from === undefined);
    const since = asked?.kind === 'user' ? asked.seq : 0;
    const calls = events.flatMap((e) => (e.kind === 'assistant' && e.seq > since ? [e] : []));
    const cost = calls.reduce((sum, e) => sum + (e.costUsd ?? costOf('modelstudio', MODEL, e.usage) ?? 0), 0);
    total += cost;
    const first = calls[0]!.usage;
    const rate = share(first);
    const ok = rate >= step.hit;
    passed &&= ok;
    const used = calls.flatMap((e) => toolUsesOf(e.content).map((use) => use.name));
    console.log(
      `${ok ? 'ok' : 'FAIL'}: ${step.name}: exit ${run.code}, ${calls.length} calls, first call input=${first.input} cacheRead=${first.cacheRead} cacheWrite=${first.cacheWrite} (${(rate * 100).toFixed(1)}% read), tools [${used.join(', ')}], $${cost.toFixed(6)}`,
    );
  }
  const unchanged = readFileSync(path.join(workspace, 'a.ts'), 'utf8') === 'export const answer = 42;\n';
  console.log(`${unchanged ? 'ok' : 'FAIL'}: Plan left a.ts as it was`);
  passed &&= unchanged;
  console.log(`\ntotal $${total.toFixed(6)} (budget $${BUDGET_USD})`);
  return passed && total < BUDGET_USD ? 0 : 1;
}

process.exitCode = await main();
