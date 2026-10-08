// The P34 eval: one-step workflows whose step has a schema, run in an editor session on Model Studio qwen3.8-flash,
// with the step's fields from its report's JSON block alone (block, GCODE_STRUCTURED_OUTPUT=off), from a forced
// structured_output call after every report that falls back to the block (always), or from the block with a forced
// call only when the block does not fit (fallback, the default). One JSON line per run. A case's reps rotate which
// arm goes first.
// Usage: tsx packages/engine/test/structured-output-eval.ts <env file> <out dir> <reps> [budget USD, default 0.28] [arms,] [cases,]
//        tsx packages/engine/test/structured-output-eval.ts --summary <out dir>
//        tsx packages/engine/test/structured-output-eval.ts --rescore <out dir>
// Reads DASHSCOPE_API_KEY and DASHSCOPE_BASE_URL from the env file and never prints them. Stops before the spend passes the budget.
import { execFileSync } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { parseEnv } from 'node:util';
import * as acp from '@agentclientprotocol/sdk';
import { asSessionId, handedBack, readFields, STRUCTURED_OUTPUT_TOOL, structuredFields, toolResultText, TASK_UPDATE_METHOD, TASKS_CAPABILITY, WORKFLOWS_CAPABILITY, type FieldValue, type OutputSchema, type TaskUpdate, type TurnEvent } from '@g-code/core';
import type { Io } from '../src/command.js';
import { engineShared, gcodeAgent } from '../src/serve.js';
import { readSessionLog, sessionFile } from '../src/sessions.js';
import { openStore, type Store } from '../src/store.js';

type Fields = Readonly<Record<string, FieldValue>>;
type Case = { readonly id: string; readonly files: Readonly<Record<string, string>>; readonly prompt: string; readonly schema: OutputSchema; readonly correct: (fields: Fields) => boolean };
const ARMS = ['block', 'always', 'fallback'] as const;
type Arm = (typeof ARMS)[number];
const SETTING: Readonly<Record<Arm, string>> = { block: 'off', always: 'always', fallback: 'on' };

