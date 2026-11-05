// The landing-page bake-off in one command: check the meter on its fixtures, have Claude Code and Geno each build the
// BeanCraft page `--runs` times from an empty folder and take one round of feedback, score every page by script,
// judge the pages blind in pairs, and write the results doc and the owner's blind vote page.
// Every stage keeps its output in the round's folder and skips what is already there, so a rerun resumes.
// usage: node scripts/harness-parity/landing/run.mjs [--round l1] [--runs 3] [--budget 15] [--parallel 3] [--judge api|cli] [--stability 9] [--only calibrate|run|measure|judge|report]
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { converse, diffStat, transcriptOf, writeHome } from '../harness.mjs';
import { spend } from '../llm.mjs';
import { RUNS_DIR } from '../paths.mjs';
import { render } from '../transcript.mjs';
import { CHECKS, passed, score } from './checks.mjs';
import { judgeFixes, judgePair } from './judge.mjs';
import { measure } from './measure.mjs';
import { writeReport } from './report.mjs';
import { HARNESSES, parseOptions } from './rules.mjs';
import { makeSheets } from './sheets.mjs';
import { behaviour, lineDiff } from './stats.mjs';
import { FEEDBACK, PROMPT, TASK_ID, WORKSPACE } from './task.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CONTINUES = 2;
/** What one run of both rounds is assumed to cost until a finished run says otherwise. */
const RUN_ESTIMATE_USD = 1.5;
const JUDGE_ESTIMATE_USD = 0.12;

let opts;
try {
  opts = parseOptions(process.argv.slice(2));
} catch (error) {
  console.error(error.message);
  process.exit(2);
}
if (opts.help) {
  console.log(readFileSync(fileURLToPath(import.meta.url), 'utf8').split('\n').slice(0, 5).join('\n'));
  process.exit(0);
}
const ROUND = path.join(RUNS_DIR, opts.round);
mkdirSync(ROUND, { recursive: true });
const readJson = (file, fallback) => (existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : fallback);
const writeJson = (file, value) => writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
const LEDGER = path.join(ROUND, 'ledger.json');
const JUDGED = path.join(ROUND, 'judge.json');

/** API dollars this round spent: the harness runs' own costs plus every judge and hand-back reader call. */
function spent(jobs) {
  const runs = jobs.map((j) => readJson(path.join(j.dir, 'record.json'), undefined)).filter(Boolean).reduce((s, r) => s + r.rounds.reduce((t, x) => t + x.costUsd, 0), 0);
  return runs + readJson(LEDGER, { usd: 0 }).usd;
}
function charge() {
  const ledger = readJson(LEDGER, { usd: 0 });
  ledger.usd += spend.usd;
  spend.usd = 0;
  writeJson(LEDGER, ledger);
}

/** What went wrong in a stage that the later stages can still work around; the command exits 1 when any is left. */
const problems = [];
const jobs = HARNESSES.flatMap((harness) => Array.from({ length: opts.runs }, (_, i) => ({ harness, n: i + 1, dir: path.join(ROUND, `${TASK_ID}.${harness}.${i + 1}`) })));

async function calibrate() {
  const file = path.join(ROUND, 'calibration.json');
  const fixtures = { reference: path.join(HERE, 'fixtures/reference'), blank: path.join(HERE, 'fixtures/blank'), hostile: path.join(HERE, 'fixtures/hostile'), missing: path.join(HERE, 'fixtures/missing') };
  const result = {};
  for (const [name, dir] of Object.entries(fixtures)) {
    const scores = score(await measure(dir, path.join(ROUND, 'calibration', name)));
    result[name] = { passed: passed(scores), of: CHECKS.length, failed: Object.entries(scores).filter(([, s]) => !s.pass).map(([id, s]) => `${id}: ${s.detail}`), passedIds: Object.entries(scores).filter(([, s]) => s.pass).map(([id]) => id) };
    console.log(`calibrate ${name}: ${result[name].passed}/${CHECKS.length}`);
  }
  const off = [];
  if (result.reference.passed < Math.ceil(CHECKS.length * 0.9)) off.push(`the reference page passes only ${result.reference.passed}/${CHECKS.length}: ${result.reference.failed.join('; ')}`);
  for (const name of ['blank', 'missing']) if (result[name].passed > Math.floor(CHECKS.length * 0.1)) off.push(`the ${name} page passes ${result[name].passed}: ${result[name].passedIds.join(', ')}`);
  for (const id of ['no-storage', 'self-contained', 'no-hscroll@1280', 'tap-targets@375', 'console', 'no-pin', 'checkout', 'reduced-motion']) if (result.hostile.passedIds.includes(id)) off.push(`the hostile page passes ${id}`);
  writeJson(file, { ...result, off });
  if (off.length > 0) throw new Error(`the meter is off, so nothing was run:\n${off.join('\n')}`);
}

