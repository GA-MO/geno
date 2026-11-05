// The suite's options and its win rule, kept pure so the tests can hold them to what the results doc says.
import { parseArgs } from 'node:util';

export const HARNESSES = ['claude', 'geno'];
/** Two thirds of the judged pairs: 6 of the 9 that three runs a side make. */
export const minJudgeWins = (pairs) => Math.ceil((pairs * 2) / 3);

const DEFAULTS = { round: 'l1', runs: '3', model: 'claude-sonnet-5-5', budget: '15', parallel: '3', judge: 'api', stability: '9' };
const RUNNERS = ['claude-sonnet-5-5'];

/** The command line, checked: every bad value is refused with the fix, never coerced. */
export function parseOptions(argv) {
  const { values } = parseArgs({
    args: argv,
    options: { round: { type: 'string' }, runs: { type: 'string' }, model: { type: 'string' }, budget: { type: 'string' }, parallel: { type: 'string' }, judge: { type: 'string' }, stability: { type: 'string' }, only: { type: 'string' }, help: { type: 'boolean' } },
    strict: true,
  });
  const v = { ...DEFAULTS, ...values };
  const int = (name, lo, hi) => {
    const n = Number(v[name]);
    if (!/^\d+$/.test(v[name]) || n < lo || n > hi) throw new Error(`--${name} must be a whole number from ${lo} to ${hi}, got "${v[name]}"`);
    return n;
  };
  if (!/^[a-z0-9][a-z0-9-]{0,39}$/.test(v.round)) throw new Error(`--round must be lowercase letters, digits and dashes (it names a folder), got "${v.round}"`);
  if (!RUNNERS.includes(v.model)) throw new Error(`--model must be one of ${RUNNERS.join(', ')} (Opus judges, it does not run the task), got "${v.model}"`);
  const budget = Number(v.budget);
  if (!/^\d+(\.\d+)?$/.test(v.budget) || budget <= 0 || budget > 100) throw new Error(`--budget is US dollars of API credit, more than 0 and at most 100, got "${v.budget}"`);
  if (!['api', 'cli'].includes(v.judge)) throw new Error(`--judge must be api or cli, got "${v.judge}"`);
  const stages = ['calibrate', 'run', 'measure', 'judge', 'report'];
  if (v.only !== undefined && !stages.includes(v.only)) throw new Error(`--only must be one of ${stages.join(', ')}, got "${v.only}"`);
  return { round: v.round, runs: int('runs', 1, 5), model: v.model, budget, parallel: int('parallel', 1, 6), judge: v.judge, stability: int('stability', 0, 25), only: v.only, help: v.help === true };
}

/** A pair's verdict: a side wins only when both orders pick it; a split or a tie in either order is a tie. */
export function pairVerdict(first, second) {
  const one = { A: 'claude', B: 'geno', tie: 'tie' }[first.winner];
  const two = { A: 'geno', B: 'claude', tie: 'tie' }[second.winner];
  return one === two ? one : 'tie';
}

/**
 * The win rule, fixed before the run: a side wins when it passes at least as many brief checks (ก), quality checks
 * (ข) and motion checks (ค) as the other, and wins at least two thirds of the judged pairs of final pages (6 of 9).
 * Otherwise it is a tie, and the cheaper side is named.
 */
export function decide(sides, pairs) {
  const fits = (x, y) => sides[x].brief >= sides[y].brief && sides[x].quality >= sides[y].quality && sides[x].motion >= sides[y].motion && sides[x].judgeWins >= minJudgeWins(pairs);
  const winner = fits('claude', 'geno') ? 'claude' : fits('geno', 'claude') ? 'geno' : 'tie';
  const cheaper = sides.claude.costUsd < sides.geno.costUsd ? 'claude' : sides.geno.costUsd < sides.claude.costUsd ? 'geno' : 'same';
  return { winner, cheaper };
}
