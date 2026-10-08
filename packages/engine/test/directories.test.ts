import { mkdir, mkdtemp, realpath, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { addedDirectories, settingDirectories, workingDirectories } from '../src/directories.js';

const SETTING = 'gcode.additionalDirectories';

describe('B/B-68 gcode.additionalDirectories', () => {
  it('reads a path as read-only and an object with writable as it says, and adds nothing when unset', () => {
    expect(settingDirectories({})).toEqual({ entries: [] });
    expect(settingDirectories({ GCODE_ADDITIONAL_DIRECTORIES: JSON.stringify(['../shared', { path: '~/notes', writable: true }, { path: '/x' }, ' ']) })).toEqual({
      entries: [
        { path: '../shared', writable: false, source: SETTING },
        { path: '~/notes', writable: true, source: SETTING },
        { path: '/x', writable: false, source: SETTING },
      ],
    });
  });

  it('adds no directory from a value that is not a list of paths, and says why', () => {
    expect(settingDirectories({ GCODE_ADDITIONAL_DIRECTORIES: '[' })).toMatchObject({ entries: [], problem: expect.stringContaining(`${SETTING} is not valid JSON`) });
    expect(settingDirectories({ GCODE_ADDITIONAL_DIRECTORIES: JSON.stringify([{ path: '/x', writable: 'yes' }]) })).toMatchObject({ entries: [], problem: expect.stringContaining(`${SETTING} adds no directory`) });
  });

  it('resolves ~ from the home and a relative path from the workspace to real paths, leaves out what is no directory, and merges a directory named twice', async () => {
    const root = await realpath(await mkdtemp(path.join(tmpdir(), 'gcode-dirs-')));
    const workspace = path.join(root, 'ws');
    const home = path.join(root, 'home');
    await mkdir(workspace);
    await mkdir(path.join(home, 'notes'), { recursive: true });
    await mkdir(path.join(root, 'shared'));
    await writeFile(path.join(root, 'file.txt'), '');
    await symlink(path.join(root, 'shared'), path.join(root, 'link'));
    const warnings: string[] = [];
    const added = await addedDirectories(
      [
        { path: '../shared', writable: false, source: SETTING },
        { path: '~/notes', writable: false, source: '.claude/settings.json' },
        { path: '../link', writable: true, source: '.claude/settings.json' },
        { path: '../missing', writable: false, source: SETTING },
        { path: '../file.txt', writable: false, source: SETTING },
      ],
      workspace,
      home,
      (line) => warnings.push(line),
    );
    expect(added).toEqual([
      { path: path.join(root, 'shared'), writable: true, source: SETTING },
      { path: path.join(home, 'notes'), writable: false, source: '.claude/settings.json' },
    ]);
    expect(warnings).toEqual([`directories: ${SETTING}: ../missing is not a directory, so it is not added`, `directories: ${SETTING}: ../file.txt is not a directory, so it is not added`]);
  });

  it('reads the added directories and then those allowed for the session, and writes only the writable ones', () => {
    const session = new Set<string>();
    const dirs = workingDirectories([{ path: '/a', writable: false, source: SETTING }, { path: '/b', writable: true, source: SETTING }], session);
    dirs.allow('/c');
    expect(dirs.readable()).toEqual(['/a', '/b', '/c']);
    expect(dirs.writable()).toEqual(['/b']);
    expect([...session]).toEqual(['/c']);
  });
});
