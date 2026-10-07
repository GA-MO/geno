// Run from the repository root: pnpm tsx packages/engine/test/handback-smoke.ts [runs]
// GCODE_ENV_FILE names the .env holding DASHSCOPE_API_KEY and DASHSCOPE_BASE_URL; it defaults to the repo's.
// The parent, on Model Studio qwen3.8-flash with the agent tool on, starts a background explore in a small fixture
// repository. Per run it counts the parent's turns that state results before the report arrives, the searches the
// parent ran itself meanwhile, and how the child handed back. Each run is capped at $0.03.
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { parseEnv } from 'node:util';
import { asSessionId, childrenOf, handedBack, REPORT_TOOL, type TurnEvent } from '@g-code/core';
import { readSessionLog, sessionFile } from '../src/sessions.js';
import { openStore } from '../src/store.js';
import { makeRepo } from './git-fixture.js';
import { rgCommand, runCli } from './helpers.js';

const MODEL = 'qwen3.8-flash';
const RUN_CAP_USD = 0.03;
const PROMPT = 'Use a background explore subagent to find where resolveTimeout is defined and which files call it, then tell me.';
const FILES = {
  '.gcode.json': `${JSON.stringify({ agentTool: ['non-interactive'] })}\n`,
  'src/config.ts': 'export const DEFAULT_TIMEOUT = 30;\n\nexport function resolveTimeout(raw: string | undefined): number {\n  const value = Number(raw);\n  return value > 0 ? value : DEFAULT_TIMEOUT;\n}\n',
  'src/server.ts': "import { resolveTimeout } from './config';\n\nexport const serverTimeout = resolveTimeout(process.env.SERVER_TIMEOUT);\n",
  'src/jobs/worker.ts': "import { resolveTimeout } from '../config';\n\nexport function workerTimeout(env: Record<string, string>): number {\n  return resolveTimeout(env.WORKER_TIMEOUT) * 2;\n}\n",
  'src/util.ts': 'export const noop = () => {};\n',
};
/** Words only the child's findings carry: a file that defines or calls resolveTimeout. */
const RESULT_WORDS = /config\.ts|server\.ts|worker\.ts/;
const SEARCHES = new Set(['grep', 'glob', 'read', 'list', 'bash']);

const textOf = (event: Extract<TurnEvent, { kind: 'assistant' }>): string => event.content.flatMap((b) => (b.type === 'text' ? [b.text] : [])).join('\n');
const joined = (events: readonly TurnEvent[]): string => events.flatMap((e) => (e.kind === 'assistant' ? [textOf(e).trim()].filter((t) => t !== '') : [])).join('\n\n');

