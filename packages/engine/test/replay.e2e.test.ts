import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { makeRepo } from './git-fixture.js';
import { runCli } from './helpers.js';

async function minedHome() {
  const repo = makeRepo('replayable', [
    { message: 'Add the greeting module', files: { 'greet.ts': 'export const hi = "hello";\n' } },
    { message: 'Make the greeting louder', files: { 'greet.ts': 'export const hi = "HELLO";\n' } },
  ]);
  const home = await mkdtemp(path.join(tmpdir(), 'gcode-home-'));
  const mined = await runCli(['eval', 'mine', '--repo', repo], { GCODE_HOME: home });
  const id = /^  kept (\S+)$/m.exec(mined.stdout)?.[1];
  if (id === undefined) throw new Error(`nothing mined:\n${mined.stdout}`);
  return { home, id };
}

describe('gcode eval replay and apply', () => {
  it('exits 0 for oracle and 1 with a diff for noop', async () => {
    const { home, id } = await minedHome();

    const oracle = await runCli(['eval', 'replay', id, '--applier', 'oracle'], { GCODE_HOME: home });
    expect(oracle.code).toBe(0);
    expect(oracle.stdout).toContain('exact match: yes');

    const noop = await runCli(['eval', 'replay', id, '--applier', 'noop'], { GCODE_HOME: home });
    expect(noop.code).toBe(1);
    expect(noop.stdout).toContain('exact match: no');
    expect(noop.stdout).toContain('-export const hi = "HELLO";');
    expect(noop.stdout).toContain('+export const hi = "hello";');
  });

  it('reports exact-match and failure rates across the store', async () => {
    const { home } = await minedHome();
    const oracle = await runCli(['eval', 'apply', '--applier', 'oracle'], { GCODE_HOME: home });
    expect(oracle.code).toBe(0);
    expect(oracle.stdout).toContain('exact match: 1/1 (100.0%)');
    expect(oracle.stdout).toContain('failed: 0/1 (0.0%)');
    const noop = await runCli(['eval', 'apply'], { GCODE_HOME: home });
    expect(noop.stdout).toContain('exact match: 0/1 (0.0%)');
  });

  it('rejects an unknown applier with exit 2 and a missing triple with exit 1', async () => {
    const { home, id } = await minedHome();
    expect((await runCli(['eval', 'replay', id, '--applier', 'magic'], { GCODE_HOME: home })).code).toBe(2);
    const missing = await runCli(['eval', 'replay', 'nope-0000000'], { GCODE_HOME: home });
    expect(missing.code).toBe(1);
    expect(missing.stderr).toContain('no triple nope-0000000');
  });
});
