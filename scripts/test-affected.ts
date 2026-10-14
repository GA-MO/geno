/**
 * `pnpm test:affected [--base <ref>] [--quick] [--docker] [--dry]`: typecheck and the boundary lint, the unit tests
 * related to what changed since the merge base with main, the webview tests, and only the VS Code integration files
 * that change can break. `--quick` (`pnpm test:quick`) stops before VS Code: the loop while working takes a minute or
 * two, and the integration files run once, before a push.
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { MANIFESTS, readSuites, selectVscode } from './affected.js';
import { vscodeWorkers } from './vscode-workers.js';

const args = process.argv.slice(2);
const flag = (name: string) => args.includes(`--${name}`);
const base = args[args.indexOf('--base') + 1] && args.includes('--base') ? args[args.indexOf('--base') + 1]! : 'main';
const root = execFileSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8' }).trim();
const git = (...a: string[]) => execFileSync('git', a, { cwd: root, encoding: 'utf8' });

const mergeBase = git('merge-base', base, 'HEAD').trim();
const changed = [
  ...new Set([
    ...git('diff', '--name-only', mergeBase).split('\n'),
    ...git('ls-files', '--others', '--exclude-standard').split('\n'),
  ]),
].filter(Boolean);
const panelDiff = git('diff', mergeBase, '--', 'packages/extension/src', 'packages/extension/package.json');

const suites = readSuites(root);

const show = (ref: string, file: string) => {
  try {
    return git('show', `${ref}:${file}`);
  } catch {
    return '';
  }
};
const harmless = Object.entries(MANIFESTS)
  .filter(([file, test]) => changed.includes(file) && test(show(mergeBase, file), readFileSync(path.join(root, file), 'utf8')))
  .map(([file]) => file);
for (const file of harmless) console.log(`${file}: only a part no VS Code harness reads changed`);
const picks = selectVscode(changed, panelDiff, suites, { harmless });
console.log(`changed since ${base} (${mergeBase.slice(0, 7)}): ${changed.length} files`);
const windows = Math.min(picks.length, vscodeWorkers(process.env));
console.log(picks.length === 0 ? 'VS Code: nothing to run' : `VS Code: ${picks.length} of ${suites.length} files, in ${windows} pooled window${windows === 1 ? '' : 's'}`);
for (const p of picks) console.log(`  ${path.basename(p.file)}: ${p.reasons.join('; ')}`);
if (flag('dry')) process.exit(0);

const run = (cmd: string, cmdArgs: string[]) => {
  console.log(`\n$ ${cmd} ${cmdArgs.join(' ')}`);
  const result = spawnSync(cmd, cmdArgs, { cwd: root, stdio: 'inherit' });
  if (result.status !== 0) process.exit(result.status ?? 1);
};
run('pnpm', ['typecheck']);
run('pnpm', ['lint:deps']);
run('pnpm', ['vitest', 'run', '--project', 'unit', '--changed', mergeBase, '--passWithNoTests']);
// The webview files load the panel's bundles, which vitest's import graph does not see, and take seconds, so all run.
run('pnpm', ['vitest', 'run', '--project', 'webview']);
if (flag('quick')) {
  console.log(picks.length === 0 ? '\nquick: done' : `\nquick: done; ${picks.length} VS Code files left for \`pnpm test:affected\` before a push`);
  process.exit(0);
}
if (picks.length > 0) {
  run('pnpm', ['build']);
  const files = picks.map((p) => p.file);
  if (flag('docker')) run('pnpm', ['test:vscode:docker', ...files]);
  else run('pnpm', ['test:vscode', ...files]);
}
