// The landing-page bake-off in one command: check the meter on its fixtures, have Claude Code and Geno each build the
// BeanCraft page `--runs` times from an empty folder and take one round of feedback, score every page by script,
// judge the pages blind in pairs, and write the results doc and the owner's blind vote page.
// Every stage keeps its output in the round's folder and skips what is already there, so a rerun resumes.
// usage: node scripts/harness-parity/landing/run.mjs [--round l1] [--runs 3] [--budget 15] [--parallel 3] [--judge api|cli] [--stability 9] [--only calibrate|run|measure|judge|report] [--remeasure]
// --remeasure measures every page again after the meter changed; runs and verdicts already made are kept.
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
import { budgetStep, HARNESSES, pairStep, parseOptions } from './rules.mjs';
import { makeSheets } from './sheets.mjs';
import { roundsOf, spentBy } from './logs.mjs';
import { lineDiff } from './stats.mjs';
import { FEEDBACK, GO_ON_EN, PROMPT, TASK_ID, WORKSPACE } from './task.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CONTINUES = 2;
const JUDGE_ESTIMATE_USD = 0.12;
/**
 * What one run may spend over both rounds on either harness. Each segment is capped at what the run has left, a
 * capped run is not told to go on, and a run starts only when the round can afford every running one at this cap.
 */
const RUN_CAP_USD = 4;

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

/**
 * API dollars this round spent: what every run folder's logs say, finished or not, plus the ledger of judge and
 * hand-back reader calls and of run folders cleared for a retry.
 */
const spent = (jobs) => jobs.reduce((s, j) => s + spentBy(j.dir, j.harness), 0) + readJson(LEDGER, { usd: 0 }).usd;
function addToLedger(usd) {
  const ledger = readJson(LEDGER, { usd: 0 });
  ledger.usd += usd;
  writeJson(LEDGER, ledger);
}
/** Moves this process's judge and hand-back reader spend into the ledger. */
function charge() {
  addToLedger(spend.usd);
  spend.usd = 0;
}

/** What went wrong in a stage that the later stages can still work around; the command exits 1 when any is left. */
const problems = [];
const jobs = HARNESSES.flatMap((harness) => Array.from({ length: opts.runs }, (_, i) => ({ harness, n: i + 1, dir: path.join(ROUND, `${TASK_ID}.${harness}.${i + 1}`) })));

async function calibrate() {
  const file = path.join(ROUND, 'calibration.json');
  const fixtures = { reference: path.join(HERE, 'fixtures/reference'), blank: path.join(HERE, 'fixtures/blank'), hostile: path.join(HERE, 'fixtures/hostile'), reloads: path.join(HERE, 'fixtures/reloads'), missing: path.join(HERE, 'fixtures/missing') };
  const result = {};
  for (const [name, dir] of Object.entries(fixtures)) {
    const scores = score(await measure(dir, path.join(ROUND, 'calibration', name)));
    result[name] = { passed: passed(scores), of: CHECKS.length, failed: Object.entries(scores).filter(([, s]) => !s.pass).map(([id, s]) => `${id}: ${s.detail}`), passedIds: Object.entries(scores).filter(([, s]) => s.pass).map(([id]) => id) };
    console.log(`calibrate ${name}: ${result[name].passed}/${CHECKS.length}`);
  }
  const off = [];
  if (result.reference.passed < Math.ceil(CHECKS.length * 0.9)) off.push(`the reference page passes only ${result.reference.passed}/${CHECKS.length}: ${result.reference.failed.join('; ')}`);
  if (!result.reloads.passedIds.includes('context-restore') || result.reloads.passed < result.reference.passed) off.push(`the page that reloads to recover its WebGL context passes ${result.reloads.passed}, and context-restore ${result.reloads.passedIds.includes('context-restore') ? 'passes' : 'fails'}: ${result.reloads.failed.join('; ')}`);
  for (const name of ['blank', 'missing']) if (result[name].passed > Math.floor(CHECKS.length * 0.1)) off.push(`the ${name} page passes ${result[name].passed}: ${result[name].passedIds.join(', ')}`);
  for (const id of ['no-storage', 'self-contained', 'no-hscroll@1280', 'tap-targets@375', 'console', 'no-pin', 'checkout', 'reduced-motion']) if (result.hostile.passedIds.includes(id)) off.push(`the hostile page passes ${id}`);
  writeJson(file, { ...result, off });
  if (off.length > 0) throw new Error(`the meter is off, so nothing was run:\n${off.join('\n')}`);
}

