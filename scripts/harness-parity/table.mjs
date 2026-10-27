// The comparison table: per task, each harness's hidden check, hand-backs (needless/all), self-check, model calls,
// time, tokens and cost, and the blind judge's pick, for one or more samples of each harness paired in order; then
// the totals over every sample and the pass criteria.
// usage: node scripts/harness-parity/table.mjs --model claude-sonnet-5-5 --claude r0,r2 --claude r0b --geno r3 --geno r3b
import { existsSync, readFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { jobOf, recordOf, verdictFile } from './samples.mjs';
import { TASKS } from './tasks.mjs';

const { values } = parseArgs({ options: { model: { type: 'string' }, claude: { type: 'string', multiple: true }, geno: { type: 'string', multiple: true } } });
const pairs = values.claude.map((claude, i) => [claude, values.geno[i] ?? values.geno.at(-1)]);
const needless = (r) => r.ends.filter((e) => e.kind !== 'done' && e.necessary !== true).length;
const tokens = (r) => (r.usage.input ?? 0) + (r.usage.cacheRead ?? 0) + (r.usage.cacheWrite ?? 0) + (r.usage.output ?? 0);
const cell = (r) => (r === undefined ? '-' : `${r.check.pass ? 'pass' : 'FAIL'} ${needless(r)}/${r.handbacks}hb ${r.selfVerified === true ? 'chk' : r.selfVerified === false ? 'nochk' : '·'} ${r.modelCalls}c ${Math.round(r.ms / 1000)}s ${Math.round(tokens(r) / 1000)}k $${r.costUsd.toFixed(2)}`);
const sum = { claude: { pass: 0, hb: 0, needless: 0, n: 0, chk: 0 }, geno: { pass: 0, hb: 0, needless: 0, n: 0, chk: 0 }, judged: 0, genoScore: 0 };
console.log(`## ${values.model}\n`);
for (const [claude, geno] of pairs) {
  const verdicts = existsSync(verdictFile(values.model, claude, geno)) ? JSON.parse(readFileSync(verdictFile(values.model, claude, geno), 'utf8')) : {};
  console.log(`### Claude Code ${claude} vs Geno ${geno}\n\n| task | Claude Code | Geno | judge |\n|---|---|---|---|`);
  for (const task of TASKS) {
    const c = recordOf(jobOf(claude, task.id, 'claude', values.model));
    const g = recordOf(jobOf(geno, task.id, 'geno', values.model));
    if (!c || !g) continue;
    const verdict = verdicts[task.id];
    console.log(`| ${task.id} | ${cell(c)} | ${cell(g)} | ${verdict?.winner ?? '-'} |`);
    for (const [name, r] of [['claude', c], ['geno', g]]) {
      const s = sum[name];
      Object.assign(s, { pass: s.pass + (r.check.pass ? 1 : 0), hb: s.hb + r.handbacks, needless: s.needless + needless(r), n: s.n + 1, chk: s.chk + (r.selfVerified === true ? 1 : 0) });
    }
    if (verdict) {
      sum.judged += 1;
      sum.genoScore += verdict.winner === 'geno' ? 1 : verdict.winner === 'tie' ? 0.5 : 0;
    }
  }
  console.log('');
}
// A hand-back counts against the harness when the work could have gone on: a question no default settles does not.
const pass = sum.geno.pass >= sum.claude.pass && sum.geno.needless <= sum.claude.needless && sum.genoScore >= sum.judged / 2;
console.log(`Over ${pairs.length} pair(s): hidden checks Claude Code ${sum.claude.pass}/${sum.claude.n}, Geno ${sum.geno.pass}/${sum.geno.n}. Needless hand-backs (of all): Claude Code ${sum.claude.needless} (${sum.claude.hb}), Geno ${sum.geno.needless} (${sum.geno.hb}). Checked its own result: Claude Code ${sum.claude.chk}, Geno ${sum.geno.chk}. Judge: Geno ${sum.genoScore}/${sum.judged} (ties count half). Criteria ${pass ? 'MET' : 'NOT met'}.`);
