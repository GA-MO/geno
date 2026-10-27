// Blind pairwise judgement of each task's two transcripts, one sample of each harness, run in both orders; a verdict
// counts only when both orders agree, otherwise it is a tie. A task judged before for the same pair is not re-run.
// usage: node scripts/harness-parity/judge.mjs --model claude-sonnet-5-5 --claude r0,r2 --geno r3 [--task id]... [--force]
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { judgePair } from './llm.mjs';
import { jobOf, verdictFile } from './samples.mjs';
import { TASKS } from './tasks.mjs';

const { values } = parseArgs({ options: { model: { type: 'string' }, claude: { type: 'string' }, geno: { type: 'string' }, task: { type: 'string', multiple: true }, force: { type: 'boolean' } } });
const out = verdictFile(values.model, values.claude, values.geno);
mkdirSync(path.dirname(out), { recursive: true });
const verdicts = existsSync(out) ? JSON.parse(readFileSync(out, 'utf8')) : {};
const body = (dir) => readFileSync(path.join(dir, 'transcript.md'), 'utf8').split('\n').slice(1).join('\n').replace(/\/[^\s"'`]*\/home\/Development\//g, '~/Development/');
for (const task of TASKS.filter((t) => !values.task || values.task.includes(t.id))) {
  const c = jobOf(values.claude, task.id, 'claude', values.model);
  const g = jobOf(values.geno, task.id, 'geno', values.model);
  if (c === undefined || g === undefined || (verdicts[task.id] && !values.force)) continue;
  const [first, second] = await Promise.all([judgePair(task.prompt, body(c), body(g)), judgePair(task.prompt, body(g), body(c))]);
  const one = { A: 'claude', B: 'geno', tie: 'tie' }[first.winner];
  const two = { A: 'geno', B: 'claude', tie: 'tie' }[second.winner];
  verdicts[task.id] = { winner: one === two ? one : 'tie', orders: [one, two], why: [first.why, second.why] };
  console.log(`${task.id}: ${verdicts[task.id].winner} (${one}/${two})`);
  writeFileSync(out, `${JSON.stringify(verdicts, null, 2)}\n`);
}
