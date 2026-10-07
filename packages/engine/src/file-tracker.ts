import { readFile, stat } from 'node:fs/promises';
import { changedExcerpt, hashText, MAX_TRACKED_BYTES, trackedFiles, type DiskState, type FileStamp, type TurnEvent } from '@g-code/core';
import { isMissing } from './store.js';

/** What the disk says of a file without reading it. */
export type DiskStat = { readonly size: number; readonly mtimeMs: number };

/**
 * A tracked file that changed on disk: how the disk has it now, or null when it is gone or too large to track, and its
 * changed lines when the text the model knew is still remembered.
 */
export type DiskChange = { readonly path: string; readonly now: DiskState | null; readonly excerpt?: string | undefined };

/**
 * Texts the model was shown or wrote, by hash, so a change on disk can be shown as the lines that changed. Keyed by
 * content, so the sessions of one engine process share it; past the limit the least recently stored go first.
 */
const REMEMBERED_CHARS = 16 * 1024 * 1024;
const remembered = new Map<string, string>();
let rememberedChars = 0;

function remember(hash: string, text: string): void {
  if (remembered.delete(hash)) rememberedChars -= text.length;
  remembered.set(hash, text);
  rememberedChars += text.length;
  for (const [oldest, gone] of remembered) {
    if (rememberedChars <= REMEMBERED_CHARS) break;
    remembered.delete(oldest);
    rememberedChars -= gone.length;
  }
}

export async function diskStat(file: string): Promise<DiskStat | undefined> {
  try {
    const { size, mtimeMs } = await stat(file);
    return { size, mtimeMs };
  } catch (error) {
    if (isMissing(error)) return undefined;
    throw error;
  }
}

/**
 * What the model knows of a file after a tool showed or wrote `text`. `before` is the disk's stat taken before the text
 * was read, so a change that lands after the stat shows up as a new change time. None for a file not on disk or too
 * large to track.
 */
export function stampOf(path: string, text: string | null, before: DiskStat | undefined): FileStamp | undefined {
  if (text === null || before === undefined || before.size > MAX_TRACKED_BYTES) return undefined;
  const hash = hashText(text)!;
  remember(hash, text);
  return { path, hash, ...before };
}

/** The file's text, null when it is gone, or undefined when it cannot be read now, which is not a change to report. */
async function diskText(file: string): Promise<string | null | undefined> {
  try {
    return await readFile(file, 'utf8');
  } catch (error) {
    return isMissing(error) ? null : undefined;
  }
}

const sameStat = (a: DiskStat, b: DiskStat): boolean => a.size === b.size && a.mtimeMs === b.mtimeMs;

/**
 * The tracked files whose text on disk is no longer what the model knows. A file whose size and change time are as
 * the model learned them is not read. `verified` remembers a file read again whose text had not changed, such as one
 * saved without edits, so it is not read again until its stat moves.
 */
export async function changedOnDisk(events: readonly TurnEvent[], verified: Map<string, DiskState>): Promise<DiskChange[]> {
  const changes: DiskChange[] = [];
  for (const [path, known] of trackedFiles(events)) {
    const now = await diskStat(path).catch(() => null);
    if (now === null) continue;
    if (now === undefined) {
      changes.push({ path, now: null });
      continue;
    }
    const checked = verified.get(path);
    if (sameStat(now, known) || (checked?.hash === known.hash && sameStat(now, checked))) continue;
    if (now.size > MAX_TRACKED_BYTES) {
      changes.push({ path, now: null });
      continue;
    }
    const text = await diskText(path);
    if (text === undefined) continue;
    if (text === null) {
      changes.push({ path, now: null });
      continue;
    }
    const hash = hashText(text)!;
    if (hash === known.hash) {
      verified.set(path, { hash, ...now });
      continue;
    }
    const seen = remembered.get(known.hash);
    remember(hash, text);
    changes.push({ path, now: { hash, ...now }, ...(seen === undefined ? {} : { excerpt: changedExcerpt(seen, text) }) });
  }
  return changes;
}