const copyPage = (from, to) => cpSync(from, to, { recursive: true, filter: (src) => !/\/(node_modules|\.git)(\/|$)/.test(src) });

async function runJob(job) {
  const record = path.join(job.dir, 'record.json');
  if (existsSync(record)) return;
  rmSync(job.dir, { recursive: true, force: true });
  const home = path.join(job.dir, 'home');
  const ws = path.join(home, 'Development', WORKSPACE);
  mkdirSync(ws, { recursive: true });
  writeHome(home);
  const paths = { job: job.dir, home, ws };
  const state = { session: undefined, texts: [] };
  const rounds = [];
  let before = { costUsd: 0, modelCalls: 0, usage: { input: 0, cacheRead: 0, cacheWrite: 0, output: 0 } };
  for (const [i, text] of [PROMPT, FEEDBACK].entries()) {
    const started = Date.now();
    const { ends, error } = await converse(job.harness, paths, opts.model, state, text, text, CONTINUES);
    charge();
    if (error) {
      writeJson(path.join(job.dir, 'failed.json'), { round: i + 1, error });
      throw new Error(`${job.harness} ${job.n} round ${i + 1}: ${error}`);
    }
    const t = transcriptOf(job.harness, paths, state);
    const cut = t.steps.findIndex((s) => s.kind === 'user' && s.text === FEEDBACK);
    const steps = i === 0 ? t.steps : t.steps.slice(cut);
    const usage = Object.fromEntries(Object.keys(before.usage).map((k) => [k, (t.usage[k] ?? 0) - before.usage[k]]));
    rounds.push({ ms: Date.now() - started, ends, costUsd: t.costUsd - before.costUsd, modelCalls: t.modelCalls - before.modelCalls, usage, behaviour: behaviour(steps, i === 0 ? [] : ['index.html']) });
    before = { costUsd: t.costUsd, modelCalls: t.modelCalls, usage: { ...t.usage } };
    if (i === 0) copyPage(ws, path.join(job.dir, 'r1'));
  }
  rounds[1].diff = lineDiff(path.join(job.dir, 'r1', 'index.html'), path.join(ws, 'index.html'));
  copyPage(ws, path.join(job.dir, 'r2'));
  const t = transcriptOf(job.harness, paths, state);
  writeFileSync(path.join(job.dir, 'transcript.md'), `# ${TASK_ID} · ${job.harness} ${job.n} · ${opts.model}\n\n${render(t.steps)}\n\n## change summary (round 2)\n${diffStat(path.join(job.dir, 'r1'), ws)}\n`);
  writeJson(record, { harness: job.harness, n: job.n, model: opts.model, session: state.session, rounds });
}

async function runAll() {
  const queue = jobs.filter((j) => !existsSync(path.join(j.dir, 'record.json')));
  let running = 0;
  const done = jobs.length - queue.length;
  const average = () => {
    const costs = jobs.map((j) => readJson(path.join(j.dir, 'record.json'), undefined)).filter(Boolean).map((r) => r.rounds.reduce((s, x) => s + x.costUsd, 0));
    return costs.length ? Math.max(RUN_ESTIMATE_USD, costs.reduce((s, c) => s + c, 0) / costs.length) : RUN_ESTIMATE_USD;
  };
  console.log(`runs: ${done} of ${jobs.length} done, ${queue.length} to go, $${spent(jobs).toFixed(2)} spent of $${opts.budget}`);
  const failures = [];
  await Promise.all(
    Array.from({ length: opts.parallel }, async () => {
      while (queue.length > 0) {
        const projected = spent(jobs) + (running + 1) * average();
        if (projected > opts.budget) {
          failures.push(`stopped before ${queue.length} runs: they would take the spend to about $${projected.toFixed(2)} of the $${opts.budget} budget`);
          queue.length = 0;
          break;
        }
        const job = queue.shift();
        running += 1;
        console.log(`>>> ${job.harness} ${job.n}`);
        await runJob(job).then(
          () => console.log(`<<< ${job.harness} ${job.n} done, $${spent(jobs).toFixed(2)} spent`),
          (error) => failures.push(error.message),
        );
        running -= 1;
      }
    }),
  );
  problems.push(...failures);
}

