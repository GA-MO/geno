// A sample is one run of every task on one harness: a comma-separated list of rounds, where a later round's job
// replaces an earlier one's, such as `r0,r2` when r2 reran only the deploy tasks.
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { RUNS_DIR } from './paths.mjs';

export const shortModel = (model) => model.replace('claude-', '');

/** The job directory of a task in a sample, or undefined when no round of it ran the task. */
export function jobOf(sample, task, harness, model) {
  const job = `${task}.${harness}.${shortModel(model)}`;
  return sample
    .split(',')
    .reverse()
    .map((round) => path.join(RUNS_DIR, round, job))
    .find((dir) => existsSync(path.join(dir, 'record.json')));
}

export const recordOf = (dir) => (dir === undefined ? undefined : JSON.parse(readFileSync(path.join(dir, 'record.json'), 'utf8')));

/** Where the blind verdicts of one pair of samples are kept. */
export const verdictFile = (model, claude, geno) => path.join(RUNS_DIR, 'judge', `${shortModel(model)}__claude-${claude}__geno-${geno}.json`);
