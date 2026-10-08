import { closeSync, mkdirSync, openSync, readFileSync, rmSync, writeSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';

/** Set in the environment of a run that holds the lock, so a vitest a test starts inside it does not wait on its parent. */
export const HELD_ENV = 'GCODE_TEST_LOCK_HELD';

export type LockDeps = {
  readonly alive: (pid: number) => boolean;
  readonly sleep: (ms: number) => void;
  readonly say: (line: string) => void;
};

const defaults: LockDeps = {
  alive: (pid) => {
    try {
      process.kill(pid, 0);
      return true;
    } catch (error) {
      return (error as NodeJS.ErrnoException).code === 'EPERM';
    }
  },
  sleep: (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms),
  say: (line) => process.stderr.write(`${line}\n`),
};

const holderOf = (file: string): number | undefined => {
  try {
    const pid = Number(readFileSync(file, 'utf8').trim());
    return Number.isInteger(pid) && pid > 0 ? pid : undefined;
  } catch {
    return undefined;
  }
};

/**
 * Waits until no other test run on this machine holds `file`, then takes it for `pid` and returns its release. A lock
 * whose holder is gone is taken over. Parallel delegates that each start a full run once froze the Mac.
 */
export function acquireTestLock(file: string, pid: number, deps: LockDeps = defaults): () => void {
  mkdirSync(path.dirname(file), { recursive: true });
  let told = false;
  for (;;) {
    try {
      const fd = openSync(file, 'wx');
      writeSync(fd, String(pid));
      closeSync(fd);
      return () => {
        if (holderOf(file) === pid) rmSync(file, { force: true });
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    }
    const holder = holderOf(file);
    if (holder === undefined || !deps.alive(holder)) {
      rmSync(file, { force: true });
      continue;
    }
    if (!told) deps.say(`waiting for the test run of pid ${holder} to finish (${file}); GCODE_TEST_LOCK=off skips the wait`);
    told = true;
    deps.sleep(2000);
  }
}

/**
 * For vitest.config.ts: one test run at a time on this machine, at a lower CPU priority so the editor stays usable.
 * A run inside a held run, or GCODE_TEST_LOCK=off, neither waits nor locks.
 */
export function useTestLock(env: NodeJS.ProcessEnv = process.env): void {
  if (env['GCODE_TEST_LOCK'] === 'off' || env[HELD_ENV] === '1') return;
  const release = acquireTestLock(path.join(homedir(), '.g-code', 'test-run.lock'), process.pid);
  env[HELD_ENV] = '1';
  process.on('exit', release);
  for (const signal of ['SIGINT', 'SIGTERM'] as const) process.once(signal, () => (release(), process.exit(130)));
  try {
    process.setPriority?.(0, 10);
  } catch {
    // Already lower, or not permitted.
  }
}
