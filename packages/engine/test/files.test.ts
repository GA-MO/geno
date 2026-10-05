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
    const { proposed, change } = await applyEditToFile(DISK_FILES, file, { ...bump, base: baseOf('const a = 0;\n', null) }, null);
    expect(proposed.result).toMatchObject({ kind: 'failed', reason: 'stale-base' });
    expect(await readFile(file, 'utf8')).toBe('const a = 1;\n');
    expect(change).toBeUndefined();
  });

  it('writes the edited text when the base still matches', async () => {
    const file = await fileWith('const a = 1;\n');
    const { proposed, change } = await applyEditToFile(DISK_FILES, file, { ...bump, base: baseOf('const a = 1;\n', null) }, null);
    expect(proposed.result).toEqual({ kind: 'applied' });
    expect(await readFile(file, 'utf8')).toBe('const a = 2;\n');
    expect(change).toEqual({ id: expect.stringMatching(/^[0-9a-f]{16}$/), path: file, hunks: [{ startLine: 1, lineCount: 1, oldText: 'const a = 1;\n', newText: 'const a = 2;\n', status: 'pending' }] });
  });

  it('fails as stale-base, keeping the newer text, when the file changes between resolving the edit and writing it', async () => {
    const file = await fileWith('const a = 1;\n');
    const racing: Files = {
      ...DISK_FILES,
      read: async (f) => {
        const text = await DISK_FILES.read(f);
        await writeFile(f, 'const a = 1; // typed meanwhile\n');
        return text;
      },
    };
    const { proposed, change } = await applyEditToFile(racing, file, { ...bump, base: baseOf('const a = 1;\n', null) }, null);
    expect(proposed.result).toEqual({ kind: 'failed', reason: 'stale-base', detail: 'a.ts changed since it was last read; read it again before editing' });
    expect(proposed.hunks).toEqual([]);
    expect(change).toBeUndefined();
    expect(await readFile(file, 'utf8')).toBe('const a = 1; // typed meanwhile\n');
  });
});
