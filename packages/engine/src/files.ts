import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { hashText, proposeChange, staleBaseDetail, type BaseRead, type EditFormat, type ProposedChange } from '@g-code/core';
import { isMissing } from './store.js';

export type WriteResult = 'written' | 'stale-base';

/** Where tools read and write file text: the disk, or an editor's buffers over ACP. Paths are absolute. */
export type Files = {
  /** The file's current text, or null when it does not exist. */
  read(file: string): Promise<string | null>;
  /** Writes `text` only while the file still holds the text that hashes to `baseHash` (null: the file is absent). */
  write(file: string, text: string, baseHash: string | null): Promise<WriteResult>;
};

async function readDisk(file: string): Promise<string | null> {
  try {
    return await readFile(file, 'utf8');
  } catch (error) {
    if (isMissing(error)) return null;
    throw error;
  }
}

export const DISK_FILES: Files = {
  read: readDisk,
  async write(file, text, baseHash) {
    if (hashText(await readDisk(file)) !== baseHash) return 'stale-base';
    await mkdir(path.dirname(file), { recursive: true });
    // Through a temporary file, so a crash never leaves half a file.
    const tmp = `${file}.${process.pid}.tmp`;
    await writeFile(tmp, text);
    await rename(tmp, file);
    return 'written';
  },
};

/**
 * Applies a model's edit to a file. Nothing is written unless the file still hashes to `base` and the edit
 * applies, and the write fails as stale-base when the file changes while the edit is resolved.
 */
export async function applyEditToFile(
  files: Files,
  file: string,
  edit: { readonly path: string; readonly format: EditFormat; readonly raw: unknown; readonly base: BaseRead },
  turn: ProposedChange['turn'],
): Promise<ProposedChange> {
  const current = await files.read(file);
  const { change, after } = proposeChange({ ...edit, current, turn });
  if (after === null || (await files.write(file, after, hashText(current))) === 'written') return change;
  return { ...change, hunks: [], result: { kind: 'failed', reason: 'stale-base', detail: staleBaseDetail(edit.path) } };
}
