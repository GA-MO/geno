import { open, readdir } from 'node:fs/promises';
import path from 'node:path';
import type * as acp from '@agentclientprotocol/sdk';
import { openWaitOf, WAITING_META, waitLabel, type TurnEvent, type Waiter, type Waiting } from '@g-code/core';
import { readSessionLog } from './sessions.js';
import { isMissing, type Store } from './store.js';

/** A time of day on the engine's clock, which is the user's: 14:05. */
const clockOf = (ms: number): string => new Date(ms).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });

/** The wait as a notice, its state in `_meta` for the panel's running row and the plain words for any other client. */
export const waitUpdate = (wait: Waiting | null, now = Date.now()): acp.SessionUpdate =>
  wait === null
    ? { sessionUpdate: 'notice', severity: 'info', title: 'Sending again', _meta: { [WAITING_META]: null } }
    : { sessionUpdate: 'notice', severity: 'warning', title: waitLabel(wait, now, clockOf), description: wait.message, _meta: { [WAITING_META]: wait } };

/** Whether the process with this id still runs. One the user may not signal still runs. */
export function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

// A log whose tail has no wait event is skipped without being parsed; the tail is bigger than any wait line.
const TAIL_BYTES = 64 * 1024;
const WAIT_LINE = '"kind":"wait"';

async function tailOf(file: string): Promise<string> {
  const handle = await open(file, 'r');
  try {
    const { size } = await handle.stat();
    const length = Math.min(size, TAIL_BYTES);
    const buffer = Buffer.alloc(length);
    await handle.read(buffer, 0, length, size - length);
    return buffer.toString('utf8');
  } finally {
    await handle.close();
  }
}

/** The waiter of the wait the log ends in, if any. */
const openWaiterOf = (events: readonly TurnEvent[]): Waiter | undefined => {
  if (openWaitOf(events) === undefined) return undefined;
  const last = events.findLast((e) => e.kind === 'wait');
  return last?.kind === 'wait' ? last.by : undefined;
};

/**
 * The sessions whose log ends in a wait that an engine serving `cwd` began and that is gone, for this engine to take
 * up. A wait of a live engine stays with it, so two engines on one folder, as after a changed setting, never both run
 * it.
 */
export async function waitsLeft(store: Store, cwd: string, alive: (pid: number) => boolean = pidAlive): Promise<string[]> {
  let names: string[];
  try {
    names = await readdir(store.sessionsDir);
  } catch (error) {
    if (isMissing(error)) return [];
    throw error;
  }
  const left = await Promise.all(
    names
      .filter((name) => name.endsWith('.jsonl'))
      .map(async (name) => {
        const file = path.join(store.sessionsDir, name);
        try {
          if (!(await tailOf(file)).includes(WAIT_LINE)) return [];
          const log = await readSessionLog(file);
          // A subagent's call waits inside its parent's tool call, which a new engine does not run again.
          const start = log.events[0];
          if (start?.kind === 'session-start' && start.child !== undefined) return [];
          const by = openWaiterOf(log.events);
          return by !== undefined && by.cwd === cwd && !alive(by.pid) ? [log.session.id] : [];
        } catch {
          return [];
        }
      }),
  );
  return left.flat();
}