const copyPage = (from, to) => cpSync(from, to, { recursive: true, filter: (src) => !/\/(node_modules|\.git)(\/|$)/.test(src) });

async function runJob(job) {
  const record = path.join(job.dir, 'record.json');
  if (existsSync(record)) return;
  if (existsSync(job.dir)) addToLedger(spentBy(job.dir, job.harness));
  rmSync(job.dir, { recursive: true, force: true });
  const home = path.join(job.dir, 'home');
  const ws = path.join(home, 'Development', WORKSPACE);
  mkdirSync(ws, { recursive: true });
  writeHome(home);
  const paths = { job: job.dir, home, ws };
  const state = {
    session: undefined,
    texts: [],
    get capUsd() {
      return Math.max(0.05, RUN_CAP_USD - spentBy(job.dir, job.harness));
    },
  };
  const rounds = [];
  let prior = { modelCalls: 0, usage: {} };
  for (const [i, text] of [PROMPT, FEEDBACK].entries()) {
    const started = Date.now();
    if (i === 1 && rounds[0].capped) {
      rounds.push({ ms: 0, ends: [], modelCalls: 0, usage: {}, skipped: 'the run spent its cap in round 1, so it got no feedback round' });
      break;
    }
    const { ends, error, capped } = await converse(job.harness, paths, opts.model, state, text, text, CONTINUES, GO_ON_EN);
    charge();
    if (error) {
      writeJson(path.join(job.dir, 'failed.json'), { round: i + 1, error });
      throw new Error(`${job.harness} ${job.n} round ${i + 1}: ${error}`);
    }
    const t = transcriptOf(job.harness, paths, state);
    rounds.push({ ms: Date.now() - started, ends, capped, modelCalls: t.modelCalls - prior.modelCalls, usage: Object.fromEntries(Object.entries(t.usage).map(([k, v]) => [k, v - (prior.usage[k] ?? 0)])) });
    prior = t;
    if (i === 0) copyPage(ws, path.join(job.dir, 'r1'));
  }
  for (const [i, r] of roundsOf(job.dir, job.harness).entries()) Object.assign(rounds[i], r);
  rounds[1].diff = lineDiff(path.join(job.dir, 'r1', 'index.html'), path.join(ws, 'index.html'));
  copyPage(ws, path.join(job.dir, 'r2'));
  const t = transcriptOf(job.harness, paths, state);
  writeFileSync(path.join(job.dir, 'transcript.md'), `# ${TASK_ID} · ${job.harness} ${job.n} · ${opts.model}\n\n${render(t.steps)}\n\n## change summary (round 2)\n${diffStat(path.join(job.dir, 'r1'), ws)}\n`);
  writeJson(record, { harness: job.harness, n: job.n, model: opts.model, session: state.session, rounds });
  if (rounds[1].skipped) problems.push(`${job.harness} ${job.n}: ${rounds[1].skipped}; its final page is its round 1 page`);
}

