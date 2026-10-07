import type { ApplyOutcome } from './types.js';

/** Lines numbered the way the read tool numbers them, so a region the model sees here matches what it read. */
export function numberLines(lines: readonly string[], firstLine = 1): string {
  const width = String(firstLine + lines.length - 1).length;
  return lines.map((line, i) => `${String(firstLine + i).padStart(width)}\t${line}`).join('\n');
}

export const fileLines = (text: string): string[] => {
  const lines = text.split('\n');
  if (text.endsWith('\n')) lines.pop();
  return lines;
};

export const normalize = (line: string): string => line.trim();
const indentOf = (line: string): string => /^[ \t]*/.exec(line)![0];
const lineAt = (text: string, offset: number): number => text.slice(0, offset).split('\n').length;

const listLines = (lines: readonly number[]): string =>
  lines.length === 1 ? `line ${lines[0]}` : `lines ${lines.slice(0, -1).join(', ')} and ${lines.at(-1)}`;

function exactStarts(text: string, needle: string): number[] {
  const starts: number[] = [];
  for (let at = text.indexOf(needle); at !== -1; at = text.indexOf(needle, at + needle.length)) starts.push(at);
  return starts;
}

function bigrams(text: string): Map<string, number> {
  const counts = new Map<string, number>();
  for (let i = 0; i < text.length - 1; i++) {
    const pair = text.slice(i, i + 2);
    counts.set(pair, (counts.get(pair) ?? 0) + 1);
  }
  return counts;
}

/** Dice coefficient over character bigrams: 1 for equal lines, near 0 for unrelated ones. */
function similarity(a: string, b: string): number {
  if (a === b) return 1;
  const left = bigrams(a);
  const right = bigrams(b);
  let shared = 0;
  for (const [pair, n] of left) shared += Math.min(n, right.get(pair) ?? 0);
  const total = a.length + b.length - 2;
  return total <= 0 ? 0 : (2 * shared) / total;
}

export function closestRegion(lines: readonly string[], target: readonly string[]): { start: number; end: number } {
  const size = Math.min(target.length, lines.length);
  let best = { start: 0, score: -1 };
  for (let start = 0; start + size <= lines.length; start++) {
    let score = 0;
    for (let k = 0; k < size; k++) score += similarity(normalize(lines[start + k]!), normalize(target[k]!));
    if (score > best.score) best = { start, score };
  }
  return { start: best.start, end: best.start + size };
}

function normalizedStarts(lines: readonly string[], target: readonly string[]): number[] {
  const starts: number[] = [];
  for (let start = 0; start + target.length <= lines.length; start++) {
    if (target.every((line, k) => normalize(lines[start + k]!) === normalize(line))) starts.push(start);
  }
  return starts;
}

// The model's new_str is written in the indentation it used for old_str, so shift it to the file's.
function reindent(newLines: readonly string[], modelIndent: string, fileIndent: string): string[] {
  if (modelIndent === fileIndent) return [...newLines];
  return newLines.map((line) =>
    line.trim() === '' || !line.startsWith(modelIndent) ? line : fileIndent + line.slice(modelIndent.length),
  );
}

function replaceNormalized(
  lines: readonly string[],
  start: number,
  target: readonly string[],
  newStr: string,
  endsWithNewline: boolean,
): string {
  const anchor = target.findIndex((line) => line.trim() !== '');
  const replaced = lines.slice(start, start + target.length);
  const crlf = replaced.some((line) => line.endsWith('\r'));
  const newLines = newStr === '' ? [] : fileLines(newStr).map((line) => line.replace(/\r$/, ''));
  const shifted = reindent(newLines, indentOf(target[anchor]!), indentOf(replaced[anchor]!)).map((line) =>
    crlf ? `${line}\r` : line,
  );
  const result = [...lines.slice(0, start), ...shifted, ...lines.slice(start + target.length)];
  return result.join('\n') + (endsWithNewline && result.length > 0 ? '\n' : '');
}

/**
 * Replaces the one place `oldStr` appears, or with `replaceAll` every place it appears exactly. When it appears
 * nowhere, matches again line by line ignoring indentation, trailing whitespace and CR, and accepts only a single
 * such match.
 */
export function strReplace(path: string, text: string, oldStr: string, newStr: string, replaceAll = false): ApplyOutcome {
  if (oldStr === '') {
    return { kind: 'failed', reason: 'parse-error', detail: 'old_str is empty; copy the exact text to replace from the file' };
  }
  const exact = exactStarts(text, oldStr);
  if (exact.length === 1 || (replaceAll && exact.length > 1)) return { kind: 'applied', after: text.split(oldStr).join(newStr) };
  if (exact.length > 1) return multiple(path, exact.map((at) => lineAt(text, at)), 'exact');

  const lines = fileLines(text);
  const target = fileLines(oldStr);
  if (target.every((line) => line.trim() === '')) return zero(path, lines, target);
  const normalized = normalizedStarts(lines, target);
  if (normalized.length === 1) {
    return { kind: 'applied', after: replaceNormalized(lines, normalized[0]!, target, newStr, text.endsWith('\n')) };
  }
  if (normalized.length > 1) return multiple(path, normalized.map((start) => start + 1), 'normalized');
  // Models resend an edit they already made; when its result is there once and its old text is gone, the
  // file is already in the state the call asks for. A one-line result can be there by chance, so it must not
  // pass a wrong edit off as done.
  const distinctive = newStr.split('\n').filter((line) => line.trim() !== '').length >= 2;
  if (distinctive && exactStarts(text, newStr).length === 1) return { kind: 'applied', after: text };
  return zero(path, lines, target);
}

// replace_all changes exact matches only, so a count that ignored whitespace asks for the exact text first.
const MATCHES = {
  exact: { how: '', all: 'or pass replace_all: true to change every one' },
  normalized: { how: ' when indentation and trailing whitespace are ignored', all: 'or copy it exactly from the file and pass replace_all: true to change every one' },
} as const;

function multiple(path: string, startLines: readonly number[], kind: keyof typeof MATCHES): ApplyOutcome {
  const { how, all } = MATCHES[kind];
  return {
    kind: 'failed',
    reason: 'multiple-matches',
    detail: `old_str appears ${startLines.length} times in ${path}${how}, starting at ${listLines(startLines)}. Include more of the surrounding lines in old_str so it matches exactly one place, ${all}.`,
  };
}

function zero(path: string, lines: readonly string[], target: readonly string[]): ApplyOutcome {
  if (lines.length === 0) {
    return { kind: 'failed', reason: 'zero-matches', detail: `old_str does not appear in ${path}, which is empty.` };
  }
  const { start, end } = closestRegion(lines, target);
  return {
    kind: 'failed',
    reason: 'zero-matches',
    detail: [
      `old_str does not appear in ${path}, even ignoring indentation and trailing whitespace. The closest text is lines ${start + 1}-${end}:`,
      numberLines(lines.slice(start, end), start + 1),
      'Copy old_str exactly from the file, without the line numbers and the tab after them.',
    ].join('\n'),
  };
}
