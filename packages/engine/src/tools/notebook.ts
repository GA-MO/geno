import { randomUUID } from 'node:crypto';
import type { CellType } from '@g-code/core';
import { z } from 'zod';
import type { Section, SectionPart } from './sections.js';

/** The most characters of one cell output that read shows; the rest is cut with a note. */
export const OUTPUT_MAX_CHARS = 4_000;

const multiline = z.union([z.string(), z.array(z.string())]).transform((value) => (typeof value === 'string' ? value : value.join('')));
const mimeBundle = z.record(z.string(), z.unknown());

const output = z.discriminatedUnion('output_type', [
  z.looseObject({ output_type: z.literal('stream'), name: z.string().optional(), text: multiline }),
  z.looseObject({ output_type: z.literal('execute_result'), data: mimeBundle }),
  z.looseObject({ output_type: z.literal('display_data'), data: mimeBundle }),
  z.looseObject({ output_type: z.literal('error'), ename: z.string(), evalue: z.string(), traceback: z.array(z.string()).optional() }),
]);
type Output = z.infer<typeof output>;

const notebookSchema = z.looseObject({
  metadata: z.looseObject({ language_info: z.looseObject({ name: z.string() }).optional(), kernelspec: z.looseObject({ language: z.string().optional() }).optional() }).optional(),
  cells: z.array(
    z.looseObject({
      id: z.string().optional(),
      cell_type: z.string(),
      source: multiline,
      execution_count: z.number().nullable().optional(),
      outputs: z.array(z.unknown()).optional(),
    }),
  ),
});

export type Notebook = { readonly language: string | undefined; readonly cells: readonly Section[] };

const WIDGET_VIEW = 'application/vnd.jupyter.widget-view+json';
const IMAGE_TYPES = ['image/png', 'image/jpeg', 'image/gif', 'image/webp'] as const;
const TEXT_TYPES = ['text/plain', 'text/markdown', 'text/latex', 'application/json', 'text/html', 'image/svg+xml'] as const;
const ANSI = /\x1b\[[0-9;?]*[A-Za-z]/g;

const capped = (text: string): string =>
  text.length <= OUTPUT_MAX_CHARS ? text : `${text.slice(0, OUTPUT_MAX_CHARS)}\n[output cut: it is ${text.length.toLocaleString('en-US')} characters; this shows the first ${OUTPUT_MAX_CHARS.toLocaleString('en-US')}]`;

const asText = (value: unknown): string | undefined =>
  typeof value === 'string' ? value : Array.isArray(value) && value.every((v) => typeof v === 'string') ? value.join('') : value === undefined ? undefined : JSON.stringify(value, null, 1);

function outputParts(raw: unknown, number: number): SectionPart[] {
  const parsed = output.safeParse(raw);
  if (!parsed.success) return [{ kind: 'text', text: `[output ${number}: not a Jupyter output read understands]` }];
  const out: Output = parsed.data;
  if (out.output_type === 'stream') return [{ kind: 'text', text: `[output ${number}: ${out.name ?? 'stream'}]\n${capped(out.text.replace(ANSI, ''))}` }];
  if (out.output_type === 'error') {
    const trace = (out.traceback ?? []).join('\n').replace(ANSI, '');
    return [{ kind: 'text', text: `[output ${number}: error]\n${capped(trace === '' ? `${out.ename}: ${out.evalue}` : trace)}` }];
  }
  if (WIDGET_VIEW in out.data) return [];
  const image = IMAGE_TYPES.find((type) => typeof out.data[type] === 'string' || Array.isArray(out.data[type]));
  if (image !== undefined) {
    const base64 = asText(out.data[image])!.replace(/\s/g, '');
    return [{ kind: 'image', bytes: Uint8Array.from(Buffer.from(base64, 'base64')), label: `output ${number}: ${image}` }];
  }
  const type = TEXT_TYPES.find((t) => t in out.data);
  if (type === undefined) return [{ kind: 'text', text: `[output ${number}: ${Object.keys(out.data).join(', ') || 'empty'}, which read does not show]` }];
  return [{ kind: 'text', text: `[output ${number}: ${type}]\n${capped(asText(out.data[type]) ?? '')}` }];
}

/** A notebook's cells as read shows them. Cell and notebook metadata, widget state among it, is left out. */
export function parseNotebook(json: string): Notebook {
  let data: unknown;
  try {
    data = JSON.parse(json);
  } catch {
    throw new NotebookError('is not valid JSON, so read cannot show it as a notebook; pass start_line to read it as text');
  }
  const parsed = notebookSchema.safeParse(data);
  if (!parsed.success) throw new NotebookError('is not a Jupyter notebook in nbformat 4; pass start_line to read it as text');
  const { metadata, cells } = parsed.data;
  return {
    language: metadata?.language_info?.name ?? metadata?.kernelspec?.language,
    cells: cells.map((cell, index) => {
      const count = cell.cell_type === 'code' && typeof cell.execution_count === 'number' ? ` [${cell.execution_count}]` : '';
      const parts: SectionPart[] = [{ kind: 'text', text: cell.source }];
      (cell.outputs ?? []).forEach((raw, i) => parts.push(...outputParts(raw, i + 1)));
      return { heading: `cell ${index + 1} of ${cells.length}, id ${cell.id ?? fallbackId(index)}: ${cell.cell_type}${count}`, parts };
    }),
  };
}

export class NotebookError extends Error {}

/** What read shows as the id of a cell the file gives none, as Claude Code does: its place, counted from 0. */
const fallbackId = (index: number): string => `cell-${index}`;
const FALLBACK_ID = /^cell-(\d+)$/;

export type CellEdit =
  | { readonly mode: 'replace'; readonly cellId: string; readonly source: string; readonly cellType: CellType | undefined }
  | { readonly mode: 'insert'; readonly after: string | undefined; readonly source: string; readonly cellType: CellType }
  | { readonly mode: 'delete'; readonly cellId: string };

/** The notebook's new text, and the cell the edit made, changed or removed: the id read shows, its place and its type. */
export type CellEdited = {
  readonly text: string;
  readonly id: string;
  readonly index: number;
  readonly cells: number;
  readonly cellType: string;
  /** Some cell has no id, so read shows ids by place, and an insert or a delete moves the ones after it. */
  readonly byPlace: boolean;
};

type Cell = Readonly<Record<string, unknown>>;

const editableSchema = z.looseObject({ nbformat: z.number(), nbformat_minor: z.number(), cells: z.array(z.looseObject({ cell_type: z.string(), id: z.string().optional() })) });

type Span = { readonly start: number; readonly end: number };
/** Where the cells array and each cell sit in the file's text, so an edit rewrites only the bytes of one cell. */
type Layout = { readonly open: number; readonly close: number; readonly cells: readonly Span[] };

const skipSpace = (text: string, at: number): number => {
  let i = at;
  while (i < text.length && /\s/.test(text[i]!)) i++;
  return i;
};

function skipString(text: string, at: number): number {
  for (let i = at + 1; i < text.length; i++) {
    if (text[i] === '\\') i++;
    else if (text[i] === '"') return i + 1;
  }
  return text.length;
}

function skipValue(text: string, at: number): number {
  const first = text[at];
  if (first === '"') return skipString(text, at);
  if (first !== '{' && first !== '[') {
    let i = at;
    while (i < text.length && !/[\s,\]}]/.test(text[i]!)) i++;
    return i;
  }
  let depth = 0;
  for (let i = at; i < text.length; i++) {
    const c = text[i];
    if (c === '"') i = skipString(text, i) - 1;
    else if (c === '{' || c === '[') depth++;
    else if ((c === '}' || c === ']') && --depth === 0) return i + 1;
  }
  return text.length;
}

