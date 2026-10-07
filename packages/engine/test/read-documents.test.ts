import { copyFile, mkdir, mkdtemp, readFile, realpath, truncate, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeAll, describe, expect, it } from 'vitest';
import type { ToolUseBlock } from '@anthropic-ai/sdk/resources/messages/messages';
import { imageInfo, MAX_IMAGES, PAGE_MAX_CHARS } from '@g-code/core';
import { DISK_FILES } from '../src/files.js';
import { EXECUTORS, runTool, type ToolContext } from '../src/tools/index.js';
import { OUTPUT_MAX_CHARS } from '../src/tools/notebook.js';
import { MAX_DOCUMENT_BYTES } from '../src/tools/read.js';
import { rgCommand } from './helpers.js';
import { buildPdf } from './pdf-builder.js';

const FIXTURES = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'read');
let ctx: ToolContext;
let ws: string;
let scanJpeg: Uint8Array;

beforeAll(async () => {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), 'gcode-read-docs-')));
  ws = path.join(root, 'ws');
  await mkdir(ws);
  for (const name of ['report.pdf', 'quartz.pdf', 'scan.pdf', 'encrypted.pdf', 'analysis.ipynb']) await copyFile(path.join(FIXTURES, name), path.join(ws, name));
  const report = await readFile(path.join(FIXTURES, 'report.pdf'));
  await writeFile(path.join(ws, 'truncated.pdf'), report.subarray(0, 2000));
  await writeFile(path.join(ws, 'fake.pdf'), 'this is a text file named like a PDF\n');
  const scan = await readFile(path.join(FIXTURES, 'scan.pdf'));
  const start = scan.indexOf(Buffer.from([0xff, 0xd8, 0xff]));
  scanJpeg = scan.subarray(start, scan.indexOf(Buffer.from('endstream'), start) - 1);
  ctx = { workspace: ws, spillDir: path.join(root, 'spill'), readRoots: [], attachmentsDir: path.join(root, 'attachments'), rg: rgCommand(), signal: new AbortController().signal, files: DISK_FILES, events: () => [], earlierCalls: async () => {}, spillChars: 24_000 };
});

let nextId = 0;
const call = (input: Record<string, unknown>) => runTool({ type: 'tool_use', id: `tu_${nextId++}`, name: 'read', input, caller: { type: 'direct' } } as ToolUseBlock, ctx, EXECUTORS);
const failure = (pattern: RegExp) => ({ status: 'error', text: expect.stringMatching(pattern) });
const textOf = async (input: Record<string, unknown>): Promise<string> => {
  const result = await call(input);
  expect(result.status).toBe('ok');
  return result.text;
};

