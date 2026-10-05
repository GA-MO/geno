import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import {
  changeOf,
  hashText,
  proposeChange,
  staleBaseDetail,
  type BaseRead,
  type EditFormat,
  type FileChange,
  type ProposedChange,
} from '@g-code/core';
import { isMissing } from './store.js';

export type WriteResult = 'written' | 'stale-base';

/** Text open in the editor that differs from the disk. */
export type UnsavedBuffer = { readonly path: string; readonly text: string };

/** Where tools read and write file text: the disk, or an editor's buffers over ACP. Paths are absolute. */
export type Files = {
  /** The file's current text, or null when it does not exist. */
  read(file: string): Promise<string | null>;
  /** Writes `text` only while the file still holds the text that hashes to `baseHash` (null: the file is absent). */
  write(file: string, text: string, baseHash: string | null): Promise<WriteResult>;
  /** Every buffer with unsaved edits, so searches see what the user sees; the disk has none. */
  unsaved(): Promise<readonly UnsavedBuffer[]>;
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
  unsaved: async () => [],
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

/** The edit record, and the change as it landed when the file was written. */
export type AppliedEdit = { readonly proposed: ProposedChange; readonly change: FileChange | undefined };

/**
 * Applies a model's edit to a file. Nothing is written unless the file still hashes to `base` and the edit
 * applies, and the write fails as stale-base when the file changes while the edit is resolved.
 */
export async function applyEditToFile(
  files: Files,
  file: string,
  edit: { readonly path: string; readonly format: EditFormat; readonly raw: unknown; readonly base: BaseRead },
  turn: ProposedChange['turn'],
): Promise<AppliedEdit> {
  const current = await files.read(file);
  const { change: proposed, after } = proposeChange({ ...edit, current, turn });
  if (after === null) return { proposed, change: undefined };
  if ((await files.write(file, after, hashText(current))) === 'written') {
    return { proposed, change: changeOf(file, current ?? '', after) };
  }
  const stale: ProposedChange = { ...proposed, hunks: [], result: { kind: 'failed', reason: 'stale-base', detail: staleBaseDetail(edit.path) } };
  return { proposed: stale, change: undefined };
}
