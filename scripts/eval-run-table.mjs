#!/usr/bin/env node
// Prints a Markdown table for each `gcode eval run` results.jsonl given, then its pass rate and totals.
// Usage: node scripts/eval-run-table.mjs <results.jsonl>...
import { readFileSync } from 'node:fs';

const seconds = (ms) => `${(ms / 1000).toFixed(0)}s`;
const usd = (n) => (n === null ? 'unknown' : `$${n.toFixed(4)}`);
const tokens = (u) => `${u.input} / ${u.cacheRead} / ${u.cacheWrite} / ${u.output}`;

for (const file of process.argv.slice(2)) {
  const rows = readFileSync(file, 'utf8').trim().split('\n').map((line) => JSON.parse(line));
  console.log(`\n${file}\n`);
  console.log('| Task | Pass | Stop | Turns | Tokens (in / cache read / cache write / out) | Cost | Agent wall time | Denials |');
  console.log('|---|---|---|---|---|---|---|---|');
  for (const r of rows) {
    const pass = r.pass ? 'yes' : r.outcome === 'fail' ? 'no' : r.outcome;
    console.log(`| ${r.taskId} | ${pass} | ${r.stop} | ${r.turns} | ${tokens(r.usage)} | ${usd(r.costUsd)} | ${seconds(r.agentMs)} | ${r.denials} |`);
  }
  const passed = rows.filter((r) => r.pass).length;
  const sum = (pick) => rows.reduce((n, r) => n + pick(r), 0);
  console.log('');
  console.log(`passed ${passed}/${rows.length} (${((passed / rows.length) * 100).toFixed(1)}%)`);
  console.log(
    `turns ${sum((r) => r.turns)}, tokens ${tokens({
      input: sum((r) => r.usage.input),
      cacheRead: sum((r) => r.usage.cacheRead),
      cacheWrite: sum((r) => r.usage.cacheWrite),
      output: sum((r) => r.usage.output),
    })}, cost ${usd(sum((r) => r.costUsd ?? 0))}, agent wall time ${seconds(sum((r) => r.agentMs))}, denials ${sum((r) => r.denials)}`,
  );
  const reported = rows.filter((r) => r.reportedCostUsd !== null && r.reportedCostUsd !== r.costUsd);
  if (reported.length > 0) console.log(`cost the agent itself reported: ${usd(sum((r) => r.reportedCostUsd ?? 0))}`);
}