describe('read on a text PDF', () => {
  it('returns every page under a marker and the page count', async () => {
    expect(await call({ path: 'report.pdf' })).toEqual({
      status: 'ok',
      text: [
        'report.pdf is a PDF with 2 pages.',
        '--- page 1 of 2 ---',
        'Quarterly Report',
        'Revenue grew to 4,210 units in the third quarter.',
        'Café naïve “quotes” and the office fine print.',
        '--- page 2 of 2 ---',
        'Appendix',
        'The launch code word is PELICAN-42.',
      ].join('\n'),
    });
  });

  it('returns only the pages a range asks for, and says how to go on', async () => {
    expect(await textOf({ path: 'report.pdf', pages: '2' })).toBe('report.pdf is a PDF with 2 pages.\n--- page 2 of 2 ---\nAppendix\nThe launch code word is PELICAN-42.');
    expect(await textOf({ path: 'quartz.pdf', pages: '1' })).toBe(
      'quartz.pdf is a PDF with 2 pages.\n--- page 1 of 2 ---\nPage one says hello.\nSecond line here.\n1\n[pages 1-1 of 2. Read again with pages="2" to continue.]',
    );
    expect(await textOf({ path: 'quartz.pdf', pages: '1-2' })).toContain('--- page 2 of 2 ---\nPage two mentions ZEBRA-7.');
    expect(await textOf({ path: 'quartz.pdf', pages: '1-30' })).toMatch(/--- page 2 of 2 ---\nPage two mentions ZEBRA-7\.$/);
  });

  it('reads pages packed in a compressed object stream', async () => {
    await writeFile(path.join(ws, 'packed.pdf'), buildPdf([{ text: ['Packed page one'] }, { text: ['Packed page two'] }], { objectStream: true }));
    expect(await textOf({ path: 'packed.pdf' })).toBe('packed.pdf is a PDF with 2 pages.\n--- page 1 of 2 ---\nPacked page one\n--- page 2 of 2 ---\nPacked page two');
  });

  it('returns the first 10 pages by default and refuses more than 20 at once', async () => {
    await writeFile(path.join(ws, 'long.pdf'), buildPdf(Array.from({ length: 25 }, (_, i) => ({ text: [`Body of page ${i + 1}`] }))));
    const first = await textOf({ path: 'long.pdf' });
    expect(first.match(/^--- page \d+ of 25 ---$/gm)).toHaveLength(10);
    expect(first).toMatch(/--- page 10 of 25 ---\nBody of page 10\n\[pages 1-10 of 25\. Read again with pages="11-20" to continue\.\]$/);
    expect(await call({ path: 'long.pdf', pages: '1-21' })).toEqual(failure(/1-21 is 21 pages; one read returns at most 20/));
    expect(await textOf({ path: 'long.pdf', pages: '21-' })).toMatch(/--- page 21 of 25 ---[\s\S]*--- page 25 of 25 ---\nBody of page 25$/);
    expect(await call({ path: 'long.pdf', pages: '26' })).toEqual(failure(/page 26 is past the end of long.pdf, which has 25 pages/));
    expect(await call({ path: 'long.pdf', pages: 'two' })).toEqual(failure(/invalid input[\s\S]*pages/));
  });

  it('treats JavaScript and form fields as data and shows only the page text', async () => {
    const pdf = buildPdf([{ text: ['Visible text'] }], {
      catalog: '/OpenAction 5 0 R /AcroForm << /Fields [6 0 R] >>',
      extra: ["<< /S /JavaScript /JS (app.alert\\('ran'\\); this.submitForm\\('https://example.invalid'\\);) >>", '<< /FT /Tx /T (name) /V (FORM-VALUE) >>'],
    });
    await writeFile(path.join(ws, 'active.pdf'), pdf);
    expect(await textOf({ path: 'active.pdf' })).toBe('active.pdf is a PDF with 1 page.\n--- page 1 of 1 ---\nVisible text');
  });
});

describe('read on a scanned PDF', () => {
  it('returns each page with no text layer as an image', async () => {
    const result = await call({ path: 'scan.pdf' });
    expect(result.status).toBe('ok');
    expect(result.text).toBe(
      [
        'scan.pdf is a PDF with 2 pages.',
        '--- page 1 of 2 ---',
        '[this page has no text layer; it is a scanned image]',
        '[page 1: 400x200 JPEG image (8 KB), attached below as image 1]',
        '--- page 2 of 2 ---',
        '[this page has no text layer; it is a scanned image]',
        '[page 2: 400x200 PNG image (5 KB), attached below as image 2]',
      ].join('\n'),
    );
    const images = 'images' in result ? result.images! : [];
    expect(images.map((image) => [image.mediaType, image.width, image.height])).toEqual([
      ['image/jpeg', 400, 200],
      ['image/png', 400, 200],
    ]);
    const png = await readFile(path.join(ctx.attachmentsDir, `${images[1]!.sha256}.png`));
    expect(imageInfo(png)).toEqual({ mediaType: 'image/png', width: 400, height: 200 });
  });

  it(`returns at most ${MAX_IMAGES} images in one read and names the pages it left out`, async () => {
    await writeFile(path.join(ws, 'scans.pdf'), buildPdf(Array.from({ length: 10 }, () => ({ jpeg: scanJpeg }))));
    const result = await call({ path: 'scans.pdf' });
    expect('images' in result ? result.images : []).toHaveLength(MAX_IMAGES);
    expect(result.text).toContain(`[page 9: image left out; one read returns at most ${MAX_IMAGES} images. Read page 9 on its own to see it.]`);
    expect(result.text).toContain('[page 10: image left out;');
  });
});

