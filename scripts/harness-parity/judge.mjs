// Blind pairwise judgement of each task's two transcripts, run in both orders; a verdict counts only when both
// orders agree, otherwise it is a tie. Results are kept per round and model, and a job judged before is not re-run.
// usage: node scripts/harness-parity/judge.mjs --round r0 --model claude-sonnet-5-5 [--task id]... [--force]
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { judgePair } from './llm.mjs';
import { RUNS_DIR } from './paths.mjs';
import { TASKS } from './tasks.mjs';

const { values } = parseArgs({ options: { round: { type: 'string' }, model: { type: 'string' }, task: { type: 'string', multiple: true }, force: { type: 'boolean' } } });
const short = values.model.replace('claude-', '');
const dir = path.join(RUNS_DIR, values.round);
const out = path.join(dir, `judge-${short}.json`);
const verdicts = existsSync(out) ? JSON.parse(readFileSync(out, 'utf8')) : {};
const body = (job) => readFileSync(path.join(dir, job, 'transcript.md'), 'utf8').split('\n').slice(1).join('\n').replace(/\/[^\s"'`]*\/home\/Development\//g, '~/Development/');
const jobs = new Set(readdirSync(dir));
for (const task of TASKS.filter((t) => !values.task || values.task.includes(t.id))) {
  await (async () => {
    const c = `${task.id}.claude.${short}`;
    const g = `${task.id}.geno.${short}`;
    if (!jobs.has(c) || !jobs.has(g) || !existsSync(path.join(dir, c, 'transcript.md')) || !existsSync(path.join(dir, g, 'transcript.md'))) return;
    if (verdicts[task.id] && !values.force) return;
    const [first, second] = await Promise.all([judgePair(task.prompt, body(c), body(g)), judgePair(task.prompt, body(g), body(c))]);
    const one = { A: 'claude', B: 'geno', tie: 'tie' }[first.winner];
    const two = { A: 'geno', B: 'claude', tie: 'tie' }[second.winner];
    verdicts[task.id] = { winner: one === two ? one : 'tie', orders: [one, two], why: [first.why, second.why] };
    console.log(`${task.id}: ${verdicts[task.id].winner} (${one}/${two})`);
    writeFileSync(out, `${JSON.stringify(verdicts, null, 2)}\n`);
  })();
}
