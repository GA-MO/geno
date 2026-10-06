import { mkdir, mkdtemp, readFile, realpath, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { childEnv } from '../src/child-env.js';
import { EngineError } from '../src/errors.js';
import { CREDENTIAL_PATHS, openSandbox, sandboxPolicy, type Sandbox } from '../src/sandbox.js';
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
  for (const file of [...CREDENTIAL_PATHS.map((p) => path.join(p, 'secret')), path.join('.config', 'other', 'secret')]) {
    await mkdir(path.dirname(path.join(home, file)), { recursive: true });
    await writeFile(path.join(home, file), `secret in ${file}\n`);
  }
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

  it.each(CREDENTIAL_PATHS)('refuses to read the credentials under ~/%s', async (place) => {
    const result = await run(`cat '${path.join(root, 'home', place, 'secret')}'`);
    expect(result.code).not.toBe(0);
    expect(result.output).not.toContain('secret in');
  });

  it('still reads the rest of the home folder', async () => {
    const result = await run(`cat '${path.join(root, 'home', '.config', 'other', 'secret')}'`);
    expect(result.output).toContain('secret in .config/other/secret');
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

describe('two sandboxes open at once', () => {
  async function chat(name: string) {
    const dir = path.join(root, name);
    const ws = path.join(dir, 'ws');
    const tempDir = path.join(dir, 'tmp');
    await mkdir(ws, { recursive: true });
    await mkdir(tempDir);
    const home = path.join(dir, 'home');
    const opened = await openSandbox(await sandboxPolicy({ store: openStore({ GCODE_HOME: home }), home, workspace: ws, tempDir }));
    return { ws, sandbox: opened, run: (command: string) => opened.run(command, { cwd: ws, env: childEnv(process.env), timeoutMs: 30_000 }) };
  }

  it("each writes its own workspace and never the other's", async () => {
    const a = await chat('chat-a');
    const b = await chat('chat-b');
    try {
      expect((await a.run('echo a > own.txt')).code).toBe(0);
      expect((await b.run('echo b > own.txt')).code).toBe(0);
      const intoB = await a.run(`echo from-a > '${path.join(b.ws, 'from-a.txt')}'`);
      const intoA = await b.run(`echo from-b > '${path.join(a.ws, 'from-b.txt')}'`);
      expect(intoB.output).toContain('Operation not permitted');
      expect(intoA.output).toContain('Operation not permitted');
      await expect(readFile(path.join(b.ws, 'from-a.txt'), 'utf8')).rejects.toThrow(/ENOENT/);
      await expect(readFile(path.join(a.ws, 'from-b.txt'), 'utf8')).rejects.toThrow(/ENOENT/);
      expect(await readFile(path.join(a.ws, 'own.txt'), 'utf8')).toBe('a\n');
      expect(await readFile(path.join(b.ws, 'own.txt'), 'utf8')).toBe('b\n');
    } finally {
      await a.sandbox.close();
      await b.sandbox.close();
    }
  });

  it('keeps the network off for one while another closes and a sandbox that allows a host tries to open', async () => {
    const a = await chat('chat-c');
    const b = await chat('chat-d');
    await a.sandbox.close();
    const tempDir = path.join(root, 'tmp-allow');
    await mkdir(tempDir);
    const home = path.join(root, 'home-allow');
    const policy = await sandboxPolicy({ store: openStore({ GCODE_HOME: home }), home, workspace, tempDir, allowedDomains: ['example.com'] });
    const allowing = await openSandbox(policy).catch((error: unknown) => error);
    try {
      expect((await b.run('curl -sS -m 5 -o /dev/null https://example.com')).code, 'no network for the sandbox that allows none').not.toBe(0);
      expect(allowing).toEqual(new EngineError('a sandbox that allows the network hosts [] is open, and this one allows ["example.com"]'));
    } finally {
      if (!(allowing instanceof Error)) await (allowing as Sandbox).close();
      await b.sandbox.close();
    }
  });
});
