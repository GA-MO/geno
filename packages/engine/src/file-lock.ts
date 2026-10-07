import { mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';

/** A hold lasts as long as a schedule look or a catalog install's write takes, so one this old belongs to an engine that hung. */
const LOCK_STALE_MS = 5 * 60_000;
const LOCK_POLL_MS = 25;

/**
 * Two engines can share one file, as a main checkout's window and a lane's share a workspace's schedule, or two
 * windows share the catalog manifest. Each holds `<file>.lock` through its change, so neither writes over the other's.
 * A lock whose engine is gone is taken over.
 */
export async function holdingLock<T>(file: string, pid: number, alive: (pid: number) => boolean, work: () => Promise<T>): Promise<T> {
  const lock = `${file}.lock`;
  await mkdir(path.dirname(lock), { recursive: true });
  for (;;) {
    try {
      await writeFile(lock, String(pid), { flag: 'wx' });
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    }
    const holder = await Promise.all([readFile(lock, 'utf8'), stat(lock)]).catch(() => undefined);
    if (holder !== undefined) {
      const [text, { mtimeMs }] = holder;
      // An empty lock is one its engine has made and not written yet.
      const gone = text !== '' && !alive(Number(text));
      if (gone || Date.now() - mtimeMs > LOCK_STALE_MS) {
        await rm(lock, { force: true });
        continue;
      }
    }
    await new Promise((resolve) => setTimeout(resolve, LOCK_POLL_MS));
  }
  try {
    return await work();
  } finally {
    await rm(lock, { force: true });
  }
}
