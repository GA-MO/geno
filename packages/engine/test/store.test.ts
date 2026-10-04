import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { openStore, readTasks, StoreError } from '../src/store.js';
import { runCli } from './helpers.js';

async function tempHome() {
  const home = await mkdtemp(path.join(tmpdir(), 'gcode-home-'));
  return { home, store: openStore({ GCODE_HOME: home }) };
}

describe('store parsing', () => {
  it('names the file path when a task JSON is malformed', async () => {
    const { store } = await tempHome();
    await mkdir(store.tasksDir, { recursive: true });
    const bad = path.join(store.tasksDir, 'broken.json');
    await writeFile(bad, '{"id": "broken", ');

    const error = await readTasks(store).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(StoreError);
    expect((error as StoreError).file).toBe(bad);
    expect((error as StoreError).message).toContain(bad);
  });

  it('names the file path when a task JSON fails the schema', async () => {
    const { store } = await tempHome();
    await mkdir(store.tasksDir, { recursive: true });
    const bad = path.join(store.tasksDir, 'relative.json');
    await writeFile(
      bad,
      JSON.stringify({ id: 't1', repo: 'not/absolute', baseCommit: 'abc', prompt: 'p', setup: '', verify: 'true' }),
    );

    await expect(readTasks(store)).rejects.toThrow(bad);
  });

  it('lists an empty store with its path and exits 0', async () => {
    const { home } = await tempHome();
    const result = await runCli(['eval', 'list'], { GCODE_HOME: home });
    expect(result.code).toBe(0);
    expect(result.stdout).toContain(path.join(home, 'evals'));
    expect(result.stdout).toContain('0 tasks, 0 triples');
  });

  it('reports a malformed task through the CLI with exit 1', async () => {
    const { home, store } = await tempHome();
    await mkdir(store.tasksDir, { recursive: true });
    await writeFile(path.join(store.tasksDir, 'broken.json'), 'nope');
    const result = await runCli(['eval', 'list'], { GCODE_HOME: home });
    expect(result.code).toBe(1);
    expect(result.stderr).toContain(path.join(store.tasksDir, 'broken.json'));
  });

  it('prints usage and exits 2 on an unknown command or bad flag', async () => {
    const { home } = await tempHome();
    expect((await runCli(['eval', 'bogus'], { GCODE_HOME: home })).code).toBe(2);
    const badFlag = await runCli(['eval', 'list', '--nope'], { GCODE_HOME: home });
    expect(badFlag.code).toBe(2);
    expect(badFlag.stderr).toContain('usage:');
  });
});
