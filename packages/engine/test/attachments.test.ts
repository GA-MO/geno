import { mkdir, mkdtemp, readdir, readFile, realpath, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type * as acp from '@agentclientprotocol/sdk';
import { describe, expect, it } from 'vitest';
import { ATTACHMENT_META, MAX_MESSAGE_BYTES, type TurnEvent } from '@g-code/core';
import { incomingAttachments, loadAttachments, storeAttachments, storeFile, storeImage } from '../src/attachments.js';
import { DISK_FILES } from '../src/files.js';
import { EXECUTORS, runTool, type ToolContext } from '../src/tools/index.js';
import { twoColorPng } from '../../core/test/png.js';
import { rgCommand } from './helpers.js';

const temp = async (name: string) => realpath(await mkdtemp(path.join(tmpdir(), `gcode-${name}-`)));
const RED_BLUE = twoColorPng(8, 4, [255, 0, 0], [0, 0, 255]);
const imageBlock = (bytes: Uint8Array, name: string): acp.ContentBlock => ({
  type: 'image',
  data: Buffer.from(bytes).toString('base64'),
  mimeType: 'image/png',
  _meta: { [ATTACHMENT_META]: { name } },
});

describe('the attachments store', () => {
  it('writes an image once under its hash, and storing it again changes nothing', async () => {
    const dir = path.join(await temp('attach'), 'attachments');
    const image = await storeImage(dir, RED_BLUE, { name: 'flag.png' });
    expect(image).toEqual({ kind: 'image', sha256: expect.stringMatching(/^[0-9a-f]{64}$/), name: 'flag.png', bytes: RED_BLUE.length, mediaType: 'image/png', width: 8, height: 4 });
    const file = path.join(dir, `${image.sha256}.png`);
    const before = await stat(file);
    expect(await storeImage(dir, RED_BLUE, { name: 'again.png', path: '/tmp/again.png' })).toEqual({ ...image, name: 'again.png', path: '/tmp/again.png' });
    expect((await stat(file)).mtimeMs).toBe(before.mtimeMs);
    expect(await readdir(dir)).toEqual([`${image.sha256}.png`]);
    expect(Buffer.compare(await readFile(file), RED_BLUE)).toBe(0);
  });

  it('refuses bytes that are not an image the model reads, whatever the name says', async () => {
    const dir = await temp('attach');
    await expect(storeImage(dir, Buffer.from('not an image'), { name: 'fake.png' })).rejects.toThrow('fake.png is not a PNG, JPEG, GIF or WebP image');
  });

  it('loads what a session references, base64 for images and text for files, and leaves out what is gone', async () => {
    const dir = await temp('attach');
    const image = await storeImage(dir, RED_BLUE, { name: 'flag.png' });
    const file = await storeFile(dir, 'hello\n', { name: 'notes.md', mediaType: 'text/markdown' });
    const gone = { ...image, sha256: 'f'.repeat(64) } as typeof image;
    const events: TurnEvent[] = [{ kind: 'user', seq: 1, at: '2026-10-05T00:00:00.000Z', content: 'see', attachments: [image, file, gone] }];
    const loaded = await loadAttachments(dir, events);
    expect([...loaded]).toEqual([
      [image.sha256, RED_BLUE.toString('base64')],
      [file.sha256, 'hello\n'],
    ]);
  });
});

describe('prompt attachments', () => {
  it('takes image blocks and marked text resources, in order, and stores them', async () => {
    const dir = await temp('attach');
    const incoming = incomingAttachments([
      { type: 'text', text: 'what are these?' },
      imageBlock(RED_BLUE, 'flag.png'),
      { type: 'resource', resource: { uri: 'file:///work/notes.md', text: '# Notes\n', mimeType: 'text/markdown' }, _meta: { [ATTACHMENT_META]: { name: 'notes.md' } } },
      { type: 'resource_link', uri: 'file:///work/a.ts', name: 'a.ts' },
    ]);
    const stored = await storeAttachments(dir, incoming);
    expect(stored).toEqual([
      expect.objectContaining({ kind: 'image', name: 'flag.png', width: 8, height: 4 }),
      expect.objectContaining({ kind: 'file', name: 'notes.md', path: '/work/notes.md', mediaType: 'text/markdown', bytes: 8 }),
    ]);
  });

  it('refuses a ninth image, a message past 5 MB, and a binary file', () => {
    const nine = Array.from({ length: 9 }, (_, i) => imageBlock(RED_BLUE, `${i}.png`));
    expect(() => incomingAttachments(nine)).toThrow('A message holds up to 8 images.');
    const big = (name: string): acp.ContentBlock => ({
      type: 'resource',
      resource: { uri: `file:///work/${name}`, text: 'x'.repeat(MAX_MESSAGE_BYTES / 2) },
      _meta: { [ATTACHMENT_META]: {} },
    });
    expect(() => incomingAttachments([big('a.txt'), big('b.txt'), imageBlock(RED_BLUE, 'c.png')])).toThrow(/a message holds up to 5.0 MB of attachments/);
    const blob: acp.ContentBlock = { type: 'resource', resource: { uri: 'file:///work/app.zip', blob: 'UEsDBA==' }, _meta: { [ATTACHMENT_META]: {} } };
    expect(() => incomingAttachments([blob])).toThrow('app.zip is a binary file; attach an image or a text file');
  });
});

describe('read of an image', () => {
  it('returns a small PNG as an image beside a line of text, and a .ts file as text', async () => {
    const root = await temp('read-image');
    const ws = path.join(root, 'ws');
    await mkdir(ws);
    await writeFile(path.join(ws, 'flag.png'), RED_BLUE);
    await writeFile(path.join(ws, 'fake.png'), 'just text\n');
    await writeFile(path.join(ws, 'a.ts'), 'export const a = 1;\n');
    const ctx: ToolContext = {
      workspace: ws,
      spillDir: path.join(root, 'spill'),
      attachmentsDir: path.join(root, 'attachments'),
      rg: rgCommand(),
      signal: new AbortController().signal,
      files: DISK_FILES,
      events: () => [],
    };
    const read = (file: string) => runTool({ type: 'tool_use', id: 'tu', name: 'read', input: { path: file }, caller: { type: 'direct' } }, ctx, EXECUTORS);

    const image = await read('flag.png');
    expect(image).toEqual({
      status: 'ok',
      text: `flag.png is a 8x4 PNG image (${RED_BLUE.length} B), attached below.`,
      images: [expect.objectContaining({ kind: 'image', name: 'flag.png', path: path.join(ws, 'flag.png'), width: 8, height: 4 })],
    });
    expect(await readdir(ctx.attachmentsDir)).toEqual([`${image.images![0]!.sha256}.png`]);
    expect(await read('a.ts')).toEqual({ status: 'ok', text: '1\texport const a = 1;' });
    expect(await read('fake.png')).toEqual({ status: 'error', text: 'fake.png is not a PNG, JPEG, GIF or WebP image' });
  });
});
