import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import { formatBytes, linesOf, MAX_MESSAGE_BYTES, numberedPage } from '@g-code/core';
import { AttachmentError, describeImage, storeImage } from '../attachments.js';
import { displayPath, executor, optional, resolveInside, ToolError, type ToolContext, type ToolReply } from './context.js';

const lineNumber = z.number().int().positive();

// Git's heuristic: a NUL byte in the first 8000 bytes means binary.
const BINARY_SNIFF = 8000;

/** Files the read tool returns to the model as images rather than text. */
const IMAGE_EXTENSIONS: ReadonlySet<string> = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp']);

/** An image file as the model sees it: a line saying what it is, and the image itself, stored by its hash for replay. */
async function readImage(ctx: ToolContext, shown: string, real: string, size: number): Promise<ToolReply> {
  if (size > MAX_MESSAGE_BYTES) throw new ToolError(`${shown} is a ${formatBytes(size)} image; read returns images up to ${formatBytes(MAX_MESSAGE_BYTES)}`);
  try {
    const image = await storeImage(ctx.attachmentsDir, await readFile(real), { name: path.basename(real), path: real });
    return { text: describeImage(shown, image), images: [image] };
  } catch (error) {
    if (error instanceof AttachmentError) throw new ToolError(error.message);
    throw error;
  }
}

export const read = executor({
  input: z.strictObject({
    path: z.string().min(1),
    start_line: optional(lineNumber),
    end_line: optional(lineNumber),
  }),
  describe: ({ path, start_line, end_line }) =>
    start_line === undefined && end_line === undefined ? `read ${path}` : `read ${path}:${start_line ?? 1}-${end_line ?? ''}`,
  async run({ path: raw, start_line, end_line }, ctx) {
    const real = await resolveInside(ctx, raw);
    const info = await stat(real);
    if (info.isDirectory()) throw new ToolError(`${raw} is a directory; use list`);
    if (IMAGE_EXTENSIONS.has(path.extname(real).toLowerCase())) return readImage(ctx, displayPath(ctx, real), real, info.size);
    const text = await ctx.files.read(real);
    if (text === null) throw new ToolError(`no such file or directory: ${raw}`);
    if (text.slice(0, BINARY_SNIFF).includes('\0')) throw new ToolError(`${raw} is a binary file`);
    if (text === '') return `${raw} is empty`;
    const lines = linesOf(text);
    const total = lines.length;
    const first = start_line ?? 1;
    const last = Math.min(end_line ?? total, total);
    if (first > total) throw new ToolError(`start_line ${first} is past the end of ${raw}, which has ${total} lines`);
    if (last < first) throw new ToolError(`end_line ${last} is before start_line ${first}`);
    return numberedPage(lines, first, last);
  },
});
