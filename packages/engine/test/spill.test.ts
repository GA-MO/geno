import { mkdir, mkdtemp, readFile, realpath, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import type { ToolUseBlock } from '@anthropic-ai/sdk/resources/messages/messages';
import { SPILL_EDGE, spillNotice } from '@g-code/core';
import { DISK_FILES } from '../src/files.js';
import { EXECUTORS, runTool, type ToolContext } from '../src/tools/index.js';
import { settle, spillFile } from '../src/tools/spill.js';
import { rgCommand } from './helpers.js';

const use = (name: string, input: unknown): ToolUseBlock => ({ type: 'tool_use', id: 'tu_1', name, input, caller: { type: 'direct' } });

describe('output spill', () => {
  it('spills a 100 KB grep result, shows head, tail and path, and the spill file reads back in ranges', async () => {
    const root = await realpath(await mkdtemp(path.join(tmpdir(), 'gcode-spill-')));
    const ws = path.join(root, 'ws');
    await mkdir(ws);
    const lines = Array.from({ length: 2000 }, (_, i) => `const NEEDLE_${String(i).padStart(4, '0')} = 'padding padding padding';`);
    await writeFile(path.join(ws, 'big.ts'), `${lines.join('\n')}\n`);
    const ctx: ToolContext = { workspace: ws, spillDir: path.join(root, 'spill', 's1'), readRoots: [], credentialPlaces: [], attachmentsDir: path.join(root, 'spill', 's1', 'attachments'), rg: rgCommand(), signal: new AbortController().signal, files: DISK_FILES, events: () => [], earlierCalls: async () => {}, spillChars: 24_000 };

    const result = await runTool(use('grep', { pattern: 'NEEDLE_' }), ctx, EXECUTORS);
    expect(result.status).toBe('ok');
    expect(result.text.length).toBeGreaterThan(100_000);

    const file = spillFile(ctx.spillDir, 7, 'grep');
    const output = await settle(result.text, file, 24_000);
    if (!('spill' in output)) throw new Error('expected a spill');
    expect(output.spill).toEqual({
      path: path.join(root, 'spill', 's1', '7-grep.txt'),
      bytes: Buffer.byteLength(result.text),
      head: result.text.slice(0, SPILL_EDGE),
      tail: result.text.slice(-SPILL_EDGE),
    });
    expect(await readFile(file, 'utf8')).toBe(result.text);

    const visible = spillNotice(output.spill);
    expect(visible).toContain(file);
    expect(visible).toContain(`${output.spill.bytes} bytes`);
    expect(visible).toContain("big.ts:1:const NEEDLE_0000 = 'padding padding padding';");
    expect(visible).toContain("big.ts:2000:const NEEDLE_1999 = 'padding padding padding';");
    expect(visible).not.toContain('NEEDLE_1000');
    expect(visible.length).toBeLessThan(2 * SPILL_EDGE + 500);

    expect(await runTool(use('read', { path: file, start_line: 1001, end_line: 1001 }), ctx, EXECUTORS)).toEqual({
      status: 'ok',
      text: "1001\tbig.ts:1001:const NEEDLE_1000 = 'padding padding padding';\n[lines 1001-1001 of 2000]",
    });
  });

  it("keeps a result at the model's spill limit inline, and spills one character more", async () => {
    const root = await realpath(await mkdtemp(path.join(tmpdir(), 'gcode-spill-')));
    expect(await settle('x'.repeat(500), '/nonexistent/never-written.txt', 500)).toEqual({ output: 'x'.repeat(500) });
    expect(await settle('x'.repeat(501), path.join(root, 'over.txt'), 500)).toHaveProperty('spill.bytes', 501);
  });
});