async function measureAll() {
  for (const job of jobs) {
    for (const r of ['r1', 'r2']) {
      const shots = path.join(job.dir, `shots-${r}`);
      if (!existsSync(path.join(job.dir, r)) || existsSync(path.join(shots, 'sheets.json'))) continue;
      console.log(`measure ${job.harness} ${job.n} ${r}`);
      const m = await measure(path.join(job.dir, r), shots);
      writeJson(path.join(shots, 'sheets.json'), m.fatal ? {} : await makeSheets(shots, m));
    }
  }
}

const sheetsOf = (job, r) => readJson(path.join(job.dir, `shots-${r}`, 'sheets.json'), {});

async function judgeAll() {
  const judged = readJson(JUDGED, {});
  const claude = jobs.filter((j) => j.harness === 'claude');
  const geno = jobs.filter((j) => j.harness === 'geno');
  const pairs = claude.flatMap((c) => geno.map((g) => [c, g]));
  const work = [];
  for (const r of ['r1', 'r2']) for (const [c, g] of pairs) for (const order of ['AB', 'BA']) work.push({ key: `pair|${r}|c${c.n}|g${g.n}|${order}|1`, r, c, g, order });
  for (const [c, g] of pairs.slice(0, opts.stability)) for (const order of ['AB', 'BA']) work.push({ key: `pair|r2|c${c.n}|g${g.n}|${order}|2`, r: 'r2', c, g, order });
  for (const j of jobs) work.push({ key: `fix|${j.harness}${j.n}`, job: j });
  const todo = work.filter((w) => judged[w.key] === undefined);
  const remaining = opts.budget - spent(jobs);
  const via = opts.judge === 'cli' || remaining < todo.length * JUDGE_ESTIMATE_USD ? 'cli' : 'api';
  if (via !== opts.judge) console.log(`judge: $${remaining.toFixed(2)} of the budget is left for ${todo.length} calls, so the judge runs through the Claude Code CLI on the owner's sign-in`);
  for (const w of todo) {
    let result;
    if (w.job) {
      const job = w.job;
      const card = (r, width) => (existsSync(path.join(job.dir, `shots-${r}`, `cards-${width}.jpg`)) ? path.join(job.dir, `shots-${r}`, `cards-${width}.jpg`) : undefined);
      if (!sheetsOf(job, 'r1').hero || !sheetsOf(job, 'r2').hero) continue;
      result = await judgeFixes(sheetsOf(job, 'r1'), sheetsOf(job, 'r2'), { before: [[card('r1', 375), '375px'], [card('r1', 1280), '1280px']], after: [[card('r2', 375), '375px'], [card('r2', 1280), '1280px']] }, via);
    } else {
      const [a, b] = w.order === 'AB' ? [w.c, w.g] : [w.g, w.c];
      if (!sheetsOf(a, w.r).hero || !sheetsOf(b, w.r).hero) continue;
      result = await judgePair(sheetsOf(a, w.r), sheetsOf(b, w.r), via);
    }
    judged[w.key] = { ...result, via };
    writeJson(JUDGED, judged);
    charge();
    console.log(`judge ${w.key}: ${result.winner ?? JSON.stringify(result).slice(0, 80)}`);
  }
}

const stages = { calibrate, run: runAll, measure: measureAll, judge: judgeAll, report: () => writeReport({ round: opts.round, dir: ROUND, jobs, model: opts.model, budget: opts.budget, spentUsd: spent(jobs), judged: readJson(JUDGED, {}), problems }) };
try {
  for (const [name, stage] of Object.entries(stages)) if (opts.only === undefined || opts.only === name) await stage();
} catch (error) {
  console.error(error.message);
  process.exit(1);
}
if (problems.length > 0) console.error(problems.join('\n'));
process.exit(problems.length > 0 ? 1 : 0);
