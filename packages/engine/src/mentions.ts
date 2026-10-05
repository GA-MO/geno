import { realpath } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type * as acp from '@agentclientprotocol/sdk';
import { z } from 'zod';
import { linesOf, numberedPage, SELECTION_LINES_META, type ContextItem, type Mention } from '@g-code/core';
import type { Files } from './files.js';
import type { RuleAttacher } from './tools/rules.js';

/** A prompt block the engine cannot use as a mention, such as an image or a URL that is not a file. */
export class MentionError extends Error {}

const selectionLines = z
  .object({ startLine: z.number().int().positive(), endLine: z.number().int().positive() })
  .refine((lines) => lines.startLine <= lines.endLine, 'startLine must not be after endLine');

function filePath(uri: string): string {
  if (!uri.startsWith('file:')) throw new MentionError(`only file: mentions are supported, not ${uri}`);
  return fileURLToPath(uri.replace(/#.*$/, ''));
}

/** The `@file` and `@selection` mentions among a prompt's blocks, in order. Text blocks are the prompt itself. */
export function mentionsOf(blocks: readonly acp.ContentBlock[]): Mention[] {
  return blocks.flatMap((block): Mention[] => {
    if (block.type === 'text') return [];
    if (block.type === 'resource_link') return [{ kind: 'file', path: filePath(block.uri) }];
    if (block.type === 'resource') {
      const raw = block._meta?.[SELECTION_LINES_META];
      const target = filePath(block.resource.uri);
      if (raw === undefined || !('text' in block.resource)) return [{ kind: 'file', path: target }];
      const lines = selectionLines.safeParse(raw);
      if (!lines.success) throw new MentionError(`${SELECTION_LINES_META}: ${z.prettifyError(lines.error)}`);
      return [{ kind: 'selection', path: target, text: block.resource.text, ...lines.data }];
    }
    throw new MentionError(`a ${block.type} block cannot be attached; mention files or selections`);
  });
}

const inside = (workspace: string, file: string): string | undefined => {
  const relative = path.relative(workspace, file);
  return relative === '' || relative.startsWith('..') || path.isAbsolute(relative) ? undefined : relative.split(path.sep).join('/');
};

const numbered = (text: string, startLine: number): string => {
  const lines = linesOf(text);
  const width = String(startLine + lines.length - 1).length;
  return lines.map((line, i) => `${String(startLine + i).padStart(width)}\t${line}`).join('\n');
};

// The read tool's test: a NUL byte in the first 8000 bytes means binary.
const fileBody = (shown: string, text: string): string =>
  text === '' ? `${shown} is empty` : text.slice(0, 8000).includes('\0') ? `${shown} is a binary file` : numberedPage(linesOf(text), 1, undefined);

/**
 * The prompt's mentions as the model will see them, taken now so the log replays the same bytes: a file as its
 * first page in the buffer bridge's text, a selection as the lines the user saw, and after them each glob rule that
 * a mentioned file matches and the session has not attached yet. A file must be inside the workspace, like a read.
 */
export async function contextItems(mentions: readonly Mention[], workspace: string, files: Files, rules: RuleAttacher): Promise<ContextItem[]> {
  const items: ContextItem[] = [];
  const matched: string[] = [];
  for (const mention of mentions) {
    const real = await realpath(mention.path).catch(() => mention.path);
    const relative = inside(workspace, real);
    if (mention.kind === 'selection') {
      items.push({ ...mention, path: relative ?? real, text: numbered(mention.text, mention.startLine) });
    } else {
      if (relative === undefined) throw new MentionError(`${mention.path} is outside the workspace`);
      const text = await files.read(real);
      if (text === null) throw new MentionError(`no such file: ${relative}`);
      items.push({ kind: 'file', path: relative, text: fileBody(relative, text) });
    }
    if (relative !== undefined) matched.push(relative);
  }
  for (const file of matched) for (const rule of rules.take(file)) items.push({ kind: 'rule', path: rule.path, matched: file, text: rule.text });
  return items;
}
