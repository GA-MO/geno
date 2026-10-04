import type { Snippet } from './completion.js';
import { renderEdit, MAX_HISTORY, type EditHistoryEntry } from './history.js';

// A port of Zed's V0318SeedMultiRegions format, which Zeta 2.1 was trained on
// (zed-industries/zed, crates/zeta_prompt/src/zeta_prompt.rs and multi_region.rs).
export const ZETA_TOKENS = {
  bos: '<[begin▁of▁sentence]>',
  suffix: '<[fim-suffix]>',
  prefix: '<[fim-prefix]>',
  middle: '<[fim-middle]>',
  file: '<filename>',
  cursor: '<|user_cursor|>',
} as const;

const markerTag = (n: number): string => `<|marker_${n}|>`;
const MARKER_TAG = /<\|marker_(\d+)\|>/g;

export type NextEditBudget = {
  readonly editableTokens: number;
  readonly contextTokens: number;
  readonly maxTokens: number;
};

export const DEFAULT_NEXT_EDIT_BUDGET: NextEditBudget = { editableTokens: 350, contextTokens: 150, maxTokens: 4096 };

// Zed estimates a token as 3 bytes; this counts UTF-16 code units, the same for ASCII code.
const estimateTokens = (chars: number): number => Math.floor(chars / 3);

const MIN_BLOCK_LINES = 6;
const MAX_BLOCK_LINES = 16;
const MAX_NUDGE_LINES = 5;

type LineInfo = { readonly start: number; readonly blank: boolean; readonly goodStart: boolean };

/** A line that closes a construct makes a poor first line for a block the model may rewrite. */
const isStructuralTail = (trimmed: string): boolean =>
  /^[}\])]/.test(trimmed) || ['break', 'continue', 'return', 'throw', 'end'].includes(trimmed.replace(/;+$/, ''));

function lineInfo(text: string): LineInfo[] {
  const lines: LineInfo[] = [];
  let offset = 0;
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    lines.push({ start: offset, blank: trimmed === '', goodStart: trimmed !== '' && !isStructuralTail(trimmed) });
    offset += line.length + 1;
  }
  if (text.endsWith('\n') && lines.length > 1) lines.pop();
  return lines;
}

/** Offsets in the editable text where markers go: always 0 first and the text's length last. */
export function markerOffsets(text: string): number[] {
  if (text === '') return [0, 0];
  const lines = lineInfo(text);
  const offsets = [0];
  const goodStartFrom = (from: number): number | undefined => {
    for (let i = from; i < Math.min(lines.length, from + MAX_NUDGE_LINES); i++) if (lines[i]!.goodStart) return i;
    return undefined;
  };
  let lastBoundary = 0;
  let i = 0;
  while (i < lines.length) {
    const gap = i - lastBoundary;
    if (gap >= MIN_BLOCK_LINES && !lines[i]!.blank && i > 0 && lines[i - 1]!.blank) {
      const target = lines[i]!.goodStart ? i : (goodStartFrom(i) ?? i);
      if (lines.length - target >= MIN_BLOCK_LINES && lines[target]!.start > offsets.at(-1)!) {
        offsets.push(lines[target]!.start);
        lastBoundary = target;
        i = target + 1;
        continue;
      }
    }
    if (gap >= MAX_BLOCK_LINES) {
      const target = goodStartFrom(i) ?? i;
      if (lines[target]!.start > offsets.at(-1)!) {
        offsets.push(lines[target]!.start);
        lastBoundary = target;
        i = target + 1;
        continue;
      }
    }
    i++;
  }
  if (offsets.at(-1) !== text.length) offsets.push(text.length);
  return offsets;
}

export type Range = { readonly start: number; readonly end: number };

/** Character offsets where each line starts. */
const lineStarts = (text: string): number[] => {
  const starts = [0];
  for (let i = 0; i < text.length; i++) if (text[i] === '\n') starts.push(i + 1);
  return starts;
};

/** Whole rows [startRow, endRow], ending before the last row's newline, as Zed's excerpt ranges do. */
class Rows {
  readonly starts: number[];
  constructor(readonly text: string) {
    this.starts = lineStarts(text);
  }
  get maxRow(): number {
    return this.starts.length - 1;
  }
  rowOf(offset: number): number {
    let row = 0;
    while (row + 1 < this.starts.length && this.starts[row + 1]! <= offset) row++;
    return row;
  }
  end(row: number): number {
    const next = this.starts[row + 1];
    return next === undefined ? this.text.length : next - 1;
  }
  tokens(row: number): number {
    return Math.max(1, estimateTokens(this.end(row) - this.starts[row]!));
  }
  range(startRow: number, endRow: number): Range {
    return { start: this.starts[startRow]!, end: this.end(endRow) };
  }
}

type Span = { start: number; end: number; left: number };

