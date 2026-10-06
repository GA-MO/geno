import type { CheckpointRef } from '@g-code/core';
import { changedFiles } from '../chat/fold.js';
import type { Turn } from '../chat/messages.js';
import { isEdit } from '../chat/rail.js';

export type FileCounts = { readonly path: string; readonly added: number; readonly removed: number };

/**
 * What auto review says under a turn that edited files: the files with their line counts, and the checkpoint its
 * Undo restores. `undone` once every hunk of the turn is, by its Undo or by an earlier turn's.
 */
export type TurnChanges = { readonly files: readonly FileCounts[]; readonly checkpoint: CheckpointRef; readonly undone: boolean };

export function turnChangesOf(turn: Turn): TurnChanges | undefined {
  const edits = turn.blocks.flatMap((block) => (block.kind === 'tool' && isEdit(block) ? [block] : []));
  if (edits.length === 0) return undefined;
  const files = changedFiles(edits);
  return {
    files: files.map(({ path, added, removed }) => ({ path, added, removed })),
    checkpoint: files[0]!.checkpoint,
    undone: edits.every((tool) => tool.diff.hunks.every((hunk) => hunk.status === 'undone')),
  };
}

export const changesLine = (changes: TurnChanges): string => (changes.files.length === 1 ? '1 file changed' : `${changes.files.length} files changed`);
