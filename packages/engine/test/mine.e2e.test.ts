import { mkdtemp, readdir, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { makeRepo } from './git-fixture.js';
import { runCli } from './helpers.js';

const BEFORE = 'export function add(a, b) {\n  return a - b;\n}\n';
const AFTER = 'export function add(a, b) {\n  return a + b;\n}\n';

describe('gcode eval mine', () => {
  it('writes exactly one triple for the one keepable commit, idempotently', async () => {
    const repo = makeRepo('fixture', [
      { message: 'Add the math helpers module', files: { 'math.js': BEFORE, 'README.md': '# fixture\n' } },
      { message: 'Fix the sign in add', files: { 'math.js': AFTER } },
      { message: 'Bump the lockfile pins', files: { 'pnpm-lock.yaml': 'lockfileVersion: 9\n' } },
    ]);
    const home = await mkdtemp(path.join(tmpdir(), 'gcode-home-'));
    const applyDir = path.join(home, 'evals', 'apply');

    const first = await runCli(['eval', 'mine', '--repo', repo], { GCODE_HOME: home });
    expect(first.stderr).toBe('');
    expect(first.code).toBe(0);
    expect(first.stdout).toContain('scanned 3 commits, kept 1, skipped 2');
    expect(first.stdout).toContain('skipped multi-file: 1');
    expect(first.stdout).toContain('skipped lockfile: 1');

    const files = await readdir(applyDir);
    expect(files).toHaveLength(1);
    const triple = JSON.parse(await readFile(path.join(applyDir, files[0]!), 'utf8'));
    expect(triple).toMatchObject({
      repo: expect.stringMatching(/fixture$/),
      path: 'math.js',
      instruction: 'Fix the sign in add',
      before: BEFORE,
      expected: AFTER,
    });
    expect(files[0]).toBe(`${triple.id}.json`);
    expect(triple.id).toMatch(/^fixture-[0-9a-f]{7}$/);

    const second = await runCli(['eval', 'mine', '--repo', repo], { GCODE_HOME: home });
    expect(second.code).toBe(0);
    expect(await readdir(applyDir)).toEqual(files);
  });

  it('stops after --limit kept commits', async () => {
    const repo = makeRepo('limited', [
      { message: 'Start the counter file', files: { 'n.txt': '0\n' } },
      { message: 'Bump the counter once', files: { 'n.txt': '1\n' } },
      { message: 'Bump the counter twice', files: { 'n.txt': '2\n' } },
    ]);
    const home = await mkdtemp(path.join(tmpdir(), 'gcode-home-'));
    const result = await runCli(['eval', 'mine', '--repo', repo, '--limit', '1'], { GCODE_HOME: home });
    expect(result.stdout).toContain('scanned 1 commits, kept 1, skipped 0');
    expect(await readdir(path.join(home, 'evals', 'apply'))).toHaveLength(1);
  });

  it('rejects a non-numeric limit with exit 2 and a missing repo with exit 1', async () => {
    const home = await mkdtemp(path.join(tmpdir(), 'gcode-home-'));
    const bad = await runCli(['eval', 'mine', '--repo', '.', '--limit', 'many'], { GCODE_HOME: home });
    expect(bad.code).toBe(2);
    const missing = await runCli(['eval', 'mine', '--repo', path.join(home, 'nope')], { GCODE_HOME: home });
    expect(missing.code).toBe(1);
    expect(missing.stderr).toContain('git rev-parse');
  });
});
