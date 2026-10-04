import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { makeRepo } from './git-fixture.js';
import { runCli } from './helpers.js';

const PATCH = `diff --git a/greet.txt b/greet.txt
--- a/greet.txt
+++ b/greet.txt
@@ -1 +1 @@
-hello
+goodbye
`;

const VERIFY = 'cp "$GCODE_TASK_DIR/check.sh" check.sh && sh check.sh';
// Scribbling on the file when it fails proves the reset step runs before the patch is applied.
const CHECK = 'test "$(cat greet.txt)" = goodbye || { echo scratch > greet.txt; exit 1; }\n';

type TaskFixture = {
  readonly id: string;
  readonly verify: string;
  readonly files: Readonly<Record<string, string>>;
};

async function setUp(tasks: readonly TaskFixture[]) {
  const repo = makeRepo('greeter', [
    { message: 'Add the greeting file', files: { 'greet.txt': 'hello\n' } },
  ]);
  const baseCommit = execFileSync('git', ['-C', repo, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
  const home = await mkdtemp(path.join(tmpdir(), 'gcode-home-'));
  const tasksDir = path.join(home, 'evals', 'tasks');
  for (const task of tasks) {
    await mkdir(path.join(tasksDir, task.id), { recursive: true });
    const json = { id: task.id, repo, baseCommit, prompt: 'Say goodbye instead', setup: 'true', verify: task.verify };
    await writeFile(path.join(tasksDir, `${task.id}.json`), JSON.stringify(json));
    for (const [name, text] of Object.entries(task.files)) {
      await writeFile(path.join(tasksDir, task.id, name), text);
    }
  }
  const env = { GCODE_HOME: home, PATH: process.env['PATH'] ?? '/usr/bin:/bin' };
  return { repo, env };
}

const VALID: TaskFixture = { id: 'valid', verify: VERIFY, files: { 'check.sh': CHECK, 'reference.patch': PATCH } };
const PASSES_AT_BASE: TaskFixture = {
  id: 'passes-at-base',
  verify: 'test -f greet.txt',
  files: { 'reference.patch': PATCH },
};
const NO_PATCH: TaskFixture = { id: 'no-patch', verify: VERIFY, files: { 'check.sh': CHECK } };

const clonePath = (stdout: string) => /^clone: (.+)$/m.exec(stdout)?.[1];

describe('gcode eval check-task', () => {
  it('accepts a task whose verify fails at base and passes after the reference patch', async () => {
    const { repo, env } = await setUp([VALID]);
    const result = await runCli(['eval', 'check-task', 'valid'], env);
    expect(result.stderr).toBe('');
    expect(result.code).toBe(0);
    for (const step of ['patch', 'clone', 'setup', 'verify-base', 'reset', 'apply', 'verify-patched']) {
      expect(result.stdout).toMatch(new RegExp(`^  ${step} +ok  \\d+\\.\\d\\ds$`, 'm'));
    }
    expect(result.stdout.trimEnd().endsWith('\nvalid')).toBe(true);
    expect(existsSync(clonePath(result.stdout)!)).toBe(false);
    expect(readFileSync(path.join(repo, 'greet.txt'), 'utf8')).toBe('hello\n');
  });

  it('rejects a task whose verify already passes at base', async () => {
    const { env } = await setUp([PASSES_AT_BASE]);
    const result = await runCli(['eval', 'check-task', 'passes-at-base'], env);
    expect(result.code).toBe(1);
    expect(result.stdout).toMatch(/^  verify-base +invalid/m);
    expect(result.stdout).not.toContain('verify-patched');
    expect(result.stdout).toContain('invalid: verify passes before any change');
  });

  it('rejects a task with no reference patch before cloning', async () => {
    const { env } = await setUp([NO_PATCH]);
    const result = await runCli(['eval', 'check-task', 'no-patch'], env);
    expect(result.code).toBe(1);
    expect(result.stdout).toMatch(/^  patch +invalid/m);
    expect(result.stdout).toMatch(/invalid: no reference patch at .*no-patch\/reference\.patch$/m);
  });

  it('keeps the clone with --keep, with the reference patch applied', async () => {
    const { env } = await setUp([VALID]);
    const result = await runCli(['eval', 'check-task', 'valid', '--keep'], env);
    expect(result.code).toBe(0);
    const clone = clonePath(result.stdout)!;
    expect(result.stdout).toContain(`kept clone: ${clone}`);
    expect(readFileSync(path.join(clone, 'greet.txt'), 'utf8')).toBe('goodbye\n');
  });

  it('checks every task with --all and prints a summary', async () => {
    const { env } = await setUp([VALID, PASSES_AT_BASE, NO_PATCH]);
    const result = await runCli(['eval', 'check-task', '--all'], env);
    expect(result.code).toBe(1);
    expect(result.stdout).toMatch(/^no-patch +\d+\.\d\ds  invalid: no reference patch at /m);
    expect(result.stdout).toMatch(/^passes-at-base +\d+\.\d\ds  invalid: verify passes before any change/m);
    expect(result.stdout).toMatch(/^valid +\d+\.\d\ds  valid$/m);
    expect(result.stdout).toContain('1/3 tasks valid');
  });

  it('exits 1 for an unknown task and 2 for an id together with --all', async () => {
    const { env } = await setUp([]);
    const missing = await runCli(['eval', 'check-task', 'nope'], env);
    expect(missing.code).toBe(1);
    expect(missing.stderr).toContain('no task nope');
    expect((await runCli(['eval', 'check-task', 'valid', '--all'], env)).code).toBe(2);
  });
});
