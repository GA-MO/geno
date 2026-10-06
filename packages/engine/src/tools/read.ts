import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import { BINARY_SNIFF, formatBytes, linesOf, MAX_MESSAGE_BYTES, numberedPage } from '@g-code/core';
import { AttachmentError, describeImage, storeImage } from '../attachments.js';
import { ALWAYS, displayPath, executor, optional, resolveInside, ToolError, type ToolContext, type ToolReply } from './context.js';
import { NotebookError, parseNotebook } from './notebook.js';
import { openPdf, PdfError, type PdfPage } from './pdf.js';
import { readSections, type Section } from './sections.js';

const lineNumber = z.number().int().positive();
const RANGE = /^\s*(\d+)\s*(?:-\s*(\d*)\s*)?$/;
const range = z.string().regex(RANGE, 'a number such as "3" or a range such as "1-5"');

const IMAGE_EXTENSIONS: ReadonlySet<string> = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp']);

/** The largest PDF or notebook read opens. Both are parsed whole in memory. */
export const MAX_DOCUMENT_BYTES = 64 * 1024 * 1024;
export const PDF_DEFAULT_PAGES = 10;
export const PDF_MAX_PAGES = 20;

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

/** The 1-based inclusive range a `pages` or `cells` value names, clamped to the file, or a ToolError. */
function pick(raw: string | undefined, total: number, unit: string, shown: string, fallback: number, max: number): { first: number; last: number } {
  if (raw === undefined) return { first: 1, last: Math.min(total, fallback) };
  const [, a, b] = RANGE.exec(raw)!;
  const first = Number(a);
  const asked = b === undefined ? first : b === '' ? first + max - 1 : Number(b);
  if (first < 1) throw new ToolError(`${unit}s count from 1`);
  if (asked < first) throw new ToolError(`${raw} ends before it starts`);
  if (first > total) throw new ToolError(`${unit} ${first} is past the end of ${shown}, which has ${total} ${unit}${total === 1 ? '' : 's'}`);
  if (b !== '' && asked - first + 1 > max) throw new ToolError(`${raw} is ${asked - first + 1} ${unit}s; one read returns at most ${max}. Ask for ${first}-${first + max - 1}, then go on from there`);
  return { first, last: Math.min(asked, total, first + max - 1) };
}

function pdfSection(page: PdfPage, number: number, total: number): Section {
  const heading = `page ${number} of ${total}`;
  switch (page.kind) {
    case 'text':
      return { heading, parts: [{ kind: 'text', text: page.text }] };
    case 'scan':
      return { heading, parts: [{ kind: 'text', text: '[this page has no text layer; it is a scanned image]' }, { kind: 'image', bytes: page.image, label: `page ${number}` }] };
    case 'unreadable':
      return { heading, parts: [{ kind: 'text', text: `[read cannot show this page: ${page.reason}]` }] };
    case 'blank':
      return { heading, parts: [{ kind: 'text', text: '[this page has no text and no images]' }] };
  }
}

async function readPdf(ctx: ToolContext, shown: string, real: string, size: number, pages: string | undefined): Promise<ToolReply> {
  if (size > MAX_DOCUMENT_BYTES) throw new ToolError(`${shown} is a ${formatBytes(size)} PDF; read opens PDFs up to ${formatBytes(MAX_DOCUMENT_BYTES)}`);
  let doc;
  try {
    doc = openPdf(await readFile(real));
  } catch (error) {
    if (error instanceof PdfError) throw new ToolError(`${shown} ${error.message}`);
    throw error;
  }
  const { first, last } = pick(pages, doc.pageCount, 'page', shown, PDF_DEFAULT_PAGES, PDF_MAX_PAGES);
  const total = doc.pageCount;
  return readSections(ctx, {
    intro: `${shown} is a PDF with ${total} page${total === 1 ? '' : 's'}.`,
    unit: 'page',
    field: 'pages',
    first,
    last,
    total,
    span: PDF_DEFAULT_PAGES,
    origin: real,
    section: (number) => pdfSection(doc.page(number), number, total),
  });
}

async function readNotebook(ctx: ToolContext, shown: string, real: string, size: number, cells: string | undefined): Promise<ToolReply> {
  if (size > MAX_DOCUMENT_BYTES) throw new ToolError(`${shown} is a ${formatBytes(size)} notebook; read opens notebooks up to ${formatBytes(MAX_DOCUMENT_BYTES)}`);
  const text = await ctx.files.read(real);
  if (text === null) throw new ToolError(`no such file or directory: ${shown}`);
  let notebook;
  try {
    notebook = parseNotebook(text);
  } catch (error) {
    if (error instanceof NotebookError) throw new ToolError(`${shown} ${error.message}`);
    throw error;
  }
  const total = notebook.cells.length;
  if (total === 0) return `${shown} is a notebook with no cells`;
  const { first, last } = pick(cells, total, 'cell', shown, total, total);
  return readSections(ctx, {
    intro: `${shown} is a ${notebook.language === undefined ? '' : `${notebook.language} `}notebook with ${total} cell${total === 1 ? '' : 's'}.`,
    unit: 'cell',
    field: 'cells',
    first,
    last,
    total,
    span: total,
    origin: real,
    section: (number) => notebook.cells[number - 1]!,
  });
}

export const read = executor({
  concurrent: ALWAYS,
  input: z.strictObject({
    path: z.string().min(1),
    start_line: optional(lineNumber),
    end_line: optional(lineNumber),
    pages: optional(range),
    cells: optional(range),
  }),
  describe: ({ path, start_line, end_line, pages, cells }) =>
    pages !== undefined ? `read ${path} pages ${pages}`
    : cells !== undefined ? `read ${path} cells ${cells}`
    : start_line === undefined && end_line === undefined ? `read ${path}`
    : `read ${path}:${start_line ?? 1}-${end_line ?? ''}`,
  async run({ path: raw, start_line, end_line, pages, cells }, ctx) {
    const real = await resolveInside(ctx, raw);
    const info = await stat(real);
    if (info.isDirectory()) throw new ToolError(`${raw} is a directory; use list`);
    const extension = path.extname(real).toLowerCase();
    const lines = start_line !== undefined || end_line !== undefined;
    if (pages !== undefined && extension !== '.pdf') throw new ToolError(`pages is for PDFs; ${raw} is not one`);
    if (cells !== undefined && extension !== '.ipynb') throw new ToolError(`cells is for Jupyter notebooks; ${raw} is not one`);
    if (IMAGE_EXTENSIONS.has(extension)) return readImage(ctx, displayPath(ctx, real), real, info.size);
    if (extension === '.pdf') {
      if (lines) throw new ToolError(`${raw} is a PDF; pass pages, such as "1-5", instead of start_line and end_line`);
      return readPdf(ctx, displayPath(ctx, real), real, info.size, pages);
    }
    if (extension === '.ipynb' && !lines) return readNotebook(ctx, displayPath(ctx, real), real, info.size, cells);
    const text = await ctx.files.read(real);
    if (text === null) throw new ToolError(`no such file or directory: ${raw}`);
    if (text.slice(0, BINARY_SNIFF).includes('\0')) throw new ToolError(`${raw} is a binary file`);
    if (text === '') return `${raw} is empty`;
    const all = linesOf(text);
    const total = all.length;
    const first = start_line ?? 1;
    const last = Math.min(end_line ?? total, total);
    if (first > total) throw new ToolError(`start_line ${first} is past the end of ${raw}, which has ${total} lines`);
    if (last < first) throw new ToolError(`end_line ${last} is before start_line ${first}`);
    return numberedPage(all, first, last);
  },
});
