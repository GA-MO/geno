// Prints the Markdown summary tables for ISSUES.md from scores.json, the Layer B report and the cost ledger.
// usage: node scripts/real-usecases/summary.mjs
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { SHARED } from './checks.mjs';
import { SCRATCH } from './env.mjs';

const scores = JSON.parse(readFileSync(path.join(SCRATCH, 'scores.json'), 'utf8'));
const shared = new Set(SHARED.map((c) => c.id));
const verdict = (checks) => (checks.every((c) => c.pass !== false) ? 'pass' : 'fail');
const own = (s) => s.checks.filter((c) => !shared.has(c.id));
const harness = (s) => s.checks.filter((c) => shared.has(c.id));

console.log('| Area | Runs | Task checks pass | Harness checks pass |');
console.log('|---|---|---|---|');
const areas = [...new Set(scores.map((s) => s.area))];
for (const area of areas) {
  const runs = scores.filter((s) => s.area === area);
  console.log(`| ${area} | ${runs.length} | ${runs.filter((s) => verdict(own(s)) === 'pass').length} | ${runs.filter((s) => verdict(harness(s)) === 'pass').length} |`);
}
console.log(`| all Layer A | ${scores.length} | ${scores.filter((s) => verdict(own(s)) === 'pass').length} | ${scores.filter((s) => verdict(harness(s)) === 'pass').length} |`);

console.log('\n| Case | Run | Session | Cost | Task checks | Harness checks failed |');
console.log('|---|---|---|---|---|---|');
for (const s of scores) {
  const failedOwn = own(s).filter((c) => c.pass === false).map((c) => c.id);
  const failedShared = harness(s).filter((c) => c.pass === false).map((c) => c.id);
  console.log(`| ${s.case} | ${s.run} | \`${s.session.slice(0, 8)}\` | $${(s.costUsd + (s.case === 'A09-auto-classifier' && s.run === 1 ? s.classifierUsd : 0)).toFixed(4)} | ${failedOwn.length === 0 ? 'pass' : `fail: ${failedOwn.join(', ')}`} | ${failedShared.join(', ') || 'none'} |`);
}

console.log('\nShared check failures across Layer A runs:');
for (const id of shared) console.log(`- ${id}: ${scores.filter((s) => s.checks.some((c) => c.id === id && c.pass === false)).length} of ${scores.length}`);

const ledger = readFileSync(path.join(SCRATCH, 'ledger.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
const byLayer = {};
for (const e of ledger) byLayer[e.layer] = (byLayer[e.layer] ?? 0) + e.costUsd;
const classifierMissing = scores.find((s) => s.case === 'A09-auto-classifier' && s.run === 1)?.classifierUsd ?? 0;
console.log(`\nLedger by layer: ${Object.entries(byLayer).map(([k, v]) => `${k} $${v.toFixed(4)}`).join(', ')}; A09 r1 classifier not in the ledger: $${classifierMissing.toFixed(4)}`);
console.log(`Total: $${(ledger.reduce((s, e) => s + e.costUsd, 0) + classifierMissing).toFixed(4)}`);

const b = path.join(SCRATCH, 'layer-b.jsonl');
if (existsSync(b)) {
  console.log('\n| UI step | Run | Result | Detail |');
  console.log('|---|---|---|---|');
  for (const line of readFileSync(b, 'utf8').trim().split('\n').map((l) => JSON.parse(l))) {
    if (line.step === 'cost') continue;
    console.log(`| ${line.step} | ${line.run ?? '1'} | ${line.ok === true ? 'pass' : line.ok === false ? 'fail' : 'n/a'} | ${String(line.detail).replace(/\|/g, '\\|').slice(0, 220)} |`);
  }
}