async function once(env: Record<string, string>, key: string): Promise<{ readonly cost: number; readonly early: number; readonly duplicated: number; readonly rechecked: number }> {
  const workspace = makeRepo('handback', [{ message: 'start', files: FILES }]);
  const { code, stdout, stderr } = await runCli(['agent', '--workspace', workspace, '--non-interactive', '--max-cost', String(RUN_CAP_USD), '--max-turns', '8', PROMPT], env, { fetch: globalThis.fetch });
  if (stdout.includes(key) || stderr.includes(key)) throw new Error('the key reached the output');
  const sessionId = /^session: (\S+)$/m.exec(stdout)?.[1];
  if (sessionId === undefined) throw new Error(`no session (exit ${code}): ${stderr}`);
  const store = openStore(env);
  const parent = (await readSessionLog(sessionFile(store, asSessionId(sessionId)))).events;
  // The model turn that started the child: a search in that same turn already duplicates the child's work.
  const launched = parent.findIndex((e) => e.kind === 'assistant' && e.content.some((b) => b.type === 'tool_use' && b.name === 'agent'));
  const arrived = parent.findIndex((e) => (e.kind === 'user' && e.from === 'child') || (e.kind === 'tool-result' && e.name === 'agent' && 'output' in e && e.output.includes('<subagent_report')));
  const pending = launched === -1 ? [] : parent.slice(launched + 1, arrived === -1 ? undefined : arrived);
  const early = pending.filter((e) => e.kind === 'assistant' && RESULT_WORDS.test(textOf(e))).length;
  const duplicated = pending.filter((e) => e.kind === 'tool-result' && SEARCHES.has(e.name)).length;
  const rechecked = launched === -1 || arrived === -1 ? 0 : parent.slice(arrived).filter((e) => e.kind === 'tool-result' && SEARCHES.has(e.name)).length;
  const children = childrenOf(parent);
  const parentCost = parent.reduce((sum, e) => sum + (e.kind === 'assistant' ? (e.costUsd ?? 0) : 0), 0);
  const cost = parentCost + children.reduce((sum, c) => sum + (c.costUsd ?? 0), 0);

  console.log(`--- session ${sessionId}: exit ${code}, ${children.length} child(ren), $${cost.toFixed(5)}`);
  console.log(`background launch: ${launched === -1 ? 'none' : 'yes'}; report arrived: ${arrived === -1 ? 'no' : 'yes'}; parent turns that state results before the report: ${early}; parent searches meanwhile: ${duplicated}; parent searches after the report: ${rechecked}`);
  for (const child of children) {
    const events = (await readSessionLog(sessionFile(store, child.child))).events;
    const ran = events.filter((e) => e.kind !== 'session-start');
    const calledReport = ran.some((e) => e.kind === 'tool-result' && e.name === REPORT_TOOL && e.status === 'ok');
    const nudged = ran.some((e) => e.kind === 'report-nudge');
    console.log(`child ${child.role} ${child.status.kind}, ${child.turns} turns: report call ${calledReport ? 'yes' : 'no'}, nudged ${nudged ? 'yes' : 'no'}`);
    console.log(`  before P17 (every text joined):\n${indent(joined(ran))}`);
    console.log(`  after P17 (handed back):\n${indent(handedBack(ran, child.status.kind !== 'done'))}`);
  }
  const final = parent.findLast((e) => e.kind === 'assistant');
  console.log(`parent's final answer:\n${indent(final?.kind === 'assistant' ? textOf(final) : '')}`);
  return { cost, early, duplicated, rechecked };
}

const indent = (text: string): string => text.split('\n').map((line) => `    ${line}`).join('\n');

async function main(): Promise<number> {
  const runs = Number(process.argv[2] ?? '3');
  const repo = path.resolve(import.meta.dirname, '../../..');
  const dotenv = parseEnv(await readFile(process.env['GCODE_ENV_FILE'] || path.join(repo, '.env'), 'utf8'));
  const key = dotenv['DASHSCOPE_API_KEY'];
  const baseUrl = dotenv['DASHSCOPE_BASE_URL'];
  if (!key || !baseUrl) throw new Error('the .env needs DASHSCOPE_API_KEY and DASHSCOPE_BASE_URL');
  const home = makeRepo('home', [{ message: 'home', files: { '.keep': '' } }]);
  const env = { GCODE_HOME: path.join(home, 'gcode'), HOME: home, GCODE_PROVIDER: 'modelstudio', GCODE_MODEL: MODEL, DASHSCOPE_API_KEY: key, DASHSCOPE_BASE_URL: baseUrl, GCODE_RG: rgCommand(), PATH: process.env['PATH'] ?? '/usr/bin:/bin' };
  let total = 0;
  let early = 0;
  let duplicated = 0;
  let rechecked = 0;
  for (let i = 0; i < runs; i++) {
    const result = await once(env, key);
    total += result.cost;
    early += result.early;
    duplicated += result.duplicated;
    rechecked += result.rechecked;
  }
  console.log(`=== ${runs} runs: parent turns that state results before the report ${early}, parent searches meanwhile ${duplicated}, parent searches after the report ${rechecked}, spend $${total.toFixed(5)}`);
  return 0;
}

void main().then((code) => (process.exitCode = code));
