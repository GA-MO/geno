import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { restore, shadowRepoFor, snapshot } from '../src/checkpoints.js';
import { openStore } from '../src/store.js';
import { makeRepo } from './git-fixture.js';

// Every file under `dir` with its sha256, so one comparison covers contents, additions and deletions.
function tree(dir: string, skip: (rel: string) => boolean = () => false): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (rel: string) => {
    for (const name of readdirSync(path.join(dir, rel))) {
      const child = rel === '' ? name : `${rel}/${name}`;
      if (skip(child)) continue;
      if (statSync(path.join(dir, child)).isDirectory()) walk(child);
      else out[child] = createHash('sha256').update(readFileSync(path.join(dir, child))).digest('hex');
    }
  };
  walk('');
  return out;
}

const gitOf = (repo: string, ...args: string[]) => execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8' });

describe('checkpoints', () => {
  it('restores edits, deletes new untracked files, keeps ignored files, and leaves the workspace .git alone', async () => {
    const workspace = makeRepo('ws', [
      { message: 'start', files: { 'a.ts': 'export const a = 1;\n', 'src/b.ts': 'export const b = 2;\n', '.gitignore': 'build/\n' } },
    ]);
    await writeFile(path.join(workspace, 'untracked-before.txt'), 'here before the checkpoint\n');
    await mkdir(path.join(workspace, 'build'));
    await writeFile(path.join(workspace, 'build', 'out.js'), 'ignored output\n');
    const store = openStore({ GCODE_HOME: await mkdtemp(path.join(tmpdir(), 'gcode-home-')) });
    const repo = shadowRepoFor(store, workspace);
    const gitDirBefore = tree(path.join(workspace, '.git'));
    const headBefore = gitOf(workspace, 'rev-parse', 'HEAD');
    const before = tree(workspace, (rel) => rel === '.git' || rel === 'build');

    const sha = await snapshot(repo, 'before turn 2');
    await writeFile(path.join(workspace, 'a.ts'), 'export const a = 100;\n');
    await mkdir(path.join(workspace, 'src', 'new'));
    await writeFile(path.join(workspace, 'src', 'new', 'c.ts'), 'export const c = 3;\n');
    await writeFile(path.join(workspace, 'untracked-before.txt'), 'changed\n');
    await writeFile(path.join(workspace, 'build', 'out.js'), 'rebuilt\n');

    const files = await restore(repo, sha);
    expect(files).toEqual(['a.ts', 'src/new/c.ts', 'untracked-before.txt']);
    expect(tree(workspace, (rel) => rel === '.git' || rel === 'build')).toEqual(before);
    expect(existsSync(path.join(workspace, 'src', 'new'))).toBe(false);
    expect(readFileSync(path.join(workspace, 'build', 'out.js'), 'utf8')).toBe('rebuilt\n');
    expect(tree(path.join(workspace, '.git'))).toEqual(gitDirBefore);
    expect(gitOf(workspace, 'rev-parse', 'HEAD')).toBe(headBefore);
    expect(repo.gitDir.startsWith(store.checkpointsDir)).toBe(true);

    expect(await restore(repo, sha)).toEqual([]);
    expect(tree(workspace, (rel) => rel === '.git' || rel === 'build')).toEqual(before);
  });
});