const sameSet = (value: FieldValue | undefined, want: readonly string[]) =>
  Array.isArray(value) && value.length === want.length && want.every((w) => value.some((v: string) => v.replace(/^\.?\//, '') === w));

const CASES: readonly Case[] = [
  {
    id: 'exports',
    files: { 'src/math.ts': 'export function add(a: number, b: number) {\n  return a + b;\n}\n\nexport function sub(a: number, b: number) {\n  return a - b;\n}\n\nfunction clamp(x: number) {\n  return Math.max(0, x);\n}\n', 'src/str.ts': "export const pad = (s: string) => ` ${s} `;\n" },
    prompt: 'Which functions does src/math.ts export? List their names and how many there are.',
    schema: { names: 'string[]', count: 'number' },
    correct: (f) => sameSet(f['names'], ['add', 'sub']) && f['count'] === 2,
  },
  {
    id: 'quote',
    files: { 'src/config.ts': "export function port(raw: string): number {\n  const n = Number(raw);\n  if (Number.isNaN(n)) {\n    throw new Error('Config \"port\" must be a number, got \"' + raw + '\"');\n  }\n  return n;\n}\n" },
    prompt: 'Quote, character for character, the string literal that starts the error message thrown in src/config.ts (from Config up to and including got "), and give its line number.',
    schema: { message: 'string', line: 'number' },
    correct: (f) => f['message'] === 'Config "port" must be a number, got "' && f['line'] === 4,
  },
  {
    id: 'review',
    files: { 'src/cart.ts': 'export function total(prices: number[]): number {\n  let sum = 0;\n  for (let i = 0; i <= prices.length; i++) {\n    sum += prices[i];\n  }\n  return sum;\n}\n\nexport function discount(total: number, pct: number): number {\n  return total - total * pct;\n}\n' },
    prompt: 'Review src/cart.ts for bugs. Write a thorough review: for each bug, the line, what goes wrong and the fix.',
    schema: { pass: 'boolean', bugs: 'number', lines: 'string[]' },
    correct: (f) => f['pass'] === false && typeof f['bugs'] === 'number' && f['bugs'] >= 1,
  },
  {
    id: 'todos',
    files: { 'src/a.ts': '// TODO: cache this\nexport const a = 1;\n', 'src/b.ts': 'export const b = 2;\n', 'src/c.ts': 'export const c = 3; // TODO remove\n// TODO(sam): rename\n' },
    prompt: 'Find every TODO comment under src/. Say how many there are and which files hold them.',
    schema: { count: 'number', files: 'string[]' },
    correct: (f) => f['count'] === 3 && sameSet(f['files'], ['src/a.ts', 'src/c.ts']),
  },
  {
    id: 'package',
    files: { 'package.json': `${JSON.stringify({ name: 'shop', private: true, engines: { node: '>=22.4' }, scripts: { test: 'vitest run --coverage' } }, null, 2)}\n` },
    prompt: "What does package.json set as the test script and as the node engine, and is the package private?",
    schema: { test: 'string', node: 'string', private: 'boolean' },
    correct: (f) => f['test'] === 'vitest run --coverage' && f['node'] === '>=22.4' && f['private'] === true,
  },
  {
    id: 'readme',
    files: { 'README.md': '# Shop API\n\nA small cart service.\n\n## Install\n\nRun `pnpm install`.\n\n## Usage\n\nStart it with `pnpm start`.\n\n## License\n\nMIT\n' },
    prompt: "Summarize README.md: its title, its section headings in order, whether it has a license section, how many sections it has, and in one sentence what the project is.",
    schema: { title: 'string', sections: 'string[]', has_license: 'boolean', section_count: 'number', summary: 'string' },
    correct: (f) => f['title'] === 'Shop API' && JSON.stringify(f['sections']) === JSON.stringify(['Install', 'Usage', 'License']) && f['has_license'] === true && f['section_count'] === 3,
  },
];

type Row = {
  readonly case: string;
  readonly arm: Arm;
  readonly rep: number;
  readonly status: string;
  readonly valid: boolean;
  readonly correct: boolean;
  readonly blockValid: boolean;
  readonly forced: 'ok' | 'invalid' | 'no-call' | 'not-run' | 'off';
  readonly forcedCostUsd: number;
  readonly childCostUsd: number;
  readonly parentCostUsd: number;
  readonly turns: number;
  readonly stop: string | undefined;
};

const rowsOf = (file: string): Row[] => (existsSync(file) ? readFileSync(file, 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line) as Row) : []);
const spentOf = (rows: readonly Row[]) => rows.reduce((sum, row) => sum + row.childCostUsd + row.parentCostUsd, 0);

// Scores the logs a run left with today's readFields: the arm's rule picks the fields from the report's block and the
// forced call's input, so a fix to the block parse is scored on the same model outputs without another model call.
if (process.argv[2] === '--rescore') {
  const runs = path.join(process.argv[3]!, 'runs');
  const scored: { arm: Arm; case: string; valid: boolean; correct: boolean; fits: boolean; forced: boolean }[] = [];
  for (const dir of readdirSync(runs).sort()) {
    const [id, raw] = dir.split('-');
    const arm: Arm = raw === 'forced' ? 'always' : (raw as Arm);
    const c = CASES.find((each) => each.id === id)!;
    const sessions = path.join(runs, dir, 'home', '.g-code', 'sessions');
    for (const file of readdirSync(sessions).filter((name) => name.endsWith('.jsonl'))) {
      const { events } = await readSessionLog(path.join(sessions, file));
      if (events[0]?.kind !== 'session-start' || events[0].child === undefined) continue;
      const block = readFields(handedBack(events.slice(1), false), c.schema);
      const use = events.flatMap((e) => (e.kind === 'assistant' ? e.content : [])).find((b) => b.type === 'tool_use' && b.name === STRUCTURED_OUTPUT_TOOL);
      const forced = use?.type === 'tool_use' ? structuredFields(use.input, c.schema) : undefined;
      const pick = arm === 'block' ? block : arm === 'always' ? (forced?.ok === true ? forced : block) : block.ok ? block : forced;
      scored.push({ arm, case: c.id, valid: pick?.ok === true, correct: pick?.ok === true && c.correct(pick.value), fits: block.ok, forced: arm === 'always' || (arm === 'fallback' && !block.ok) });
    }
  }
  const count = (rows: readonly (typeof scored)[number][], test: (row: (typeof scored)[number]) => boolean) => `${rows.filter(test).length}/${rows.length}`;
  for (const arm of ARMS) {
    const rows = scored.filter((row) => row.arm === arm);
    console.log(`${arm}: valid ${count(rows, (r) => r.valid)}, correct ${count(rows, (r) => r.correct)}, report block fits ${count(rows, (r) => r.fits)}, forced call made ${count(rows, (r) => r.forced)}`);
    for (const c of CASES) {
      const of = rows.filter((row) => row.case === c.id);
      console.log(`  ${c.id}: valid ${count(of, (r) => r.valid)}, correct ${count(of, (r) => r.correct)}, block fits ${count(of, (r) => r.fits)}`);
    }
  }
  process.exit(0);
}

if (process.argv[2] === '--summary') {
  const rows = rowsOf(path.join(process.argv[3]!, 'results.jsonl'));
  const count = (runs: readonly Row[], test: (row: Row) => boolean) => `${runs.filter(test).length}/${runs.length}`;
  for (const arm of ARMS) {
    const runs = rows.filter((row) => row.arm === arm);
    const perRun = runs.reduce((sum, row) => sum + row.childCostUsd, 0) / Math.max(1, runs.length);
    console.log(`${arm}: valid ${count(runs, (r) => r.valid)}, correct ${count(runs, (r) => r.correct)}, report block valid ${count(runs, (r) => r.blockValid)}, child cost per run $${perRun.toFixed(5)}`);
    if (arm !== 'block') console.log(`  forced call: ok ${count(runs, (r) => r.forced === 'ok')}, invalid ${count(runs, (r) => r.forced === 'invalid')}, no call ${count(runs, (r) => r.forced === 'no-call')}, not run ${count(runs, (r) => r.forced === 'not-run')}; forced cost per run $${(runs.reduce((s, r) => s + r.forcedCostUsd, 0) / Math.max(1, runs.length)).toFixed(5)}`);
    for (const c of CASES) {
      const of = runs.filter((row) => row.case === c.id);
      console.log(`  ${c.id}: valid ${count(of, (r) => r.valid)}, correct ${count(of, (r) => r.correct)}, block ${count(of, (r) => r.blockValid)}`);
    }
  }
  console.log(`spent $${spentOf(rows).toFixed(4)} over ${rows.length} runs`);
  process.exit(0);
}

const [envFile, out, repsRaw, budgetRaw, armsRaw, casesRaw] = process.argv.slice(2);
if (envFile === undefined || out === undefined || repsRaw === undefined) throw new Error('usage: tsx packages/engine/test/structured-output-eval.ts <env file> <out dir> <reps> [budget]');
const outDir: string = out;
const BUDGET = Number(budgetRaw ?? '0.28');
const secrets = parseEnv(readFileSync(envFile, 'utf8'));
const results = path.join(outDir, 'results.jsonl');
mkdirSync(path.join(outDir, 'runs'), { recursive: true });

async function until(done: () => boolean | Promise<boolean>, what: string, ms = 240_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!(await done())) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
}

const eventsOf = async (store: Store, id: string): Promise<readonly TurnEvent[]> => (await readSessionLog(sessionFile(store, asSessionId(id)))).events;
const costOf = (events: readonly TurnEvent[]) => events.reduce((sum, e) => sum + (e.kind === 'assistant' ? (e.costUsd ?? 0) : 0), 0);

async function runOnce(c: Case, arm: Arm, rep: number): Promise<Row> {
  const root = mkdtempSync(path.join(outDir, 'runs', `${c.id}-${arm}-${rep}-`));
  const workspace = path.join(root, 'ws');
  const home = path.join(root, 'home');
  mkdirSync(home, { recursive: true });
  const workflow = { description: `P34 case ${c.id}`, maxCostUsd: 0.1, steps: [{ id: 'answer', role: 'explore', prompt: c.prompt, maxTurns: 6, maxCostUsd: 0.03, schema: c.schema }] };
  for (const [file, text] of Object.entries({ ...c.files, '.g-code/workflows/p34.json': JSON.stringify(workflow, null, 2) })) {
    mkdirSync(path.dirname(path.join(workspace, file)), { recursive: true });
    writeFileSync(path.join(workspace, file), text);
  }
  const git = (...args: string[]) => execFileSync('git', args, { cwd: workspace, stdio: 'ignore', env: { ...process.env, HOME: home, GIT_CONFIG_NOSYSTEM: '1' } });
  git('init', '-q', '-b', 'main');
  git('add', '-A');
  git('-c', 'user.name=eval', '-c', 'user.email=eval@example.com', 'commit', '-qm', 'start');
  const env: Record<string, string> = {
    GCODE_HOME: path.join(home, '.g-code'),
    HOME: home,
    PATH: process.env['PATH'] ?? '/usr/bin:/bin',
    GCODE_RG: 'rg',
    GCODE_PROVIDER: 'modelstudio',
    GCODE_MODEL: 'qwen3.8-flash',
    DASHSCOPE_API_KEY: secrets['DASHSCOPE_API_KEY'] ?? '',
    DASHSCOPE_BASE_URL: secrets['DASHSCOPE_BASE_URL'] ?? '',
    GCODE_STRUCTURED_OUTPUT: SETTING[arm],
    GCODE_TEST_LOCK: 'off',
    // The run's report would wake the editor's session for one more model call, which the eval does not read.
    GCODE_WAKE_POLICY: JSON.stringify({ batchMs: 3_600_000 }),
  };
  const io: Io = { env, cwd: workspace, out: () => {}, err: () => {}, write: () => {}, interrupts: () => new AbortController().signal, confirm: async () => false, fetch: globalThis.fetch };
  const store = openStore(env);
  const tasks: TaskUpdate[] = [];
  const editor = acp
    .client({ name: 'p34-eval' })
    .onRequest(acp.methods.client.session.requestPermission, ({ params }) => ({ outcome: { outcome: 'selected', optionId: params.options[0]!.optionId } }))
    .onNotification(acp.methods.client.session.update, () => {})
    .onNotification(TASK_UPDATE_METHOD, (raw) => raw as TaskUpdate, ({ params }) => void tasks.push(params));
  const engine = engineShared(io);
  try {
    return await editor.connectWith(gcodeAgent(io, store, { maxTurns: 10, maxCostUsd: 0.2 }, undefined, engine), async (ctx) => {
      await ctx.request(acp.methods.agent.initialize, { protocolVersion: acp.PROTOCOL_VERSION, clientCapabilities: { _meta: { [TASKS_CAPABILITY]: true, [WORKFLOWS_CAPABILITY]: true } } });
      const { sessionId } = await ctx.request(acp.methods.agent.session.new, { cwd: workspace, mcpServers: [] });
      await ctx.request(acp.methods.agent.session.setMode, { sessionId, modeId: 'auto' });
      await ctx.request(acp.methods.agent.session.prompt, { sessionId, prompt: [{ type: 'text', text: '/workflow p34' }] });
      const runId = () => tasks.find((u) => u.task.workflow?.name === 'p34')?.task.sessionId;
      const final = () => tasks.findLast((u) => u.task.sessionId === runId() && u.task.workflow !== undefined && u.task.workflow.status !== 'running');
      await until(() => final() !== undefined, 'the run to end');
      const run = await eventsOf(store, runId()!);
      const childId = run.flatMap((e) => (e.kind === 'child-start' ? [e.child] : []))[0];
      const child = childId === undefined ? [] : await eventsOf(store, childId);
      const result = run.findLast((e) => e.kind === 'tool-result' && e.name === 'agent');
      const output = result?.kind === 'tool-result' ? toolResultText(result) : '';
      const fields = readFields(output, c.schema);
      const ran = child.filter((e) => e.kind !== 'session-start');
      const forcedTurn = child.findLast((e) => e.kind === 'assistant' && e.content.some((b) => b.type === 'tool_use' && b.name === STRUCTURED_OUTPUT_TOOL));
      const forcedResult = child.findLast((e) => e.kind === 'tool-result' && e.name === STRUCTURED_OUTPUT_TOOL);
      const reported = child.findLastIndex((e) => e.kind === 'tool-result' && e.name === 'report');
      const afterReport = reported === -1 ? [] : child.slice(reported + 1);
      const forced: Row['forced'] =
        arm === 'block' ? 'off' : forcedResult?.kind === 'tool-result' ? (forcedResult.status === 'ok' ? 'ok' : 'invalid') : afterReport.some((e) => e.kind === 'assistant') ? 'no-call' : 'not-run';
      const status = final()!.task.workflow!.status;
      return {
        case: c.id,
        arm,
        rep,
        status,
        valid: status === 'done' && fields.ok,
        correct: status === 'done' && fields.ok && c.correct(fields.value),
        blockValid: readFields(handedBack(ran, false), c.schema).ok,
        forced,
        forcedCostUsd: forcedTurn?.kind === 'assistant' ? (forcedTurn.costUsd ?? 0) : 0,
        childCostUsd: costOf(child),
        parentCostUsd: costOf(await eventsOf(store, sessionId)),
        turns: child.filter((e) => e.kind === 'assistant').length,
        stop: final()!.task.workflow!.stop,
      };
    });
  } finally {
    await engine.jobs.kill('engine-exit', 'all');
  }
}

const reps = Number(repsRaw);
for (let rep = 1; rep <= reps; rep++) {
  for (const [i, c] of CASES.entries()) {
    if (casesRaw !== undefined && !casesRaw.split(',').includes(c.id)) continue;
    const order: readonly Arm[] = ARMS.map((_, k) => ARMS[(rep + i + k) % ARMS.length]!);
    for (const arm of order.filter((each) => armsRaw === undefined || armsRaw.split(',').includes(each))) {
      const done = rowsOf(results);
      if (done.some((row) => row.case === c.id && row.arm === arm && row.rep === rep)) continue;
      if (spentOf(done) >= BUDGET) {
        console.log(`stopped: spent $${spentOf(done).toFixed(4)} of $${BUDGET}`);
        process.exit(0);
      }
      const row = await runOnce(c, arm, rep).catch((error: unknown) => {
        console.log(`${c.id} ${arm} ${rep}: ${error instanceof Error ? error.message : String(error)}`);
        return undefined;
      });
      if (row === undefined) continue;
      appendFileSync(results, `${JSON.stringify(row)}\n`);
      console.log(`${c.id} ${arm} ${rep}: ${row.status} valid=${row.valid} correct=${row.correct} block=${row.blockValid} forced=${row.forced} child=$${row.childCostUsd.toFixed(5)} parent=$${row.parentCostUsd.toFixed(5)}`);
    }
  }
}
console.log(`spent $${spentOf(rowsOf(results)).toFixed(4)}`);
// The engines' sockets to the provider stay open after their jobs end.
process.exit(0);
