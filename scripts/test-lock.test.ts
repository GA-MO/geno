import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { acquireTestLock, type LockDeps } from './test-lock.js';

const fileIn = () => path.join(mkdtempSync(path.join(tmpdir(), 'lock-')), 'run.lock');
const quiet = (alive: (pid: number) => boolean, onSleep: () => void = () => {}): LockDeps & { said: string[] } => {
  const said: string[] = [];
  return { alive, sleep: onSleep, say: (l) => said.push(l), said };
};

describe('acquireTestLock', () => {
  it('takes a free lock and releases only its own', () => {
    const file = fileIn();
    const release = acquireTestLock(file, 101, quiet(() => true));
    expect(readFileSync(file, 'utf8')).toBe('101');
    writeFileSync(file, '202');
    release();
    expect(readFileSync(file, 'utf8')).toBe('202');
  });

  it('takes over a lock whose holder is gone, without waiting', () => {
    const file = fileIn();
    writeFileSync(file, '999');
    const deps = quiet(() => false, () => {
      throw new Error('slept');
    });
    acquireTestLock(file, 101, deps)();
    expect(existsSync(file)).toBe(false);
    expect(deps.said).toEqual([]);
  });

  it('waits while a live run holds it, says so once, and takes it when that run ends', () => {
    const file = fileIn();
    writeFileSync(file, '555');
    let sleeps = 0;
    const deps = quiet(
      (pid) => pid === 555 && sleeps < 3,
      () => {
        sleeps++;
      },
    );
    acquireTestLock(file, 101, deps);
    expect(sleeps).toBe(3);
    expect(deps.said).toHaveLength(1);
    expect(deps.said[0]).toMatch(/waiting for the test run of pid 555/);
    expect(readFileSync(file, 'utf8')).toBe('101');
  });
});
