// Run from the repository root: pnpm tsx packages/engine/test/compact-cost.ts
// GCODE_ENV_FILE names the .env holding DASHSCOPE_API_KEY and DASHSCOPE_BASE_URL; it defaults to the repo's.
// What a long qwen3.8-flash session costs at two auto-compaction points, live at a quarter-scale pair whose ratio
// matches 200,000 against 800,000 at a small scale, then projected to the full-size pair from what the live arms measured.
import { mkdir, mkdtemp, readFile, realpath, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { parseEnv } from 'node:util';
import { asSessionId, capabilitiesOf, KEEP_TAIL_TOKENS, ratesOf, spendOf, SUMMARY_TOKENS, type TurnEvent } from '@g-code/core';
import { readSessionLog, sessionFile } from '../src/sessions.js';
import { openStore } from '../src/store.js';
import { rgCommand, runCli } from './helpers.js';

const MODEL = 'qwen3.8-flash';
const PARTS = 20;
const KEYS = ['amber', 'birch', 'cobalt', 'dune', 'ember', 'fjord', 'garnet', 'harbor', 'indigo', 'juniper', 'kestrel', 'lagoon', 'maple', 'nectar', 'onyx', 'pebble', 'quartz', 'raven', 'saffron', 'tundra'];
const ARMS = [
  { compactAt: 12_000, maxCostUsd: 0.05 },
  { compactAt: 48_000, maxCostUsd: 0.095 },
] as const;
const TASK = `Read part-01.md to part-${PARTS}.md in order, each one whole. Each file states its key on one line somewhere in it. After the last file, and without reading any file again, reply with one line per part in the form "NN: key".`;

/** About 7,000 characters, with the key on a line in the middle, so the model has to read all of it. */
const part = (n: number): string => {
  const id = String(n).padStart(2, '0');
  const filler = (from: number) => Array.from({ length: 35 }, (_, i) => `Part ${id}, line ${from + i}: the archive keeps this line to give the file its size, and nothing in it matters.`);
  return [`Part ${id}.`, ...filler(1), `The key of part ${id} is ${KEYS[n - 1]}.`, ...filler(36)].join('\n');
};

type Arm = { compactAt: number; calls: number; compactions: number; costUsd: number; recalled: number; tokensAfter: number[]; summaryCostUsd: number[] };

async function runArm(env: Record<string, string>, compactAt: number, maxCostUsd: number): Promise<Arm> {
  const work = await realpath(await mkdtemp(path.join(tmpdir(), 'gcode-compact-cost-')));
  const workspace = path.join(work, 'workspace');
  const home = path.join(work, 'home');
  await mkdir(workspace, { recursive: true });
  for (let n = 1; n <= PARTS; n++) await writeFile(path.join(workspace, `part-${String(n).padStart(2, '0')}.md`), `${part(n)}\n`);
  const armEnv = { ...env, GCODE_HOME: home, HOME: home, GCODE_COMPACT_AT: String(compactAt) };
  const result = await runCli(['agent', '--workspace', workspace, '--non-interactive', '--max-turns', '40', '--max-cost', String(maxCostUsd), TASK], armEnv, { fetch: globalThis.fetch });
  const id = /^session: (\S+)$/m.exec(result.stdout)?.[1];
  if (id === undefined) throw new Error(`no session: ${result.stderr}`);
  const events: readonly TurnEvent[] = (await readSessionLog(sessionFile(openStore(armEnv), asSessionId(id)))).events;
  const compactions = events.filter((e): e is Extract<TurnEvent, { kind: 'compact' }> => e.kind === 'compact');
  const answer = events.findLast((e): e is Extract<TurnEvent, { kind: 'assistant' }> => e.kind === 'assistant')?.content.flatMap((b) => (b.type === 'text' ? [b.text] : [])).join('') ?? '';
  return {
    compactAt,
    calls: events.filter((e) => e.kind === 'assistant').length,
    compactions: compactions.length,
    costUsd: events.reduce((sum, e) => sum + (spendOf(e)?.costUsd ?? 0), 0),
    recalled: KEYS.filter((key, i) => new RegExp(`${String(i + 1).padStart(2, '0')}\\s*:\\s*\\**${key}`, 'i').test(answer)).length,
    tokensAfter: compactions.map((c) => c.tokensAfter),
    summaryCostUsd: compactions.map((c) => c.costUsd ?? 0),
  };
}

/**
 * A session of `calls` model calls whose context starts at `start` tokens and grows by `growth` a call, compacting
 * back to `after` once it reaches `compactAt`. Each call reads its whole context; a summary reads at most
 * `summaryInput` tokens and writes SUMMARY_TOKENS.
 */
function project(compactAt: number, shape: { calls: number; start: number; growth: number; output: number; after: number; summaryInput: number }): { costUsd: number; compactions: number; meanContext: number } {
  const rates = ratesOf('modelstudio', MODEL)!;
  let context = shape.start;
  let costUsd = 0;
  let compactions = 0;
  let total = 0;
  for (let call = 0; call < shape.calls; call++) {
    if (context >= compactAt) {
      costUsd += (Math.min(context, shape.summaryInput) * rates.input + SUMMARY_TOKENS * rates.output) / 1e6;
      compactions++;
      context = shape.after;
    }
    total += context;
    costUsd += ((context - shape.growth) * rates.cacheRead + shape.growth * rates.input + shape.output * rates.output) / 1e6;
    context += shape.growth + shape.output;
  }
  return { costUsd, compactions, meanContext: Math.round(total / shape.calls) };
}

async function main(): Promise<number> {
  const root = path.resolve(import.meta.dirname, '../../..');
  const dotenv = parseEnv(await readFile(process.env['GCODE_ENV_FILE'] || path.join(root, '.env'), 'utf8'));
  const key = dotenv['DASHSCOPE_API_KEY'];
  const baseUrl = dotenv['DASHSCOPE_BASE_URL'];
  if (!key || !baseUrl) throw new Error('the .env needs DASHSCOPE_API_KEY and DASHSCOPE_BASE_URL');
  const env = { GCODE_PROVIDER: 'modelstudio', GCODE_MODEL: MODEL, DASHSCOPE_API_KEY: key, DASHSCOPE_BASE_URL: baseUrl, GCODE_RG: rgCommand(), PATH: process.env['PATH'] ?? '/usr/bin:/bin' };

  const arms: Arm[] = [];
  for (const { compactAt, maxCostUsd } of ARMS) {
    const arm = await runArm(env, compactAt, maxCostUsd);
    arms.push(arm);
    console.log(JSON.stringify({ live: arm }));
  }
  const spent = arms.reduce((sum, arm) => sum + arm.costUsd, 0);
  console.log(JSON.stringify({ liveCostUsd: Number(spent.toFixed(4)) }));

  // Growth and output per call are the means over this machine's longer qwen3.8-flash sessions; the context left after
  // a full-size compaction is the system prompt and tools, the kept tail, and the summary.
  const shape = { calls: 1_500, start: 3_900, growth: 800, output: 400, after: 3_900 + KEEP_TAIL_TOKENS + SUMMARY_TOKENS, summaryInput: 60_000 };
  const window = capabilitiesOf('modelstudio', MODEL).window!;
  for (const compactAt of [200_000, 800_000, window - 33_000]) console.log(JSON.stringify({ projected: { compactAt, ...project(compactAt, shape) } }));
  if (key && JSON.stringify(arms).includes(key)) throw new Error('the key reached the output');
  return spent < 0.2 ? 0 : 1;
}

void main().then((code) => (process.exitCode = code));
