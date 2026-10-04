import { closestRegion, fileLines, numberLines } from './str-replace.js';
import type { ApplyOutcome } from './types.js';

export type PatchLine = { readonly op: 'keep' | 'remove' | 'add'; readonly text: string };

/** One `@@` section: the lines to find (keep and remove) and what replaces them (keep and add). */
export type PatchChunk = {
  readonly anchor: string | null;
  readonly lines: readonly PatchLine[];
  readonly atEnd: boolean;
};

export type PatchOp =
  | { readonly kind: 'update'; readonly path: string; readonly chunks: readonly PatchChunk[] }
  | { readonly kind: 'add'; readonly path: string; readonly content: string }
  | { readonly kind: 'delete'; readonly path: string };

export type ParsedPatch =
  | { readonly ok: true; readonly ops: readonly PatchOp[] }
  | { readonly ok: false; readonly line: number; readonly message: string };

const BEGIN = '*** Begin Patch';
const END = '*** End Patch';
const END_OF_FILE = '*** End of File';

const HEADERS = {
  update: '*** Update File: ',
  add: '*** Add File: ',
  delete: '*** Delete File: ',
} as const satisfies Record<PatchOp['kind'], string>;

const LINE_OPS: Readonly<Record<string, PatchLine['op']>> = { ' ': 'keep', '-': 'remove', '+': 'add' };

type Header = { readonly kind: PatchOp['kind']; readonly path: string };

function headerOf(line: string): Header | undefined {
  for (const [kind, prefix] of Object.entries(HEADERS) as [PatchOp['kind'], string][]) {
    if (line.startsWith(prefix)) return { kind, path: line.slice(prefix.length).trim() };
  }
  return undefined;
}

class PatchError extends Error {
  constructor(
    readonly line: number,
    message: string,
  ) {
    super(message);
  }
}

/** Parses the V4A envelope used by OpenAI's apply_patch. Errors name the 1-based line of the patch text. */
export function parsePatch(patch: string): ParsedPatch {
  try {
    return { ok: true, ops: parseOps(patch) };
  } catch (error) {
    if (error instanceof PatchError) return { ok: false, line: error.line, message: error.message };
    throw error;
  }
}

function parseOps(patch: string): PatchOp[] {
  const lines = patch.split('\n').map((line) => line.replace(/\r$/, ''));
  let first = lines.findIndex((line) => line.trim() !== '');
  let last = lines.findLastIndex((line) => line.trim() !== '');
  if (first === -1) throw new PatchError(1, 'the patch is empty');
  if (lines[first]!.trim() !== BEGIN) throw new PatchError(first + 1, `the patch must start with "${BEGIN}"`);
  if (lines[last]!.trim() !== END) throw new PatchError(last + 1, `the patch must end with "${END}"`);

  const ops: PatchOp[] = [];
  let i = first + 1;
  while (i < last) {
    const header = headerOf(lines[i]!);
    if (header === undefined) {
      throw new PatchError(i + 1, `expected "${HEADERS.update}", "${HEADERS.add}" or "${HEADERS.delete}" followed by a path`);
    }
    if (header.path === '') throw new PatchError(i + 1, 'the file header has no path');
    const bodyStart = i + 1;
    let end = bodyStart;
    while (end < last && headerOf(lines[end]!) === undefined) end++;
    ops.push(BODY_PARSERS[header.kind](header.path, lines.slice(bodyStart, end), bodyStart + 1));
    i = end;
  }
  if (ops.length === 0) throw new PatchError(first + 1, 'the patch changes no files');
  return ops;
}

