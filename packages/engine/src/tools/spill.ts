import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { spillEdges, type ToolOutput } from '@g-code/core';

export const spillFile = (spillDir: string, seq: number, tool: string): string =>
  path.join(spillDir, `${seq}-${tool.replace(/[^\w-]/g, '_')}.txt`);

/** Keeps a result of up to `spillChars` characters inline and writes a longer one to `file`, leaving the model its head, tail and path. */
export async function settle(text: string, file: string, spillChars: number): Promise<ToolOutput> {
  if (text.length <= spillChars) return { output: text };
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, text);
  return { spill: { path: file, bytes: Buffer.byteLength(text), ...spillEdges(text) } };
}
