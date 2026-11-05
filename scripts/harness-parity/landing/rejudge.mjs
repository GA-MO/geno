// Judges the final pages of a finished round again with another rubric, from the screenshots already taken: no
// agent runs. Keeps the verdicts apart from the round's judge.json, next to the owner's votes, and says how each
// rubric agrees with the owner and how many of the 9 pairs changed.
// usage: node scripts/harness-parity/landing/rejudge.mjs [--round l1] [--rubric taste] [--budget 3]
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { spend } from '../llm.mjs';
import { RUNS_DIR } from '../paths.mjs';
import { judgePair, RUBRICS } from './judge.mjs';
import { pairVerdict } from './rules.mjs';
import { TASK_ID } from './task.mjs';
import { voteDir } from './vote.mjs';

/** What one judging of the pairs is worth to the owner: agreement with their votes, and the pairs it decides apart from another. */
export function calibration(base, next, ownerRows, pairs) {
  const verdict = (judged, [c, g]) => {
    const ab = judged[`pair|r2|c${c}|g${g}|AB|1`];
    const ba = judged[`pair|r2|c${c}|g${g}|BA|1`];
    return ab && ba ? pairVerdict(ab, ba) : undefined;
  };
  const agree = (judged) => ownerRows.filter((r) => verdict(judged, [r.n, r.n]) === r.owner).length;
  const changed = pairs.filter((p) => verdict(base, p) !== undefined && verdict(next, p) !== undefined && verdict(base, p) !== verdict(next, p));
  const tally = (judged) => Object.fromEntries(['claude', 'geno', 'tie'].map((h) => [h, pairs.filter((p) => verdict(judged, p) === h).length]));
  const missed = ownerRows.filter((r) => verdict(next, [r.n, r.n]) !== r.owner).map((r) => ({ pair: r.pair, owner: r.owner, judge: verdict(next, [r.n, r.n]) ?? 'not judged' }));
  return { owner: { base: agree(base), next: agree(next), of: ownerRows.length }, missed, changed: changed.map(([c, g]) => `C${c}-G${g}: ${verdict(base, [c, g])} → ${verdict(next, [c, g])}`), tally: { base: tally(base), next: tally(next) }, judged: pairs.filter((p) => verdict(next, p) !== undefined).length };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { values } = parseArgs({ options: { round: { type: 'string', default: 'l1' }, rubric: { type: 'string', default: 'taste' }, budget: { type: 'string', default: '3' } } });
  const fail = (message) => {
    console.error(message);
    process.exit(2);
  };
  if (!/^[a-z0-9][a-z0-9-]{0,39}$/.test(values.round)) fail(`--round must be lowercase letters, digits and dashes, got "${values.round}"`);
  if (!Object.hasOwn(RUBRICS, values.rubric) || values.rubric === 'v1') fail(`--rubric must be one of ${Object.keys(RUBRICS).filter((r) => r !== 'v1').join(', ')} (v1 is the round's own judge.json), got "${values.rubric}"`);
  const budget = Number(values.budget);
  if (!/^\d+(\.\d+)?$/.test(values.budget) || budget <= 0 || budget > 10) fail(`--budget is US dollars of API credit, more than 0 and at most 10, got "${values.budget}"`);
  const round = path.join(RUNS_DIR, values.round);
  const baseFile = path.join(round, 'judge.json');
  if (!existsSync(baseFile)) fail(`round ${values.round} has no judge.json at ${baseFile}`);
  const base = JSON.parse(readFileSync(baseFile, 'utf8'));
  const out = path.join(voteDir(values.round), `judge-${values.rubric}.json`);
  const judged = existsSync(out) ? JSON.parse(readFileSync(out, 'utf8')) : {};
  const sheets = (h, n) => {
    const file = path.join(round, `${TASK_ID}.${h}.${n}`, 'shots-r2', 'sheets.json');
    return existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : {};
  };
  const runs = [...new Set(Object.keys(base).map((k) => /^pair\|r2\|c(\d+)\|g(\d+)\|/.exec(k)).filter(Boolean).flatMap((m) => [Number(m[1])]))].sort();
  const pairs = runs.flatMap((c) => runs.map((g) => [c, g]));
  // Each call costs about $0.07 (measured on the first judging); stop before one could pass the budget.
  const PER_CALL = 0.1;
  for (const [c, g] of pairs) {
    for (const order of ['AB', 'BA']) {
      const key = `pair|r2|c${c}|g${g}|${order}|1`;
      if (judged[key]) continue;
      if (spend.usd + PER_CALL > budget) fail(`stopped at $${spend.usd.toFixed(2)}: the next call could pass the $${budget} budget; rerun to go on, the verdicts so far are kept`);
      const [a, b] = order === 'AB' ? [sheets('claude', c), sheets('geno', g)] : [sheets('geno', g), sheets('claude', c)];
      if (!a.hero || !b.hero) fail(`C${c} or G${g} has no screenshots of its final page`);
      judged[key] = { ...(await judgePair(a, b, 'api', RUBRICS[values.rubric])), via: 'api', rubric: values.rubric };
      writeFileSync(out, `${JSON.stringify(judged, null, 2)}\n`);
      console.log(`${key}: ${judged[key].winner} (${judged[key].totals.join('/')}) $${spend.usd.toFixed(2)}`);
    }
  }
  const ownerFile = path.join(voteDir(values.round), 'owner-votes.json');
  const key = JSON.parse(readFileSync(path.join(voteDir(values.round), 'vote-key.json'), 'utf8'));
  const ownerRows = existsSync(ownerFile) ? JSON.parse(readFileSync(ownerFile, 'utf8')).rows.map((r) => ({ ...r, n: key.pairs.find((p) => p.pair === r.pair).n })) : [];
  const result = calibration(base, judged, ownerRows, pairs);
  writeFileSync(path.join(voteDir(values.round), `calibration-${values.rubric}.json`), `${JSON.stringify({ rubric: values.rubric, spentUsd: Math.round(spend.usd * 100) / 100, ...result }, null, 2)}\n`);
  console.log(JSON.stringify(result, null, 2), `\nspent $${spend.usd.toFixed(2)} this time`);
}
