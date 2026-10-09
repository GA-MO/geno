// Scores every kept run again from its saved log and workspace, after a check changes, without calling the model.
// Writes scratchpad/real-usecases/scores.json: one entry per case and run, with each check's verdict.
// usage: node scripts/real-usecases/rescore.mjs
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { CASES } from './cases.mjs';
import { analyze, checksFor } from './checks.mjs';
import { HOME, SCRATCH } from './env.mjs';

const results = readFileSync(path.join(SCRATCH, 'results.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
const scores = [];
for (const result of results) {
  const spec = CASES.find((c) => c.id === result.case);
  const log = path.join(SCRATCH, 'logs', `${result.case}-r${result.run}.jsonl`);
  const ws = path.join(SCRATCH, 'ws', `${result.case}-r${result.run}`, 'repo');
  if (spec === undefined || !existsSync(log)) continue;
  const events = readFileSync(log, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  const run = analyze(events);
  const ctx = { ws, home: HOME, scratchpad: events[0]?.environment?.scratchpad, gitStatus: execFileSync('git', ['status', '--porcelain'], { cwd: ws, encoding: 'utf8' }) };
  const checks = checksFor(spec).map((check) => {
    if (check.verify !== undefined) {
      const r = spawnSync('sh', ['-c', check.verify], { cwd: ws, encoding: 'utf8', timeout: 120_000 });
      return { id: check.id, pass: r.status === (check.expectExit ?? 0), detail: r.status === 0 ? '' : `${r.stdout}${r.stderr}`.trim().split('\n').slice(-3).join(' / ').slice(0, 240) };
    }
    try {
      return { id: check.id, ...check.test(run, ctx) };
    } catch (error) {
      return { id: check.id, pass: false, detail: `check threw: ${error.message}` };
    }
  });
  const classifierUsd = events.reduce((sum, e) => sum + (e.kind === 'tool-result' ? (e.approval?.classifier?.costUsd ?? 0) : 0), 0);
  scores.push({ case: result.case, area: result.area, run: result.run, session: result.session, costUsd: result.costUsd, classifierUsd, modelCalls: result.modelCalls, toolCalls: result.toolCalls, errors: result.errors, checks });
}
writeFileSync(path.join(SCRATCH, 'scores.json'), JSON.stringify(scores, null, 2));
for (const s of scores) {
  const failed = s.checks.filter((c) => c.pass === false);
  console.log(`${failed.length === 0 ? 'PASS' : 'FAIL'} ${s.case} r${s.run} $${s.costUsd.toFixed(4)}${failed.length ? `  failed: ${failed.map((c) => c.id).join(', ')}` : ''}`);
}