/** Grows the row span a line at a time on each side, up first unless `downFirst`, while lines fit the budget. */
function expandLinewise(rows: Rows, span: Span, downFirst: boolean): Span {
  const next = { ...span };
  const grow = (side: 'up' | 'down'): boolean => {
    const row = side === 'up' ? next.start - 1 : next.end + 1;
    if (row < 0 || row > rows.maxRow || next.left === 0) return false;
    const cost = rows.tokens(row);
    if (cost > next.left) return false;
    next.left -= cost;
    if (side === 'up') next.start = row;
    else next.end = row;
    return true;
  };
  for (;;) {
    const order: ('up' | 'down')[] = downFirst ? ['down', 'up'] : ['up', 'down'];
    const grew = order.map(grow);
    if (!grew.some(Boolean)) return next;
  }
}

/**
 * Zed's editable and context ranges without syntax information: the editable region grows symmetrically from the
 * cursor line on 75% of its budget, then line by line on the rest; the context adds whole lines around it.
 */
export function regionsAround(text: string, cursor: number, budget: NextEditBudget): { editable: Range; context: Range } {
  const rows = new Rows(text);
  const cursorRow = rows.rowOf(cursor);
  const initial = Math.floor((budget.editableTokens * 3) / 4);
  let span: Span = { start: cursorRow, end: cursorRow, left: Math.max(0, initial - rows.tokens(cursorRow)) };
  for (;;) {
    if (span.left === 0) break;
    const down = span.end < rows.maxRow ? rows.tokens(span.end + 1) : undefined;
    if (down !== undefined) {
      if (down > span.left) break;
      span = { ...span, end: span.end + 1, left: span.left - down };
    }
    const up = span.start > 0 && span.left > 0 ? rows.tokens(span.start - 1) : undefined;
    if (up !== undefined) {
      if (up > span.left) break;
      span = { ...span, start: span.start - 1, left: span.left - up };
    }
    if (down === undefined && up === undefined) break;
  }
  span = expandLinewise(rows, { ...span, left: span.left + budget.editableTokens - initial }, false);
  const context = expandLinewise(rows, { start: span.start, end: span.end, left: budget.contextTokens }, false);
  return { editable: rows.range(span.start, span.end), context: rows.range(context.start, context.end) };
}

/** The editable region of the document the model may rewrite, in document offsets. */
export type EditableRegion = Range & { readonly text: string };

export type NextEditInputs = {
  readonly path: string;
  readonly cursor: number;
  readonly region: EditableRegion;
  /** Oldest first, as rendered. */
  readonly history: readonly EditHistoryEntry[];
  readonly related: readonly Snippet[];
};

export type NextEditPrompt = {
  readonly prompt: string;
  readonly inputs: NextEditInputs;
  readonly tokens: number;
};

/** The excerpt around the cursor, already cut: `editable` and `cursor` are offsets into `context`. */
export type CursorExcerpt = {
  readonly path: string;
  readonly context: string;
  readonly editable: Range;
  readonly cursor: number;
};

function cursorSection(excerpt: CursorExcerpt): string {
  const { context, editable } = excerpt;
  const text = context.slice(editable.start, editable.end);
  const cursor = excerpt.cursor - editable.start;
  const offsets = markerOffsets(text);
  let section = `${ZETA_TOKENS.file}${excerpt.path}\n${context.slice(0, editable.start)}`;
  let placed = false;
  offsets.forEach((offset, i) => {
    section += markerTag(i + 1);
    const next = offsets[i + 1];
    if (next === undefined) return;
    const block = text.slice(offset, next);
    if (!placed && cursor >= offset && cursor <= next) {
      placed = true;
      section += block.slice(0, cursor - offset) + ZETA_TOKENS.cursor + block.slice(cursor - offset);
    } else {
      section += block;
    }
  });
  return section.endsWith('\n') ? section : `${section}\n`;
}

const withNewline = (text: string): string => (text.endsWith('\n') ? text : `${text}\n`);

/** Newest edits first while they fit, at most MAX_HISTORY, rendered oldest first. */
function historySection(history: readonly EditHistoryEntry[], budget: number): EditHistoryEntry[] {
  const header = `${ZETA_TOKENS.file}edit_history\n`;
  let used = estimateTokens(header.length);
  if (used >= budget) return [];
  const kept: EditHistoryEntry[] = [];
  for (const entry of history.toReversed().slice(0, MAX_HISTORY)) {
    const cost = estimateTokens(renderEvent(entry).length);
    if (used + cost > budget) break;
    used += cost;
    kept.unshift(entry);
  }
  return kept;
}

const renderEvent = (entry: EditHistoryEntry): string => `--- a/${entry.path}\n+++ b/${entry.path}\n${renderEdit(entry)}`;

/**
 * Related files in order until the budget runs out. Zed's related files are already excerpts; open tabs are whole
 * files, so each is cut to the lines from its top that fit, marked with `...` where lines were left out.
 */
function relatedSection(related: readonly Snippet[], budget: number): Snippet[] {
  let left = budget;
  const kept: Snippet[] = [];
  for (const snippet of related) {
    const header = estimateTokens(`${ZETA_TOKENS.file}${snippet.path}\n`.length);
    const lines = withNewline(snippet.text).split('\n').slice(0, -1);
    let text = '';
    let cut = false;
    for (const line of lines) {
      if (estimateTokens(text.length + line.length + 1 + '...\n'.length) + header > left) {
        cut = true;
        break;
      }
      text += `${line}\n`;
    }
    if (text === '') break;
    if (cut) text += '...\n';
    kept.push({ path: snippet.path, text });
    left -= header + estimateTokens(text.length);
  }
  return kept;
}

