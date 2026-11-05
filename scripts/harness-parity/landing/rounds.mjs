// Compares two finished rounds side by side, per harness: what they cost, how they worked, the checks of their final
// pages and the judge's pairs, and how often each failure an engine fix targets shows up in the transcripts.
// usage: node scripts/harness-parity/landing/rounds.mjs --base l1 --next l2
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { REPO } from '../../real-usecases/env.mjs';
import { GO_ON, transcriptOf } from '../harness.mjs';
import { RUNS_DIR } from '../paths.mjs';
import { passed, score } from './checks.mjs';
import { roundsOf } from './logs.mjs';
import { pairVerdict } from './rules.mjs';
import { FEEDBACK, GO_ON_EN, PROMPT, TASK_ID } from './task.mjs';
import { voteDir } from './vote.mjs';

/** The failures the engine fixes aim at, counted in a run's steps. Each test reads one step. */
export const SIGNS = {
  'stale page': (s) => s.kind === 'tool' && /No page found/.test(s.output ?? ''),
  'deferred preamble': (s) => s.kind === 'tool' && /before loading it with tool_search/.test(s.output ?? ''),
  'array as JSON text': (s) => s.kind === 'tool' && /expected array, received string|expected object, received string/.test(s.output ?? ''),
  'GNU sed on macOS': (s) => s.kind === 'tool' && /command [a-z] expects \\ followed by text|invalid command code/.test(s.output ?? ''),
  'Thai reply': (s) => s.kind === 'text' && /[฀-๿]/.test(s.text ?? ''),
  'asks the user to check': (s) => s.kind === 'text' && /\b(please (check|try|move|test|verify)|try it yourself|you may want to (check|test)|yourself\b.*(check|move|try))/i.test(s.text ?? ''),
};

const readJson = (file) => (existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : undefined);

export function sideOf(round, harness) {
  const dir = path.join(RUNS_DIR, round);
  const runs = [1, 2, 3].map((n) => path.join(dir, `${TASK_ID}.${harness}.${n}`)).filter((j) => existsSync(path.join(j, 'record.json')));
  const total = { runs: runs.length, costUsd: 0, modelCalls: 0, toolErrors: 0, handbacks: 0, needless: 0, screenshots: 0, brief: 0, quality: 0, motion: 0, signs: Object.fromEntries(Object.keys(SIGNS).map((k) => [k, 0])) };
  for (const job of runs) {
    const record = readJson(path.join(job, 'record.json'));
    const rounds = roundsOf(job, harness);
    const m = readJson(path.join(job, 'shots-r2', 'measures.json'));
    const scores = m ? score(m) : score({ fatal: 'not measured' });
    total.costUsd += rounds.reduce((s, r) => s + r.costUsd, 0);
    total.modelCalls += record.rounds.reduce((s, r) => s + r.modelCalls, 0);
    total.toolErrors += rounds.reduce((s, r) => s + r.behaviour.toolErrors, 0);
    total.screenshots += rounds.reduce((s, r) => s + r.behaviour.screenshots, 0);
    const ends = record.rounds.flatMap((r) => r.ends ?? []);
    total.handbacks += ends.filter((e) => e.kind !== 'done').length;
    total.needless += ends.filter((e) => e.kind !== 'done' && e.necessary !== true).length;
    for (const g of ['brief', 'quality', 'motion']) total[g] += passed(scores, g);
    const session = harness === 'geno' ? /session: ([0-9a-f-]{36})/.exec(readFileSync(path.join(job, 'geno.out'), 'utf8'))?.[1] : undefined;
    const { steps } = transcriptOf(harness, { job, home: path.join(job, 'home') }, { session, texts: [PROMPT, FEEDBACK, GO_ON, GO_ON_EN] });
    for (const [k, test] of Object.entries(SIGNS)) total.signs[k] += steps.filter(test).length;
  }
  return total;
}

