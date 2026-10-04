import { execFileSync } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { cloneAt } from '../src/git.js';
import { makeRepo } from './git-fixture.js';

const revs = (repo: string, ...args: string[]) =>
  execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8' }).trim();

describe('cloneAt', () => {
  it('checks out the commit with its history and nothing after it', async () => {
    const repo = makeRepo('history', [
      { message: 'Add the greeting', files: { 'greet.txt': 'hello\n' } },
      { message: 'Change the greeting', files: { 'greet.txt': 'hi\n' } },
      { message: 'Answer the task', files: { 'greet.txt': 'goodbye\n' } },
    ]);
    const [answer, base, first] = revs(repo, 'rev-list', 'HEAD').split('\n');
    const dest = path.join(mkdtempSync(path.join(tmpdir(), 'gcode-clone-')), 'work');

    await cloneAt(repo, dest, base!);

    expect(revs(dest, 'rev-parse', 'HEAD')).toBe(base);
    expect(revs(dest, 'rev-list', '--all').split('\n')).toEqual([base, first]);
    expect(() => revs(dest, 'cat-file', '-e', answer!)).toThrow();
    expect(revs(dest, 'remote')).toBe('');
  });
});