async function runAll() {
  const queue = jobs.filter((j) => !existsSync(path.join(j.dir, 'record.json')));
  const running = new Map();
  console.log(`runs: ${jobs.length - queue.length} of ${jobs.length} done, ${queue.length} to go, $${spent(jobs).toFixed(2)} spent of $${opts.budget}`);
  const failures = [];
  await Promise.all(
    Array.from({ length: opts.parallel }, async () => {
      while (queue.length > 0) {
        const runningLeftUsd = [...running.keys()].map((j) => RUN_CAP_USD - spentBy(j.dir, j.harness));
        const { step, projected } = budgetStep({ spentUsd: spent(jobs), runningLeftUsd, capUsd: RUN_CAP_USD, budgetUsd: opts.budget });
        if (step === 'wait') {
          await Promise.race(running.values());
          continue;
        }
        if (step === 'stop') {
          failures.push(`stopped before ${queue.length} runs: one more could take the spend to $${projected.toFixed(2)} of the $${opts.budget} budget`);
          queue.length = 0;
          break;
        }
        const job = queue.shift();
        console.log(`>>> ${job.harness} ${job.n}`);
        const done = runJob(job).then(
          () => console.log(`<<< ${job.harness} ${job.n} done, $${spent(jobs).toFixed(2)} spent`),
          (error) => failures.push(error.message),
        );
        running.set(job, done);
        await done;
        running.delete(job);
      }
    }),
  );
  problems.push(...failures);
}

async function measureAll() {
  for (const job of jobs) {
    for (const r of ['r1', 'r2']) {
      const shots = path.join(job.dir, `shots-${r}`);
      if (!existsSync(path.join(job.dir, r)) || (!opts.remeasure && existsSync(path.join(shots, 'sheets.json')))) continue;
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
  const waiting = new Set();
  for (const w of todo) {
    let result;
    if (w.job) {
      const job = w.job;
      const card = (r, width) => (existsSync(path.join(job.dir, `shots-${r}`, `cards-${width}.jpg`)) ? path.join(job.dir, `shots-${r}`, `cards-${width}.jpg`) : undefined);
      const shown = ['r1', 'r2'].every((r) => sheetsOf(job, r).hero !== undefined);
      if (shown) result = await judgeFixes(sheetsOf(job, 'r1'), sheetsOf(job, 'r2'), { before: [[card('r1', 375), '375px'], [card('r1', 1280), '1280px']], after: [[card('r2', 375), '375px'], [card('r2', 1280), '1280px']] }, via);
      else if (['r1', 'r2'].some((r) => readJson(path.join(job.dir, `shots-${r}`, 'measures.json'), {}).fatal !== undefined)) result = { why: 'no page to compare: a round left no index.html', forfeit: true };
      else {
        waiting.add(`the feedback judgement of ${job.harness} ${job.n} waits: the meter could not show a round of it; run again with --remeasure`);
        continue;
      }
    } else {
      const [a, b] = w.order === 'AB' ? [w.c, w.g] : [w.g, w.c];
      const facts = (p, label) => {
        const m = readJson(path.join(p.dir, `shots-${w.r}`, 'measures.json'), undefined);
        return { label, shown: sheetsOf(p, w.r).hero !== undefined, fatal: m?.fatal !== undefined, measured: m !== undefined, error: m && Object.values(m.errors ?? {})[0] };
      };
      const verdict = pairStep([facts(a, `${a.harness} ${a.n} ${w.r}`), facts(b, `${b.harness} ${b.n} ${w.r}`)]);
      if (verdict.step === 'judge') result = await judgePair(sheetsOf(a, w.r), sheetsOf(b, w.r), via);
      // A page with no index.html loses its pair rather than holding up the verdict.
      else if (verdict.step === 'forfeit') result = { winner: verdict.winner, totals: [0, 0], why: 'a page could not be shown: there is no index.html', forfeit: true };
      else {
        waiting.add(verdict.why);
        continue;
      }
    }
    judged[w.key] = { ...result, via };
    writeJson(JUDGED, judged);
    charge();
    console.log(`judge ${w.key}: ${result.winner ?? JSON.stringify(result).slice(0, 80)}`);
  }
  problems.push(...[...waiting].map((why) => `a judgement waits: ${why}`));
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