const BODY_PARSERS: Record<PatchOp['kind'], (path: string, body: readonly string[], firstLine: number) => PatchOp> = {
  delete(path, body, firstLine) {
    const extra = body.findIndex((line) => line.trim() !== '');
    if (extra !== -1) throw new PatchError(firstLine + extra, 'a Delete File section takes no lines');
    return { kind: 'delete', path };
  },
  add(path, body, firstLine) {
    const lines = body.at(-1) === '' ? body.slice(0, -1) : body;
    const bad = lines.findIndex((line) => !line.startsWith('+'));
    if (bad !== -1) throw new PatchError(firstLine + bad, 'every line of an Add File section starts with +');
    return { kind: 'add', path, content: lines.map((line) => `${line.slice(1)}\n`).join('') };
  },
  update(path, body, firstLine) {
    if (body[0]?.startsWith('*** Move to:')) throw new PatchError(firstLine, 'Move to is not supported; change the file in place');
    const chunks: PatchChunk[] = [];
    let current: { anchor: string | null; lines: PatchLine[]; atEnd: boolean } | undefined;
    // Models often drop the leading space of an empty context line, and leave blank lines before the next
    // header; a bare blank line only counts as context once a later line in the same chunk follows it.
    let blanks = 0;
    const close = () => {
      if (current !== undefined && current.lines.length > 0) chunks.push(current);
      current = undefined;
      blanks = 0;
    };
    body.forEach((line, k) => {
      if (line.startsWith('@@')) {
        close();
        const anchor = line.slice(2).trim();
        current = { anchor: anchor === '' ? null : anchor, lines: [], atEnd: false };
        return;
      }
      current ??= { anchor: null, lines: [], atEnd: false };
      if (line.trim() === END_OF_FILE) {
        current.atEnd = true;
        return;
      }
      if (line === '') {
        blanks++;
        return;
      }
      const op = LINE_OPS[line[0]!];
      if (op === undefined) {
        throw new PatchError(firstLine + k, 'each line of an Update File section starts with a space, -, + or @@');
      }
      for (; blanks > 0; blanks--) current.lines.push({ op: 'keep', text: '' });
      current.lines.push({ op, text: line.slice(1) });
    });
    close();
    if (!chunks.some((chunk) => chunk.lines.some((line) => line.op !== 'keep'))) {
      throw new PatchError(firstLine - 1, `the Update File section for ${path} has no - or + lines`);
    }
    return { kind: 'update', path, chunks };
  },
};

// Tried in order over the whole file, so an exact match anywhere wins over a looser one earlier.
const FUZZ: readonly ((line: string) => string)[] = [(l) => l, (l) => l.trimEnd(), (l) => l.trim()];

function findLines(lines: readonly string[], target: readonly string[], from: number, atEnd: boolean): number {
  for (const fuzz of FUZZ) {
    const matchesAt = (start: number) => target.every((line, k) => fuzz(lines[start + k]!) === fuzz(line));
    if (atEnd) {
      const start = lines.length - target.length;
      if (start >= from && matchesAt(start)) return start;
    }
    for (let start = from; start + target.length <= lines.length; start++) if (matchesAt(start)) return start;
  }
  return -1;
}

type Splice = { readonly start: number; readonly removed: number; readonly inserted: readonly string[] };

/** Applies an Update File section. Context lines keep the file's own text, so a loose match never rewrites them. */
export function applyUpdate(path: string, text: string, chunks: readonly PatchChunk[]): ApplyOutcome {
  const lines = fileLines(text);
  const splices: Splice[] = [];
  let cursor = 0;
  for (const [n, chunk] of chunks.entries()) {
    if (chunk.anchor !== null) {
      const anchorAt = findLines(lines, [chunk.anchor], cursor, false);
      if (anchorAt === -1) {
        return {
          kind: 'failed',
          reason: 'zero-matches',
          detail: `chunk ${n + 1}: the @@ line "${chunk.anchor}" does not appear in ${path} after line ${cursor}. An @@ line names an existing line just above the change, copied exactly.`,
        };
      }
      cursor = anchorAt;
    }
    const target = chunk.lines.filter((line) => line.op !== 'add').map((line) => line.text);
    if (target.length === 0) {
      const at = chunk.anchor === null || chunk.atEnd ? lines.length : cursor + 1;
      splices.push({ start: at, removed: 0, inserted: chunk.lines.map((line) => line.text) });
      cursor = at;
      continue;
    }
    const start = findLines(lines, target, cursor, chunk.atEnd);
    if (start === -1) return missingChunk(path, lines, target, n, cursor);
    const inserted: string[] = [];
    let k = start;
    for (const line of chunk.lines) {
      if (line.op === 'add') inserted.push(line.text);
      else if (line.op === 'keep') inserted.push(lines[k++]!);
      else k++;
    }
    splices.push({ start, removed: target.length, inserted });
    cursor = start + target.length;
  }
  const result = [...lines];
  for (const { start, removed, inserted } of splices.toReversed()) result.splice(start, removed, ...inserted);
  const eol = text === '' || text.endsWith('\n') ? '\n' : '';
  return { kind: 'applied', after: result.length === 0 ? '' : result.join('\n') + eol };
}

function missingChunk(path: string, lines: readonly string[], target: readonly string[], n: number, cursor: number): ApplyOutcome {
  const detail = [`chunk ${n + 1}: its context and - lines do not appear in ${path} after line ${cursor}.`];
  if (lines.length > 0) {
    const { start, end } = closestRegion(lines, target);
    detail.push(`The closest text is lines ${start + 1}-${end}:`, numberLines(lines.slice(start, end), start + 1));
  }
  detail.push('Copy context and - lines exactly from the file, each after its one-character prefix.');
  return { kind: 'failed', reason: 'zero-matches', detail: detail.join('\n') };
}
