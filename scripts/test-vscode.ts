/**
 * `pnpm test:vscode [files...] [vitest options...]`: the `vscode` project, with one retry per failed file. A file that
 * fails and then passes is a flake: it is appended to the flake log (GCODE_FLAKE_LOG, by default
 * `gcode-vscode-flakes.jsonl` in the temp dir) and listed at the end, and the run still passes.
 *
 * The retry is per file, not vitest's per-test `retry`: a file's fake model keeps the requests of its first attempt
 * in module state, so a test retried inside the same module would replay against the wrong script.
 */
import { spawnSync } from 'node:child_process';
import { appendFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { useTestLock } from './test-lock.js';
import { flakesOf, failedFiles, type Report } from './flakes.js';

const args = process.argv.slice(2);
const files = args.filter((a) => a.endsWith('.test.ts'));
const options = args.filter((a) => !a.endsWith('.test.ts'));
const flakeLog = process.env['GCODE_FLAKE_LOG'] ?? path.join(tmpdir(), 'gcode-vscode-flakes.jsonl');
// Both attempts are one run as far as the machine's other test runs can tell.
useTestLock();

const attempt = (label: string, targets: readonly string[]): Report | undefined => {
  const report = path.join(process.env['GCODE_TEST_TMP_ROOT'] ?? tmpdir(), `vscode-${label}-${process.pid}.json`);
  const run = spawnSync('pnpm', ['vitest', 'run', '--project', 'vscode', '--reporter=default', '--reporter=json', `--outputFile.json=${report}`, ...options, ...targets], { stdio: 'inherit' });
  try {
    return JSON.parse(readFileSync(report, 'utf8')) as Report;
  } catch {
    console.error(`test:vscode: vitest wrote no report (exit ${run.status ?? run.signal})`);
    return undefined;
  }
};

const first = attempt('first', files);
if (first === undefined) process.exit(1);
const failed = failedFiles(first);
if (failed.length === 0) process.exit(0);

console.log(`\ntest:vscode: retrying ${failed.length} failed file(s) once: ${failed.map((f) => path.basename(f)).join(', ')}`);
const retry = attempt('retry', failed);
if (retry === undefined) process.exit(1);
const flakes = flakesOf(first, retry);
for (const flake of flakes) appendFileSync(flakeLog, `${JSON.stringify({ at: new Date().toISOString(), ...flake })}\n`);
const still = failedFiles(retry);
console.log('');
if (flakes.length > 0) {
  console.log(`test:vscode: ${flakes.length} flaky file(s), passed on retry (logged to ${flakeLog}):`);
  for (const f of flakes) console.log(`  ${path.basename(f.file)}: first failed with ${f.firstFailure}`);
}
if (still.length > 0) console.log(`test:vscode: failed twice: ${still.map((f) => path.basename(f)).join(', ')}`);
process.exit(still.length > 0 ? 1 : 0);
