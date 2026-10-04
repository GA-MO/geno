import { diffLines } from 'diff';

export const HUNK_STATUSES = ['pending', 'kept', 'undone'] as const;
export type HunkStatus = (typeof HUNK_STATUSES)[number];

/** One contiguous change. `startLine` is 1-based in the base text; `lineCount` 0 means a pure insertion before it. */
export type Hunk = {
  readonly startLine: number;
  readonly lineCount: number;
  readonly oldText: string;
  readonly newText: string;
  readonly status: HunkStatus;
};

/** Every edit format resolves to these, so review never depends on how the model phrased the edit. */
export function hunksBetween(base: string, result: string): Hunk[] {
  const hunks: Hunk[] = [];
  let line = 1;
  let open: { startLine: number; lineCount: number; oldText: string; newText: string } | undefined;
  const close = () => {
    if (open !== undefined) hunks.push({ ...open, status: 'pending' });
    open = undefined;
  };
  for (const part of diffLines(base, result)) {
    if (!part.added && !part.removed) {
      close();
      line += part.count;
      continue;
    }
    open ??= { startLine: line, lineCount: 0, oldText: '', newText: '' };
    if (part.removed) {
      open.lineCount += part.count;
      open.oldText += part.value;
      line += part.count;
    } else {
      open.newText += part.value;
    }
  }
  close();
  return hunks;
}
