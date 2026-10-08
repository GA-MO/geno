import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { GIT_STATUS_LINES } from '@g-code/core';
import { captureEnvironment, scratchpadOf } from '../src/environment.js';
import { createLane, laneRepoOf } from '../src/lanes.js';
import { makeRepo } from './git-fixture.js';

const write = (dir: string, files: Readonly<Record<string, string>>) => {
  for (const [file, text] of Object.entries(files)) {
    mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
    writeFileSync(path.join(dir, file), text);
  }
};

const PACKAGE = JSON.stringify({
  packageManager: 'pnpm@11.3.0',
  scripts: { test: 'vitest run', seed: 'tsx seed.ts', dev: 'next dev', build: 'next build' },
  dependencies: { next: '^15.0.0', react: '19.0.0' },
  devDependencies: { payload: '^3.1.0' },
});

describe('captureEnvironment', () => {
  it('records the local date, the platform, the login shell and the scratchpad it is given', async () => {
    const dir = realpathSync(mkdtempSync(path.join(tmpdir(), 'gcode-env-')));
    // 23:30 on the 7th in UTC is already the 8th east of UTC; the date is the local one.
    const now = new Date(2026, 9, 8, 0, 30);
    const env = await captureEnvironment({ workspace: dir, scratchpad: '/tmp/s', env: { SHELL: '/bin/zsh' }, now });
    expect(env).toMatchObject({ date: '2026-10-08', platform: process.platform, loginShell: 'zsh', scratchpad: '/tmp/s' });
    expect(env.osVersion).toMatch(/^\S+ \S+/);
    expect(env.git, 'not a repository').toBeUndefined();
    expect(env.project, 'no package.json').toBeUndefined();
  });

  it('takes a git snapshot: the branch, the short status capped, and the five newest commits', async () => {
    const repo = makeRepo('ws', [1, 2, 3, 4, 5, 6].map((n) => ({ message: `commit ${n}`, files: { 'a.ts': `export const a = ${n};\n` } })));
    write(repo, Object.fromEntries(Array.from({ length: GIT_STATUS_LINES + 3 }, (_, i) => [`new-${String(i).padStart(2, '0')}.ts`, ''])));
    write(repo, { 'a.ts': 'changed\n' });
    const { git } = await captureEnvironment({ workspace: repo, scratchpad: '/tmp/s', env: {} });
    expect(git?.branch).toBe('main');
    expect(git?.status[0]).toBe(' M a.ts');
    expect(git?.status).toHaveLength(GIT_STATUS_LINES);
    expect(git?.moreStatus).toBe(4);
    expect(git?.commits.map((line) => line.replace(/^[0-9a-f]+ /, ''))).toEqual(['commit 6', 'commit 5', 'commit 4', 'commit 3', 'commit 2']);
  });

  it('reads the package manager, the key scripts, the other script names and the installed versions from package.json', async () => {
    const repo = makeRepo('ws', [{ message: 'start', files: { 'package.json': PACKAGE } }]);
    write(repo, { 'node_modules/next/package.json': JSON.stringify({ name: 'next', version: '15.1.2' }) });
    const { project } = await captureEnvironment({ workspace: repo, scratchpad: '/tmp/s', env: {} });
    expect(project).toEqual({
      packageManager: 'pnpm 11.3.0',
      scripts: [
        ['dev', 'next dev'],
        ['build', 'next build'],
        ['test', 'vitest run'],
      ],
      otherScripts: ['seed'],
      versions: [
        ['next', '15.1.2'],
        ['payload', '^3.1.0'],
        ['react', '19.0.0'],
      ],
    });
  });

  it('names the package manager from a lockfile, and keeps going past a package.json it cannot parse', async () => {
    const dir = realpathSync(mkdtempSync(path.join(tmpdir(), 'gcode-env-')));
    write(dir, { 'package.json': '{"scripts": {"dev": "vite"}}', 'yarn.lock': '' });
    expect((await captureEnvironment({ workspace: dir, scratchpad: '/tmp/s', env: {} })).project?.packageManager).toBe('yarn');
    write(dir, { 'package.json': '{ not json' });
    expect((await captureEnvironment({ workspace: dir, scratchpad: '/tmp/s', env: {} })).project).toBeUndefined();
  });

  it('names the lane of a session whose workspace is one, so its opening carries the stash warning, and no lane for the main checkout', async () => {
    const main = realpathSync(makeRepo('ws', [{ message: 'start', files: { 'a.ts': 'x\n' } }]));
    const lane = await createLane(await laneRepoOf(main), 'fix-login', 'head');
    expect((await captureEnvironment({ workspace: lane.path, scratchpad: '/tmp/s', env: {} })).lane).toEqual({ name: 'fix-login', branch: 'geno/fix-login', main });
    expect((await captureEnvironment({ workspace: main, scratchpad: '/tmp/s', env: {} })).lane).toBeUndefined();
  });
});

describe('scratchpadOf', () => {
  it('is one folder per session under the real temp dir', async () => {
    const a = await scratchpadOf('s-1');
    expect(a.startsWith(realpathSync(tmpdir()))).toBe(true);
    expect(a).not.toBe(await scratchpadOf('s-2'));
    expect(a).toBe(await scratchpadOf('s-1'));
  });
});
