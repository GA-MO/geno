import { chmodSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { GIT_STATUS_LINES } from '@g-code/core';
import { captureEnvironment, reopenScratchpad, scratchpadOf } from '../src/environment.js';
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
  const ID = '1fadfc9f-3c1b-4a7e-9d2f-0b6e5c4a8d17';
  const uid = process.getuid!();
  const tmpRoot = () => realpathSync(mkdtempSync(path.join(tmpdir(), 'scratch-')));

  it.runIf(process.platform !== 'win32')("is /tmp/gcode-<uid>/<first 8 hex of the id>, a folder of this user's that only it can open, the same path on every call", async () => {
    const tmp = tmpRoot();
    const pad = await scratchpadOf(ID, { tmp });
    expect(pad).toBe(path.join(tmp, `gcode-${uid}`, '1fadfc9f'));
    expect(statSync(path.dirname(pad)).mode & 0o777).toBe(0o700);
    expect(statSync(pad).mode & 0o777).toBe(0o700);
    expect(await scratchpadOf(ID, { tmp })).toBe(pad);
    expect(path.join(realpathSync('/tmp'), `gcode-${uid}`, '1fadfc9f').length).toBeLessThan(40);
  });

  it.runIf(process.platform !== 'win32')('gives a session whose id starts the same as a live one more of its id, never the same folder', async () => {
    const tmp = tmpRoot();
    const first = await scratchpadOf(ID, { tmp });
    const twin = '1fadfc9f-0000-4000-8000-000000000001';
    expect(await scratchpadOf(twin, { tmp })).toBe(path.join(tmp, `gcode-${uid}`, '1fadfc9f00004000'));
    expect(await scratchpadOf(ID, { tmp })).toBe(first);
    mkdirSync(path.join(tmp, `gcode-${uid}`, '2fadfc9f'), { mode: 0o700 });
    expect(await scratchpadOf('2fadfc9f-3c1b-4a7e-9d2f-0b6e5c4a8d17', { tmp })).toBe(path.join(tmp, `gcode-${uid}`, '2fadfc9f3c1b4a7e'));
  });

  const fallsBack = async (tmp: string, options: { readonly uid?: number } = {}) => {
    const warned: string[] = [];
    const pad = await scratchpadOf(ID, { tmp, ...options, warn: (line) => warned.push(line) });
    expect(pad).toBe(path.join(realpathSync(tmpdir()), 'gcode-sessions', ID));
    expect(warned).toHaveLength(1);
  };

  it.runIf(process.platform !== 'win32')('falls back to the temp dir when /tmp/gcode-<uid> is a symlink, even to a folder of its own', async () => {
    const tmp = tmpRoot();
    mkdirSync(path.join(tmp, 'elsewhere'), { mode: 0o700 });
    symlinkSync(path.join(tmp, 'elsewhere'), path.join(tmp, `gcode-${uid}`));
    await fallsBack(tmp);
    expect(readdirSync(path.join(tmp, 'elsewhere'))).toEqual([]);
  });

  it.runIf(process.platform !== 'win32')("falls back to the temp dir when /tmp/gcode-<uid> is another user's or others can write it", async () => {
    const foreign = tmpRoot();
    mkdirSync(path.join(foreign, `gcode-${uid + 1}`), { mode: 0o700 });
    await fallsBack(foreign, { uid: uid + 1 });
    const open = tmpRoot();
    mkdirSync(path.join(open, `gcode-${uid}`));
    chmodSync(path.join(open, `gcode-${uid}`), 0o777);
    await fallsBack(open);
    expect(readdirSync(path.join(open, `gcode-${uid}`))).toEqual([]);
  });

  it.runIf(process.platform !== 'win32')('falls back to the temp dir when it cannot make a folder in /tmp/gcode-<uid>, as inside a sandbox that writes only its own scratchpad', async () => {
    const tmp = tmpRoot();
    mkdirSync(path.join(tmp, `gcode-${uid}`), { mode: 0o500 });
    await fallsBack(tmp);
  });
});

describe('reopenScratchpad', () => {
  it.runIf(process.platform !== 'win32')("makes a recorded scratchpad again after a reboot emptied /tmp, and refuses one whose root is no longer the user's own", async () => {
    const uid = process.getuid!();
    const tmp = realpathSync(mkdtempSync(path.join(tmpdir(), 'scratch-')));
    const pad = path.join(tmp, `gcode-${uid}`, '1fadfc9f');
    expect(await reopenScratchpad(pad)).toBe(true);
    expect(statSync(path.dirname(pad)).mode & 0o777).toBe(0o700);
    chmodSync(path.dirname(pad), 0o777);
    expect(await reopenScratchpad(pad)).toBe(false);
  });
});