/** The layout of text that JSON.parse already accepted as an object with a cells array. */
function layoutOf(text: string): Layout {
  let i = skipSpace(text, text.indexOf('{') + 1);
  while (text[i] === '"') {
    const keyEnd = skipString(text, i);
    const value = skipSpace(text, skipSpace(text, keyEnd) + 1);
    if (JSON.parse(text.slice(i, keyEnd)) === 'cells') {
      const cells: Span[] = [];
      let at = skipSpace(text, value + 1);
      while (text[at] !== ']') {
        const end = skipValue(text, at);
        cells.push({ start: at, end });
        at = skipSpace(text, end);
        if (text[at] === ',') at = skipSpace(text, at + 1);
      }
      return { open: value, close: at, cells };
    }
    i = skipSpace(text, skipValue(text, value));
    if (text[i] === ',') i = skipSpace(text, i + 1);
  }
  throw new NotebookError('has no cells array');
}

/** One level of the file's indentation, or undefined for a file on one line. */
function indentOf(text: string): string | undefined {
  const lead = /^\s*\{(\s*)"/.exec(text)?.[1] ?? '';
  return lead.includes('\n') ? lead.slice(lead.lastIndexOf('\n') + 1) : undefined;
}

const lineStart = (text: string, at: number): string => text.slice(text.lastIndexOf('\n', at - 1) + 1, at);

/** A source as nbformat writes it, a list of lines that keep their newlines, unless the file writes sources as strings. */
const sourceOf = (source: string, asString: boolean): string | string[] => (asString ? source : source === '' ? [] : source.split(/(?<=\n)/));

const isSorted = (keys: readonly string[]): boolean => keys.every((key, i) => i === 0 || keys[i - 1]! <= key);
const sortedKeys = (cell: Cell): Cell => Object.fromEntries(Object.keys(cell).toSorted().map((key) => [key, cell[key]]));

/** A replaced cell, its other fields kept in their order. Only a code cell has outputs and an execution count. */
function replacedCell(cell: Cell, source: string | string[], cellType: string): Cell {
  const next: Record<string, unknown> = { ...cell, cell_type: cellType, source };
  if (cellType === 'code') {
    delete next['attachments'];
    next['execution_count'] = null;
    next['outputs'] = [];
  } else {
    delete next['execution_count'];
    delete next['outputs'];
  }
  return isSorted(Object.keys(cell)) ? sortedKeys(next) : next;
}

/** A new cell as nbformat makes one, with an id only from nbformat 4.5, which added cell ids. */
const newCell = (cellType: CellType, source: string | string[], id: string | undefined): Cell =>
  sortedKeys({ cell_type: cellType, ...(id === undefined ? {} : { id }), metadata: {}, source, ...(cellType === 'code' ? { execution_count: null, outputs: [] } : {}) });

/** nbformat's own form of a new id: 8 hex characters, unique in the notebook. */
export function randomCellId(taken: ReadonlySet<string>): string {
  for (;;) {
    const id = randomUUID().replace(/-/g, '').slice(0, 8);
    if (!taken.has(id)) return id;
  }
}

/**
 * Applies one cell edit to a notebook's text. Only the edited cell's bytes change: an inserted or deleted cell takes or
 * gives back the separator its neighbours use, and a written cell is indented as the file is.
 */
export function editNotebook(text: string, edit: CellEdit, newId: (taken: ReadonlySet<string>) => string = randomCellId): CellEdited {
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    throw new NotebookError('is not valid JSON, so it cannot be edited as a notebook; read it with start_line and fix it with edit');
  }
  const parsed = editableSchema.safeParse(data);
  if (!parsed.success) throw new NotebookError('is not a Jupyter notebook in nbformat 4');
  const { nbformat, nbformat_minor: minor } = parsed.data;
  // zod puts the fields it names first, so the cells come from the parsed JSON, in the file's key order.
  const cells = (data as { readonly cells: readonly Cell[] }).cells;
  if (nbformat !== 4) throw new NotebookError(`is in nbformat ${nbformat}; notebook_edit edits nbformat 4 notebooks`);
  const ids = parsed.data.cells.map((cell, index) => cell.id ?? fallbackId(index));
  const typeAt = (index: number): string => parsed.data.cells[index]!.cell_type;
  const byPlace = parsed.data.cells.some((cell) => cell.id === undefined);
  const indexOf = (cellId: string): number => {
    const named = ids.indexOf(cellId);
    if (named >= 0) return named;
    const place = FALLBACK_ID.exec(cellId);
    const index = place === null ? -1 : Number(place[1]);
    if (index >= 0 && index < cells.length) return index;
    throw new NotebookError(`has no cell with id ${cellId}; its cells are ${ids.join(', ') || 'none'}`);
  };

  const { open, close, cells: spans } = layoutOf(text);
  const unit = indentOf(text);
  const cellIndent = spans.length > 0 ? lineStart(text, spans[0]!.start) : (unit ?? '').repeat(2);
  const written = (cell: Cell): string => (unit === undefined ? JSON.stringify(cell) : JSON.stringify(cell, null, unit).replace(/\n/g, `\n${cellIndent}`));
  const splice = (from: number, to: number, insert: string): string => `${text.slice(0, from)}${insert}${text.slice(to)}`;

  if (edit.mode === 'replace') {
    const index = indexOf(edit.cellId);
    const cell = cells[index]!;
    const cellType = edit.cellType ?? typeAt(index);
    const next = replacedCell(cell, sourceOf(edit.source, typeof cell['source'] === 'string'), cellType);
    return { text: splice(spans[index]!.start, spans[index]!.end, written(next)), id: ids[index]!, index, cells: cells.length, cellType, byPlace };
  }

  if (edit.mode === 'delete') {
    const index = indexOf(edit.cellId);
    const out =
      spans.length === 1 ? splice(open + 1, close, '')
      : index < spans.length - 1 ? splice(spans[index]!.start, spans[index + 1]!.start, '')
      : splice(spans[index - 1]!.end, spans[index]!.end, '');
    return { text: out, id: ids[index]!, index, cells: cells.length - 1, cellType: typeAt(index), byPlace };
  }

  const index = edit.after === undefined ? 0 : indexOf(edit.after) + 1;
  const id = minor >= 5 ? newId(new Set(ids)) : undefined;
  const cell = written(newCell(edit.cellType, sourceOf(edit.source, typeof cells[0]?.['source'] === 'string'), id));
  const separator = spans.length >= 2 ? text.slice(spans[0]!.end, spans[1]!.start) : unit === undefined ? ',' : `,\n${cellIndent}`;
  const out =
    spans.length === 0 ? splice(open + 1, close, unit === undefined ? cell : `\n${cellIndent}${cell}\n${unit}`)
    : index === 0 ? splice(spans[0]!.start, spans[0]!.start, `${cell}${separator}`)
    : splice(spans[index - 1]!.end, spans[index - 1]!.end, `${separator}${cell}`);
  return { text: out, id: id ?? fallbackId(index), index, cells: cells.length + 1, cellType: edit.cellType, byPlace: byPlace || id === undefined };
}