/** Pairs each side won in the final round, by the rubric fixed before the run and by the taste rubric. */
function judgeOf(round) {
  const tally = (judged) => {
    const out = { claude: 0, geno: 0, tie: 0 };
    for (const c of [1, 2, 3]) for (const g of [1, 2, 3]) {
      const ab = judged[`pair|r2|c${c}|g${g}|AB|1`];
      const ba = judged[`pair|r2|c${c}|g${g}|BA|1`];
      if (ab && ba) out[pairVerdict(ab, ba)] += 1;
    }
    return out;
  };
  return { v1: tally(readJson(path.join(RUNS_DIR, round, 'judge.json')) ?? {}), taste: tally(readJson(path.join(voteDir(round), 'judge-taste.json')) ?? {}) };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { values } = parseArgs({ options: { base: { type: 'string', default: 'l1' }, next: { type: 'string', default: 'l2' } } });
  for (const r of [values.base, values.next]) {
    if (!/^[a-z0-9][a-z0-9-]{0,39}$/.test(r) || !existsSync(path.join(RUNS_DIR, r))) {
      console.error(`no round "${r}" under ${RUNS_DIR}`);
      process.exit(2);
    }
  }
  const [b, n] = [values.base, values.next];
  const side = { geno: [sideOf(b, 'geno'), sideOf(n, 'geno')], claude: [sideOf(b, 'claude'), sideOf(n, 'claude')] };
  const judge = [judgeOf(b), judgeOf(n)];
  const money = (x) => `$${x.toFixed(2)}`;
  const rows = [
    ['API cost, both rounds', (s) => money(s.costUsd)],
    ['model calls', (s) => s.modelCalls],
    ['tool errors', (s) => s.toolErrors],
    ['hand-backs (needless)', (s) => `${s.handbacks} (${s.needless})`],
    ['screenshots it took', (s) => s.screenshots],
    ['ก brief checks (final)', (s) => `${s.brief}/33`],
    ['ข quality checks (final)', (s) => `${s.quality}/30`],
    ['ค motion checks (final)', (s) => `${s.motion}/27`],
  ];
  const table = (h) => [`| | ${b} | ${n} |`, '|---|---|---|', ...rows.map(([label, f]) => `| ${label} | ${f(side[h][0])} | ${f(side[h][1])} |`)];
  const signs = (h) => [`| in the transcripts | ${b} | ${n} |`, '|---|---|---|', ...Object.keys(SIGNS).map((k) => `| ${k} | ${side[h][0].signs[k]} | ${side[h][1].signs[k]} |`)];
  const pairs = (j) => `Claude Code ${j.claude}, Geno ${j.geno}, tie ${j.tie}`;
  const lines = [
    `# Landing bake-off: ${b} against ${n}`,
    '',
    `Three runs a side in each round, the same brief, feedback, model and checks. Between them the Geno engine changed (commit f663761b): a browser call to a page that is gone, a deferred tool's failed first call, arrays sent as JSON text, the macOS sed note, and two prompt lines on checking before ending and on screenshots. The simulated user's "go on" also changed from Thai to English for both harnesses. Claude Code did not change, so its two rounds show how much a side moves from run to run alone.`,
    '',
    '## Geno',
    '',
    ...table('geno'),
    '',
    ...signs('geno'),
    '',
    '## Claude Code, for the run-to-run spread',
    '',
    ...table('claude'),
    '',
    ...signs('claude'),
    '',
    '## Judge on the final pages',
    '',
    '| rubric | ' + b + ' | ' + n + ' |',
    '|---|---|---|',
    `| fixed before the run | ${pairs(judge[0].v1)} | ${pairs(judge[1].v1)} |`,
    `| taste (layout first) | ${pairs(judge[0].taste)} | ${pairs(judge[1].taste)} |`,
    '',
    `Counts are summed over the three runs of a side. "asks the user to check" is a pattern over the agent's text and misses rewordings. With three runs a side, a difference of one or two in a count is within what Claude Code's own two rounds show.`,
    '',
  ];
  const notes = path.join(REPO, 'docs/results', `landing-beancraft-${b}-vs-${n}.notes.md`);
  if (existsSync(notes)) lines.push(readFileSync(notes, 'utf8').trim(), '');
  const out = path.join(REPO, 'docs/results', `landing-beancraft-${b}-vs-${n}.md`);
  writeFileSync(out, `${lines.join('\n')}\n`);
  console.log(lines.join('\n'));
}
