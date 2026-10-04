// Summarizes replay result files for docs/e9-e10-e11.md. Usage: node scripts/next-edit-summary.mjs docs/results/*.jsonl
import { readFileSync } from 'node:fs';
import path from 'node:path';

const percentile = (values, p) => {
  if (values.length === 0) return null;
  const sorted = values.toSorted((a, b) => a - b);
  const rank = (p / 100) * (sorted.length - 1);
  const low = Math.floor(rank);
  return sorted[low] + (sorted[Math.ceil(rank)] - sorted[low]) * (rank - low);
};
const round = (v) => (v === null ? '-' : Math.round(v));
const pair = (xs) => `${round(percentile(xs, 50))} / ${round(percentile(xs, 90))}`;
const known = (rows, key) => rows.map((r) => r[key]).filter((v) => v !== null);

console.log('| Run | Moments | exact | region | wrong-location | none | TTFT p50 / p90 ms | Total p50 / p90 ms | Prompt tokens p50 / p90 | Generated tokens p50 / p90 | Gen ms p50 / p90 | Estimate / real tokens |');
console.log('| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |');
for (const file of process.argv.slice(2)) {
  const rows = readFileSync(file, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  const grade = (g) => rows.filter((r) => r.grade === g).length;
  const ratio = rows.reduce((s, r) => s + r.promptTokensEstimate, 0) / rows.reduce((s, r) => s + (r.promptTokens ?? 0), 0);
  console.log(
    `| ${path.basename(file, '.jsonl')} | ${rows.length} | ${grade('exact')} | ${grade('region')} | ${grade('wrong-location')} | ${grade('none')} | ` +
      `${pair(known(rows, 'ttftMs'))} | ${pair(known(rows, 'latencyMs'))} | ${pair(known(rows, 'promptTokens'))} | ` +
      `${pair(known(rows, 'generatedTokens'))} | ${pair(known(rows, 'generationMs'))} | ${ratio.toFixed(2)} |`,
  );
}
