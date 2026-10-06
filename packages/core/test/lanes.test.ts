import { describe, expect, it } from 'vitest';
import { isDisposable, laneCommandDenial, mergeStepOf, parseLaneName, shellSegments, type LaneBounds, type LaneDenialId } from '../src/index.js';

const MAIN = '/repo';
const LANE = '/repo/.geno/worktrees/a';
const bounds: LaneBounds = { lane: [LANE, '/alias/repo/.geno/worktrees/a'], main: [MAIN, '/alias/repo'], home: '/home/me' };
const denial = (command: string, cwd = LANE): LaneDenialId | undefined => laneCommandDenial(command, cwd, bounds)?.id;

describe('lane names', () => {
  it('takes folder- and branch-safe names only', () => {
    expect(parseLaneName('fix-login.2')).toBe('fix-login.2');
    for (const bad of ['', '../x', 'a/b', '-a', 'a..b', 'a.lock', 'a.', 'a b', 'x'.repeat(49)]) expect(parseLaneName(bad)).toBeUndefined();
  });
});

describe('lane status', () => {
  it('lets only a lane with nothing to lose be swept', () => {
    expect(isDisposable('changed')).toBe(false);
    expect(isDisposable('clean')).toBe(true);
    expect(isDisposable('missing')).toBe(true);
  });
});

describe('mergeStepOf', () => {
  it.each([
    [{ base: 'a', ours: 'a', theirs: 'b' }, { kind: 'take', after: 'b' }],
    [{ base: 'a', ours: 'a', theirs: null }, { kind: 'take', after: null }],
    [{ base: null, ours: null, theirs: 'n' }, { kind: 'take', after: 'n' }],
    [{ base: 'a', ours: 'b', theirs: 'b' }, { kind: 'same' }],
    [{ base: 'a', ours: 'b', theirs: 'a' }, { kind: 'same' }],
    [{ base: 'a', ours: 'b', theirs: 'c' }, { kind: 'merge' }],
    [{ base: null, ours: 'x', theirs: 'y' }, { kind: 'conflict', reason: 'added-in-both' }],
    [{ base: 'a', ours: 'b', theirs: null }, { kind: 'conflict', reason: 'deleted-in-lane' }],
    [{ base: 'a', ours: null, theirs: 'c' }, { kind: 'conflict', reason: 'deleted-in-main' }],
    [{ base: 'a\0', ours: 'b\0', theirs: 'c\0' }, { kind: 'conflict', reason: 'binary' }],
    [{ base: null, ours: null, theirs: 'png\0' }, { kind: 'conflict', reason: 'binary' }],
  ] as const)('%j -> %j', (input, step) => {
    expect(mergeStepOf(input)).toEqual(step);
  });
});

describe('shellSegments', () => {
  it('joins quotes and splits on operators', () => {
    expect(shellSegments(`echo 'a b' "c;d" e\\ f; cd .. && ls|wc >out (pwd)`)).toEqual([
      ['echo', 'a b', 'c;d', 'e f'],
      ['cd', '..'],
      ['ls'],
      ['wc', 'out'],
      ['pwd'],
    ]);
  });
});

describe('laneCommandDenial', () => {
  it.each([
    ['git -C ../../.. status', 'git-c-outside-lane'],
    [`git -C ${MAIN} commit -am x`, 'git-c-outside-lane'],
    ['git -C "$ROOT" status', 'git-c-outside-lane'],
    ['git --git-dir=../../../.git log', 'git-dir-flag'],
    ['git --work-tree /repo status', 'git-dir-flag'],
    ['git -c core.worktree=/repo status', 'git-dir-flag'],
    ['GIT_DIR=/repo/.git git log', 'git-env-redirect'],
    ['export GIT_WORK_TREE=/repo; git status', 'git-env-redirect'],
    ['env GIT_INDEX_FILE=/tmp/i git add -A', 'git-env-redirect'],
    ['cd ..', 'cd-outside-lane'],
    ['cd', 'cd-outside-lane'],
    ['cd -', 'cd-outside-lane'],
    ['cd src && cd ../../b', 'cd-outside-lane'],
    ['cd "$(git rev-parse --show-toplevel)"', 'cd-outside-lane'],
    [`echo x > ${MAIN}/a.ts`, 'path-in-main'],
    ['echo x > /alias/repo/a.ts', 'path-in-main'],
    ['cat ../../../a.ts', 'path-in-main'],
    ['cp a.ts ../b/a.ts', 'path-in-main'],
    ['tsc --outDir=../../../dist', 'path-in-main'],
    ['(cd src) && cat ../../x', 'path-in-main'],
    ['cd src/deep | true; cat ../../x', 'path-in-main'],
    ['echo `cd ..`', 'cd-outside-lane'],
  ] as const)('refuses %s as %s', (command, id) => {
    expect(denial(command)).toBe(id);
  });

  it.each([
    'git status',
    'git -C src log',
    'cd src && ls ../lib',
    'cd src; cd deep && cat ../../a.ts',
    `cat ${LANE}/a.ts`,
    "sed -i 's/a/b/' a.ts",
    'ls /usr/bin /tmp',
    'pnpm test -- --reporter=dot',
    'echo ~/notes',
  ])('allows %s', (command) => {
    expect(denial(command)).toBeUndefined();
  });

  it('refuses any command whose folder is outside the lane', () => {
    expect(denial('ls', MAIN)).toBe('cwd-outside-lane');
  });

  it('allows the home folder only when the main checkout is not under it', () => {
    expect(laneCommandDenial('cat ~/a.ts', LANE, { ...bounds, home: MAIN })?.id).toBe('path-in-main');
  });
});
