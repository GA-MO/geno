import { readFile, stat } from 'node:fs/promises';
import { z } from 'zod';
import { executor, optional, resolveInside, ToolError } from './context.js';

const lineNumber = z.number().int().positive();

// Git's heuristic: a NUL byte in the first 8000 bytes means binary.
const BINARY_SNIFF = 8000;

export const read = executor({
  input: z.strictObject({
    path: z.string().min(1),
    start_line: optional(lineNumber),
    end_line: optional(lineNumber),
  }),
  describe: ({ path, start_line, end_line }) =>
    start_line === undefined && end_line === undefined ? `read ${path}` : `read ${path}:${start_line ?? 1}-${end_line ?? ''}`,
  async run({ path, start_line, end_line }, ctx) {
    const real = await resolveInside(ctx, path);
    if ((await stat(real)).isDirectory()) throw new ToolError(`${path} is a directory; use list`);
    const bytes = await readFile(real);
    if (bytes.subarray(0, BINARY_SNIFF).includes(0)) throw new ToolError(`${path} is a binary file`);

    const text = bytes.toString('utf8');
    if (text === '') return `${path} is empty`;
    const lines = text.split('\n');
    if (text.endsWith('\n')) lines.pop();
    const total = lines.length;
    const first = start_line ?? 1;
    const last = Math.min(end_line ?? total, total);
    if (first > total) throw new ToolError(`start_line ${first} is past the end of ${path}, which has ${total} lines`);
    if (last < first) throw new ToolError(`end_line ${last} is before start_line ${first}`);

    const width = String(last).length;
    const numbered = lines
      .slice(first - 1, last)
      .map((line, i) => `${String(first + i).padStart(width)}\t${line}`)
      .join('\n');
    return first === 1 && last === total ? numbered : `${numbered}\n[lines ${first}-${last} of ${total}]`;
  },
});