/** Lays out a cut excerpt exactly as Zed does for V0318: suffix, then related files, history and the cursor file. */
export function formatNextEditPrompt(
  excerpt: CursorExcerpt,
  history: readonly EditHistoryEntry[],
  related: readonly Snippet[],
  maxTokens: number,
): { prompt: string; history: EditHistoryEntry[]; related: Snippet[] } {
  const suffix = withNewline(`${ZETA_TOKENS.suffix}${excerpt.context.slice(excerpt.editable.end)}`);
  const cursor = cursorSection(excerpt);
  const budget = Math.floor(maxTokens * 0.9);
  const afterCursor = Math.max(
    0,
    budget -
      estimateTokens(suffix.length + ZETA_TOKENS.prefix.length) -
      estimateTokens(cursor.length + ZETA_TOKENS.middle.length),
  );
  const kept = historySection(history, afterCursor);
  const historyText =
    kept.length === 0 ? '' : `${ZETA_TOKENS.file}edit_history\n${kept.map(renderEvent).join('')}`;
  const afterHistory = Math.max(0, afterCursor - estimateTokens(historyText.length + 1));
  const files = relatedSection(related, afterHistory);
  const relatedText = files.map((f) => `${ZETA_TOKENS.file}${f.path}\n${f.text}`).join('');
  const prompt =
    suffix +
    ZETA_TOKENS.prefix +
    (relatedText === '' ? '' : `${relatedText}\n`) +
    (historyText === '' ? '' : `${historyText}\n`) +
    cursor +
    ZETA_TOKENS.middle;
  return { prompt, history: kept, related: files };
}

export type NextEditDocument = { readonly path: string; readonly text: string };

export function buildNextEditPrompt(
  history: readonly EditHistoryEntry[],
  document: NextEditDocument,
  cursor: number,
  related: readonly Snippet[],
  budget: NextEditBudget = DEFAULT_NEXT_EDIT_BUDGET,
): NextEditPrompt {
  const { editable, context } = regionsAround(document.text, cursor, budget);
  const excerpt: CursorExcerpt = {
    path: document.path,
    context: document.text.slice(context.start, context.end),
    editable: { start: editable.start - context.start, end: editable.end - context.start },
    cursor: cursor - context.start,
  };
  const formatted = formatNextEditPrompt(excerpt, history, related, budget.maxTokens);
  return {
    prompt: formatted.prompt,
    tokens: estimateTokens(formatted.prompt.length),
    inputs: {
      path: document.path,
      cursor,
      region: { ...editable, text: document.text.slice(editable.start, editable.end) },
      history: formatted.history,
      related: formatted.related,
    },
  };
}

/** A predicted edit in document offsets: replace [start, end) with `text`. */
export type PredictedEdit = Range & { readonly text: string };

export type NextEdit =
  | ({ readonly kind: 'edit' } & PredictedEdit)
  | { readonly kind: 'none'; readonly reason: 'unchanged' | 'malformed' };

/**
 * Reads Zeta's reply: the region between its first and last marker tags is rewritten with the text between them.
 * A repeated marker means no edit. The result is trimmed to the smallest change.
 */
export function parseNextEdit(output: string, region: EditableRegion): NextEdit {
  const text = output.replaceAll(ZETA_TOKENS.cursor, '');
  const tags = [...text.matchAll(MARKER_TAG)].map((m) => ({
    n: Number(m[1]),
    start: m.index,
    end: m.index + m[0].length,
  }));
  if (tags.length < 2) return { kind: 'none', reason: 'malformed' };
  const first = tags[0]!;
  const last = tags.at(-1)!;
  if (first.n === last.n) return { kind: 'none', reason: 'unchanged' };
  const offsets = markerOffsets(region.text);
  const from = offsets[first.n - 1];
  const to = offsets[last.n - 1];
  if (from === undefined || to === undefined || from > to) return { kind: 'none', reason: 'malformed' };
  const replacement = tags
    .slice(0, -1)
    .map((tag, i) => text.slice(tag.end, tags[i + 1]!.start))
    .join('');
  const old = region.text.slice(from, to);
  let head = 0;
  while (head < old.length && head < replacement.length && old[head] === replacement[head]) head++;
  let tail = 0;
  while (
    tail < old.length - head &&
    tail < replacement.length - head &&
    old[old.length - 1 - tail] === replacement[replacement.length - 1 - tail]
  ) {
    tail++;
  }
  if (head === old.length && head === replacement.length) return { kind: 'none', reason: 'unchanged' };
  return {
    kind: 'edit',
    start: region.start + from + head,
    end: region.start + to - tail,
    text: replacement.slice(head, replacement.length - tail),
  };
}

/** The document with the edit applied. */
export const applyEdit = (text: string, edit: PredictedEdit): string =>
  text.slice(0, edit.start) + edit.text + text.slice(edit.end);