describe('read on a PDF it cannot open', () => {
  it('names an encrypted, a damaged and a fake PDF', async () => {
    expect(await call({ path: 'encrypted.pdf' })).toEqual(failure(/^encrypted.pdf is encrypted; read cannot open password-protected PDFs$/));
    expect(await call({ path: 'truncated.pdf' })).toEqual(failure(/^truncated.pdf is damaged: read found no page tree in it$/));
    expect(await call({ path: 'fake.pdf' })).toEqual(failure(/^fake.pdf is not a PDF: it has no %PDF- header$/));
  });

  it('refuses line numbers and a PDF over the size cap', async () => {
    expect(await call({ path: 'report.pdf', start_line: 1 })).toEqual(failure(/is a PDF; pass pages/));
    await writeFile(path.join(ws, 'huge.pdf'), '%PDF-1.7\n');
    await truncate(path.join(ws, 'huge.pdf'), MAX_DOCUMENT_BYTES + 1);
    expect(await call({ path: 'huge.pdf' })).toEqual(failure(/^huge.pdf is a 64.0 MB PDF; read opens PDFs up to 64.0 MB$/));
    expect(await call({ path: 'analysis.ipynb', pages: '1' })).toEqual(failure(/pages is for PDFs/));
  });

  it(`stops at a page boundary before ${PAGE_MAX_CHARS} characters`, async () => {
    const line = 'x'.repeat(90);
    await writeFile(path.join(ws, 'dense.pdf'), buildPdf(Array.from({ length: 10 }, () => ({ text: Array.from({ length: 60 }, () => line) }))));
    const text = await textOf({ path: 'dense.pdf' });
    expect(text.length).toBeLessThanOrEqual(PAGE_MAX_CHARS);
    expect(text).toMatch(/\n\[pages 1-3 of 10\. This read stopped at the 20,000 character limit\. Read again with pages="4-10" to continue\.\]$/);
  });
});

describe('read on a notebook', () => {
  it('returns each cell with its outputs, images as images, and no widget state', async () => {
    const result = await call({ path: 'analysis.ipynb' });
    expect(result.status).toBe('ok');
    expect(result.text).toBe(
      [
        'analysis.ipynb is a python notebook with 5 cells.',
        '--- cell 1 of 5: markdown ---',
        '# Sales analysis',
        'Totals by *region*.',
        '--- cell 2 of 5: code [3] ---',
        'total = sum([1, 2, 3])',
        'print("total is", total)',
        'total * 2',
        '[output 1: stdout]',
        'total is 6',
        '',
        '[output 2: text/plain]',
        '12',
        '--- cell 3 of 5: code [4] ---',
        'plot(regions)',
        '[output 1: image/png: 100x50 PNG image (2 KB), attached below as image 1]',
        '--- cell 4 of 5: code [5] ---',
        'slider',
        '--- cell 5 of 5: code [6] ---',
        '1 / 0',
        '[output 1: error]',
        'ZeroDivisionError: division by zero',
      ].join('\n'),
    );
    expect('images' in result ? result.images!.map((image) => image.mediaType) : []).toEqual(['image/png']);
    expect(result.text).not.toMatch(/WIDGET-STATE-SECRET|IntSlider/);
  });

  it('returns the cells asked for, cuts a long output, and reads raw JSON by line', async () => {
    expect(await textOf({ path: 'analysis.ipynb', cells: '5' })).toBe(
      'analysis.ipynb is a python notebook with 5 cells.\n--- cell 5 of 5: code [6] ---\n1 / 0\n[output 1: error]\nZeroDivisionError: division by zero',
    );
    const noisy = { nbformat: 4, metadata: {}, cells: [{ cell_type: 'code', source: 'spam()', execution_count: 1, outputs: [{ output_type: 'stream', name: 'stdout', text: 'y'.repeat(10_000) }] }] };
    await writeFile(path.join(ws, 'noisy.ipynb'), JSON.stringify(noisy));
    const text = await textOf({ path: 'noisy.ipynb' });
    expect(text).toContain(`${'y'.repeat(OUTPUT_MAX_CHARS)}\n[output cut: it is 10,000 characters; this shows the first 4,000]`);
    expect(text).not.toContain('y'.repeat(OUTPUT_MAX_CHARS + 1));
    expect(await textOf({ path: 'analysis.ipynb', start_line: 1, end_line: 2 })).toBe('1\t{\n2\t "nbformat": 4,\n[lines 1-2 of 126]');
    await writeFile(path.join(ws, 'broken.ipynb'), '{"cells": [');
    expect(await call({ path: 'broken.ipynb' })).toEqual(failure(/^broken.ipynb is not valid JSON/));
  });
});
