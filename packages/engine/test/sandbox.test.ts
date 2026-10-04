import { mkdir, mkdtemp, readFile, realpath, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { childEnv } from '../src/child-env.js';
import { openSandbox, sandboxPolicy, type Sandbox } from '../src/sandbox.js';
import { openStore } from '../src/store.js';
import { makeRepo } from './git-fixture.js';

let root: string;
let workspace: string;
let outside: string;
let sourceRepo: string;
let sandbox: Sandbox;

beforeAll(async () => {
  root = await realpath(await mkdtemp(path.join(tmpdir(), 'gcode-sandbox-')));
  workspace = path.join(root, 'ws');
  outside = path.join(root, 'outside');
  await mkdir(workspace);
  await mkdir(outside);
  sourceRepo = makeRepo('source', [{ message: 'Add the answer', files: { 'answer.txt': 'the hidden answer\n' } }]);
  const home = path.join(root, 'home');
  const store = openStore({ GCODE_HOME: home });
  await mkdir(store.tasksDir, { recursive: true });
  await writeFile(
    path.join(store.tasksDir, 'task.json'),
    JSON.stringify({ id: 'task', repo: sourceRepo, baseCommit: 'HEAD', prompt: '', setup: 'true', verify: 'true' }),
  );
  const tempDir = path.join(root, 'tmp');
  await mkdir(tempDir);
  sandbox = await openSandbox(await sandboxPolicy({ store, home, workspace, tempDir }));
});

afterAll(async () => {
  await sandbox.close();
});

const run = (command: string) =>
  sandbox.run(command, { cwd: workspace, env: childEnv(process.env), timeoutMs: 30_000 });

describe('the bash sandbox', () => {
  it('writes inside the workspace', async () => {
    const result = await run('echo inside > made.txt');
    expect(result.code).toBe(0);
    expect(await readFile(path.join(workspace, 'made.txt'), 'utf8')).toBe('inside\n');
  });

  it('refuses a write outside the workspace and the temp dir', async () => {
    const target = path.join(outside, 'escaped.txt');
    const result = await run(`echo escaped > '${target}'`);
    expect(result.code).not.toBe(0);
    expect(result.output).toContain('Operation not permitted');
    await expect(readFile(target, 'utf8')).rejects.toThrow(/ENOENT/);
  });

  it("refuses to read a task's source repo", async () => {
    const result = await run(`cat '${path.join(sourceRepo, 'answer.txt')}'`);
    expect(result.code).not.toBe(0);
    expect(result.output).not.toContain('the hidden answer');
    expect(result.output).toContain('Operation not permitted');
  });

  it('has no network', async () => {
    const result = await run(
      `node -e "fetch('https://example.com').then(() => process.exit(0), () => process.exit(7))" && curl -sS -m 5 https://example.com`,
    );
    expect(result.code).not.toBe(0);
  });
});
