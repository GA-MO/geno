#!/usr/bin/env node
// Prints the P24 A/B table from `gcode eval speed` runs: one row per run, then the mean per arm.
// Usage: node scripts/prompt-tier-ab.mjs <arm>=<results.jsonl> ...
// A tool failure is a call whose result was an error, a denial or a rejection. bash is counted apart, since a test
// command that exits non-zero before the fix is part of the work, not a failed call.
import { readFileSync } from 'node:fs';

const jsonl = (file) => readFileSync(file, 'utf8').trim().split('\n').filter(Boolean).map((line) => JSON.parse(line));

function toolStats(transcript) {
  if (transcript === '') return { calls: 0, failed: 0, bashFailed: 0, editFailed: 0 };
  const results = jsonl(transcript).filter((e) => e.kind === 'tool-result');
  const failed = results.filter((e) => e.status !== 'ok');
  return {
    calls: results.length,
    failed: failed.filter((e) => e.name !== 'bash').length,
    bashFailed: failed.filter((e) => e.name === 'bash').length,
    editFailed: failed.filter((e) => e.name === 'edit').length,
  };
}

function runRow(arm, file) {
  const rows = jsonl(file);
  const sum = (pick) => rows.reduce((n, r) => n + pick(r), 0);
  const tools = rows.map((r) => toolStats(r.transcript));
  const tsum = (pick) => tools.reduce((n, t) => n + pick(t), 0);
  return {
    arm,
    file,
    tasks: rows.length,
    passed: rows.filter((r) => r.pass).length,
    turns: sum((r) => r.turns),
    calls: tsum((t) => t.calls),
    failed: tsum((t) => t.failed),
    editFailed: tsum((t) => t.editFailed),
    bashFailed: tsum((t) => t.bashFailed),
    output: sum((r) => r.usage.output),
    cacheRead: sum((r) => r.usage.cacheRead),
    cost: sum((r) => r.costUsd ?? 0),
    perTask: rows.map((r, i) => `${r.taskId}:${r.pass ? 'pass' : 'fail'}/${r.turns}t/${tools[i].calls}c`),
  };
}

const runs = process.argv.slice(2).map((arg) => {
  const at = arg.indexOf('=');
  return runRow(arg.slice(0, at), arg.slice(at + 1));
});

const pct = (n, d) => (d === 0 ? '-' : `${((n / d) * 100).toFixed(1)}%`);
console.log('| Arm | Passed | Turns | Tool calls | Calls per task | Tool failures (not bash) | Edit failures | bash non-zero | Output tokens | Cache reads | Cost |');
console.log('|---|---|---|---|---|---|---|---|---|---|---|');
for (const r of runs) {
  console.log(
    `| ${r.arm} | ${r.passed}/${r.tasks} | ${r.turns} | ${r.calls} | ${(r.calls / r.tasks).toFixed(1)} | ${r.failed} (${pct(r.failed, r.calls)}) | ${r.editFailed} | ${r.bashFailed} | ${r.output.toLocaleString('en-US')} | ${r.cacheRead.toLocaleString('en-US')} | $${r.cost.toFixed(4)} |`,
  );
}
for (const arm of [...new Set(runs.map((r) => r.arm))]) {
  const of = runs.filter((r) => r.arm === arm);
  const mean = (pick) => of.reduce((n, r) => n + pick(r), 0) / of.length;
  const range = (pick) => `${Math.min(...of.map(pick))} to ${Math.max(...of.map(pick))}`;
  console.log(
    `\n${arm}: ${of.length} runs, passed ${of.reduce((n, r) => n + r.passed, 0)}/${of.reduce((n, r) => n + r.tasks, 0)}, mean calls ${mean((r) => r.calls).toFixed(1)} (${range((r) => r.calls)}), mean cost $${mean((r) => r.cost).toFixed(4)} (${range((r) => Number(r.cost.toFixed(4)))}), mean output ${mean((r) => r.output).toFixed(0)} (${range((r) => r.output)}), failures ${of.reduce((n, r) => n + r.failed, 0)}/${of.reduce((n, r) => n + r.calls, 0)}`,
  );
}
for (const r of runs) console.log(`\n${r.arm} ${r.file}\n  ${r.perTask.join('\n  ')}`);
