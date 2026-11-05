// Runs each task on Claude Code (`claude -p`) and on Geno (`gcode agent`) with the same model, in a throwaway copy
// of the workspace and a fresh HOME, then scores the run: hidden check, hand-backs, self-check, turns, time, tokens.
// When a run ends by handing work back, the simulated user says "go on" (up to twice), as the real user did.
// usage: node scripts/harness-parity/run.mjs --round r0 --model claude-sonnet-5-5 [--task id]... [--harness claude|geno] [--parallel 3]
import { execFileSync } from 'node:child_process';
import { cpSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { converse, diffStat, transcriptOf, write, writeHome } from './harness.mjs';
import { RUNS_DIR } from './paths.mjs';
import { CHENGDU_CHECKPOINTS, TASKS } from './tasks.mjs';
import { render, selfVerified } from './transcript.mjs';

const { values } = parseArgs({ options: { round: { type: 'string' }, model: { type: 'string' }, task: { type: 'string', multiple: true }, harness: { type: 'string', multiple: true }, parallel: { type: 'string', default: '3' }, continues: { type: 'string', default: '2' } } });
if (!values.round || !values.model) throw new Error('--round and --model are required');
const RUNS = RUNS_DIR;

function prepare(task, job) {
  rmSync(job, { recursive: true, force: true });
  const home = path.join(job, 'home');
  const ws = path.join(home, 'Development', 'เฉิงตู');
  const base = path.join(job, 'base');
  mkdirSync(ws, { recursive: true });
  execFileSync('sh', ['-c', `git --git-dir="${CHENGDU_CHECKPOINTS}" archive ${task.sha} | tar -x -C "${ws}"`]);
  rmSync(path.join(ws, '.mcp.json'), { force: true });
  rmSync(path.join(ws, '.claude'), { recursive: true, force: true });
  for (const [rel, content] of Object.entries(task.extra ?? {})) {
    if (typeof content === 'string') write(path.join(ws, rel), content);
    else execFileSync('sh', ['-c', `git --git-dir="${CHENGDU_CHECKPOINTS}" archive ${content.fromSha} ${rel} | tar -x -C "${ws}"`]);
  }
  cpSync(ws, base, { recursive: true });
  writeHome(home, task.homeFiles);
  return { home, ws, base };
}

async function runJob(task, name, model) {
  const job = path.join(RUNS, values.round, `${task.id}.${name}.${model.replace('claude-', '')}`);
  const paths = { job, ...prepare(task, job) };
  const state = { session: undefined, texts: [] };
  const started = Date.now();
  const { ends, error } = await converse(name, paths, model, state, task.prompt, task.prompt, Number(values.continues));
  if (error) return { task: task.id, harness: name, model, error };
  const ms = Date.now() - started;
  const t = transcriptOf(name, paths, state);
  let check;
  try {
    check = await task.check({ ...paths });
  } catch (error) {
    check = { pass: false, detail: `check threw: ${error.message}` };
  }
  const diff = diffStat(paths.base, paths.ws);
  writeFileSync(path.join(job, 'transcript.md'), `# ${task.id} · ${name} · ${model}\n\n${render(t.steps)}\n\n## change summary\n${diff}\n`);
  const record = {
    task: task.id, set: task.set, harness: name, model, session: state.session, ms, modelCalls: t.modelCalls, costUsd: t.costUsd, usage: t.usage,
    handbacks: ends.filter((e) => e.kind !== 'done').length, ends, selfVerified: selfVerified(t.steps), toolCalls: t.steps.filter((s) => s.kind === 'tool').length, check, diff,
  };
  writeFileSync(path.join(job, 'record.json'), `${JSON.stringify(record, null, 2)}\n`);
  return record;
}

const tasks = values.task ? TASKS.filter((t) => values.task.includes(t.id)) : TASKS;
const names = values.harness ?? ['claude', 'geno'];
const queue = tasks.flatMap((task) => names.map((name) => [task, name]));
const results = [];
await Promise.all(
  Array.from({ length: Number(values.parallel) }, async () => {
    while (queue.length > 0) {
      const [task, name] = queue.shift();
      console.log(`>>> ${task.id} ${name}`);
      const r = await runJob(task, name, values.model).catch((error) => ({ task: task.id, harness: name, error: String(error.stack ?? error) }));
      results.push(r);
      console.log(`<<< ${task.id} ${name}: ${r.error ?? `${r.check.pass ? 'PASS' : `FAIL (${r.check.detail})`} handbacks=${r.handbacks} [${r.ends.map((e) => e.kind).join(',')}] verified=${r.selfVerified} calls=${r.modelCalls} $${r.costUsd.toFixed(2)} ${Math.round(r.ms / 1000)}s`}`);
    }
  }),
);
writeFileSync(path.join(RUNS, values.round, `results-${values.model.replace('claude-', '')}-${Date.now()}.json`), `${JSON.stringify(results, null, 2)}\n`);
