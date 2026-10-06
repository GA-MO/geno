/**
 * `pnpm test:affected [--base <ref>] [--docker] [--dry]`: typecheck and the boundary lint, the unit tests related to
 * what changed since the merge base with main, and only the VS Code integration files that change can break.
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { selectVscode, suiteFilesOf, type Suite } from './affected.js';

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
const panelDiff = git('diff', mergeBase, '--', 'packages/extension/src');

const testDir = path.join(root, 'packages/extension/test');
const suiteNames = readdirSync(path.join(testDir, 'suite')).filter((f) => f.endsWith('.ts')).map((f) => f.slice(0, -3));
const suites: Suite[] = readdirSync(testDir)
  .filter((f) => f.endsWith('.integration.test.ts'))
  .map((f) => {
    const own = `packages/extension/test/${f}`;
    const text = readFileSync(path.join(root, own), 'utf8');
    const files = [own, ...suiteFilesOf(text, suiteNames)];
    return { name: f.replace('.integration.test.ts', ''), files, text: files.map((p) => readFileSync(path.join(root, p), 'utf8')).join('\n') };
  });

const picks = selectVscode(changed, panelDiff, suites);
console.log(`changed since ${base} (${mergeBase.slice(0, 7)}): ${changed.length} files`);
console.log(picks.length === 0 ? 'VS Code: nothing to run' : `VS Code: ${picks.length} of ${suites.length} files`);
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
if (picks.length > 0) {
  run('pnpm', ['build']);
  const files = picks.map((p) => p.file);
  if (flag('docker')) run('pnpm', ['test:vscode:docker', ...files]);
  else run('pnpm', ['vitest', 'run', '--project', 'vscode', ...files]);
}
