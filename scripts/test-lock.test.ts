import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { acquireTestLock, tooBusy, waitForHeadroom, type LockDeps } from './test-lock.js';

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

describe('headroom', () => {
  const GB = 2 ** 30;
  it('says why a busy machine should not start a run', () => {
    expect(tooBusy({ load: 4, cores: 10, availableBytes: 8 * GB }, 3 * GB, 1.5)).toBeUndefined();
    expect(tooBusy({ load: 4, cores: 10, availableBytes: 2 * GB }, 3 * GB, 1.5)).toMatch(/only 2.0 GB of memory/);
    expect(tooBusy({ load: 20, cores: 10, availableBytes: 8 * GB }, 3 * GB, 1.5)).toMatch(/load average is 20.0 on 10 cores/);
  });

  it('waits until there is room, saying so once', () => {
    let calls = 0;
    const said: string[] = [];
    waitForHeadroom({}, { alive: () => true, sleep: () => {}, say: (l) => said.push(l) }, () => ({ load: calls++ < 2 ? 50 : 1, cores: 10, availableBytes: 8 * GB }));
    expect(calls).toBe(3);
    expect(said).toHaveLength(1);
  });

  it('does not wait when turned off', () => {
    waitForHeadroom({ GCODE_TEST_HEADROOM: 'off' }, { alive: () => true, sleep: () => { throw new Error('slept'); }, say: () => {} }, () => ({ load: 99, cores: 1, availableBytes: 0 }));
  });
});
