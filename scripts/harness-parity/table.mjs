// The comparison table of a round: per task and model, each harness's hidden check, hand-backs, self-check, model
// calls, time, tokens and cost, and the blind judge's pick; then the pass criteria.
// usage: node scripts/harness-parity/table.mjs --round r0 [--model claude-sonnet-5-5]...
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { RUNS_DIR } from './paths.mjs';
import { TASKS } from './tasks.mjs';

const { values } = parseArgs({ options: { round: { type: 'string', multiple: true }, model: { type: 'string', multiple: true } } });
const models = values.model ?? ['claude-sonnet-5-5', 'claude-opus-5-5'];
const recordOf = (round, job) => {
  const f = path.join(RUNS_DIR, round, job, 'record.json');
  return existsSync(f) ? JSON.parse(readFileSync(f, 'utf8')) : undefined;
};
const tokens = (r) => (r.usage.input ?? 0) + (r.usage.cacheRead ?? 0) + (r.usage.cacheWrite ?? 0) + (r.usage.output ?? 0);
const cell = (r) => (r === undefined ? '-' : `${r.check.pass ? 'pass' : 'FAIL'} ${r.handbacks}hb ${r.selfVerified === true ? 'chk' : r.selfVerified === false ? 'nochk' : '·'} ${r.modelCalls}c ${Math.round(r.ms / 1000)}s ${Math.round(tokens(r) / 1000)}k $${r.costUsd.toFixed(2)}`);
for (const model of models) {
  const short = model.replace('claude-', '');
  // A later round's job replaces an earlier round's, so a round that reran only the lost tasks still gives a full table.
  const latest = (job) => [...values.round].reverse().map((round) => [round, recordOf(round, job)]).find(([, r]) => r !== undefined) ?? [];
  const judgeOf = (task) => [...values.round].reverse().map((round) => { const f = path.join(RUNS_DIR, round, `judge-${short}.json`); return existsSync(f) ? JSON.parse(readFileSync(f, 'utf8'))[task] : undefined; }).find(Boolean);
  console.log(`\n## ${model}\n\n| task | Claude Code | Geno | judge |\n|---|---|---|---|`);
  const sum = { claude: { pass: 0, hb: 0, n: 0 }, geno: { pass: 0, hb: 0, n: 0 }, judged: 0, genoScore: 0 };
  for (const task of TASKS) {
    const [, c] = latest(`${task.id}.claude.${short}`);
    const [round, g] = latest(`${task.id}.geno.${short}`);
    if (!c && !g) continue;
    const verdict = judgeOf(task.id);
    console.log(`| ${task.id} | ${cell(c)} | ${cell(g)} | ${verdict?.winner ?? '-'}${round ? ` (${round})` : ''} |`);
    for (const [name, r] of [['claude', c], ['geno', g]]) if (r) Object.assign(sum[name], { pass: sum[name].pass + (r.check.pass ? 1 : 0), hb: sum[name].hb + r.handbacks, n: sum[name].n + 1 });
    if (verdict) {
      sum.judged += 1;
      sum.genoScore += verdict.winner === 'geno' ? 1 : verdict.winner === 'tie' ? 0.5 : 0;
    }
  }
  const pass = sum.geno.pass >= sum.claude.pass && sum.geno.hb <= sum.claude.hb && sum.genoScore >= sum.judged / 2;
  console.log(`\nhidden checks: Claude Code ${sum.claude.pass}/${sum.claude.n}, Geno ${sum.geno.pass}/${sum.geno.n}. hand-backs: Claude Code ${sum.claude.hb}, Geno ${sum.geno.hb}. judge: Geno ${sum.genoScore}/${sum.judged} (ties count half). criteria ${pass ? 'MET' : 'NOT met'}.`);
}
