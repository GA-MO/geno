import { stat } from 'node:fs/promises';
import { z } from 'zod';
import { ALWAYS, displayPath, executor, optional, resolveInside, ToolError } from './context.js';
import { ripgrep } from './ripgrep.js';

const DEFAULT_DEPTH = 2;

/** Files and directories down to `depth`, from file paths relative to the listed directory. */
export function listEntries(files: readonly string[], depth: number): string[] {
  const filesBelow = new Map<string, number>();
  const entries = new Set<string>();
  for (const file of files) {
    const parts = file.split('/');
    for (let level = 1; level < Math.min(parts.length, depth + 1); level++) {
      entries.add(`${parts.slice(0, level).join('/')}/`);
    }
    if (parts.length <= depth) entries.add(file);
    else {
      const cut = `${parts.slice(0, depth).join('/')}/`;
      filesBelow.set(cut, (filesBelow.get(cut) ?? 0) + 1);
    }
  }
  return [...entries].sort().map((entry) => {
    const count = filesBelow.get(entry);
    return count === undefined ? entry : `${entry} (${count} ${count === 1 ? 'file' : 'files'})`;
  });
}

export const list = executor({
  concurrent: ALWAYS,
  input: z.strictObject({
    // A model may send an empty string to mean the root.
    directory: optional(z.string()).transform((dir) => dir || '.'),
    depth: optional(z.number().int().positive()),
  }),
  describe: ({ directory, depth }) => `list ${directory}${depth === undefined ? '' : ` depth=${depth}`}`,
  async run({ directory, depth = DEFAULT_DEPTH }, ctx) {
    const real = await resolveInside(ctx, directory);
    if (!(await stat(real)).isDirectory()) throw new ToolError(`${directory} is not a directory; use read`);
    const files = await ripgrep(ctx, real, ['--files', '--sort=path']);
    const shown = displayPath(ctx, real);
    const prefix = shown === '.' ? '' : `${shown}/`;
    const entries = listEntries(files, depth).map((entry) => prefix + entry);
    return entries.length === 0 ? `${shown} has no files` : entries.join('\n');
  },
});
