import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { baseOf } from '@g-code/core';
import { applyEditToFile, DISK_FILES, type Files } from '../src/files.js';

async function fileWith(text: string): Promise<string> {
  const file = path.join(await mkdtemp(path.join(tmpdir(), 'gcode-edit-')), 'a.ts');
  await writeFile(file, text);
  return file;
}

const bump = { path: 'a.ts', format: 'str_replace', raw: { path: 'a.ts', old_str: 'a = 1', new_str: 'a = 2' } } as const;

describe('applyEditToFile', () => {
  it('writes nothing when the file changed since the model read it', async () => {
    const file = await fileWith('const a = 1;\n');
    const change = await applyEditToFile(DISK_FILES, file, { ...bump, base: baseOf('const a = 0;\n', null) }, null);
    expect(change.result).toMatchObject({ kind: 'failed', reason: 'stale-base' });
    expect(await readFile(file, 'utf8')).toBe('const a = 1;\n');
  });

  it('writes the edited text when the base still matches', async () => {
    const file = await fileWith('const a = 1;\n');
    const change = await applyEditToFile(DISK_FILES, file, { ...bump, base: baseOf('const a = 1;\n', null) }, null);
    expect(change.result).toEqual({ kind: 'applied' });
    expect(await readFile(file, 'utf8')).toBe('const a = 2;\n');
  });

  it('fails as stale-base, keeping the newer text, when the file changes between resolving the edit and writing it', async () => {
    const file = await fileWith('const a = 1;\n');
    const racing: Files = {
      read: async (f) => {
        const text = await DISK_FILES.read(f);
        await writeFile(f, 'const a = 1; // typed meanwhile\n');
        return text;
      },
      write: DISK_FILES.write,
    };
    const change = await applyEditToFile(racing, file, { ...bump, base: baseOf('const a = 1;\n', null) }, null);
    expect(change.result).toEqual({ kind: 'failed', reason: 'stale-base', detail: 'a.ts changed since it was last read; read it again before editing' });
    expect(change.hunks).toEqual([]);
    expect(await readFile(file, 'utf8')).toBe('const a = 1; // typed meanwhile\n');
  });
});
