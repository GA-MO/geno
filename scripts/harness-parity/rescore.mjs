// Re-runs the hidden checks of a round's finished jobs, after a check changed, and updates each record.
// usage: node scripts/harness-parity/rescore.mjs --round r0 [--task id]...
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { RUNS_DIR } from './paths.mjs';
import { TASKS } from './tasks.mjs';

const { values } = parseArgs({ options: { round: { type: 'string' }, task: { type: 'string', multiple: true } } });
const dir = path.join(RUNS_DIR, values.round);
for (const job of readdirSync(dir)) {
  const file = path.join(dir, job, 'record.json');
  if (!existsSync(file)) continue;
  const record = JSON.parse(readFileSync(file, 'utf8'));
  const task = TASKS.find((t) => t.id === record.task);
  if (!task || (values.task && !values.task.includes(task.id))) continue;
  const home = path.join(dir, job, 'home');
  const check = await Promise.resolve().then(() => task.check({ job: path.join(dir, job), home, ws: path.join(home, 'Development', 'เฉิงตู'), base: path.join(dir, job, 'base') })).catch((e) => ({ pass: false, detail: `check threw: ${e.message}` }));
  if (check.pass !== record.check.pass) console.log(`${job}: ${record.check.pass} -> ${check.pass} ${check.detail}`);
  writeFileSync(file, `${JSON.stringify({ ...record, check }, null, 2)}\n`);
}
