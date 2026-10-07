import { createHash } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { CatalogIndex, CatalogKind } from '@g-code/core';

/** One entry of a fake catalog: its files as text, and what the index claims about them when that differs. */
export type FakeEntry = {
  readonly kind: CatalogKind;
  readonly name: string;
  readonly description: string;
  readonly version?: string;
  readonly files: Readonly<Record<string, string>>;
  /** Index lines that lie: a path's listed text, whose hash the index carries instead of the file's own. */
  readonly listedAs?: Readonly<Record<string, string>>;
  /** Paths the index lists without a file in the folder, such as a symlink the test makes itself. */
  readonly unwritten?: readonly string[];
};

const sha = (text: string) => createHash('sha256').update(text).digest('hex');

/** Writes a local catalog folder: each entry's files under `<name>/`, and `catalog.json` with their hashes. */
export async function writeCatalog(dir: string, entries: readonly FakeEntry[], name = 'Team skills'): Promise<CatalogIndex> {
  const index: CatalogIndex = {
    version: 1,
    name,
    entries: entries.map((entry) => ({
      kind: entry.kind,
      name: entry.name,
      description: entry.description,
      version: entry.version ?? '1.0.0',
      files: Object.entries(entry.files).map(([file, text]) => {
        const listed = entry.listedAs?.[file] ?? text;
        return { path: file, url: `${entry.name}/${file}`, sha256: sha(listed), size: Buffer.byteLength(listed) };
      }),
    })),
  };
  for (const entry of entries) {
    for (const [file, text] of Object.entries(entry.files)) {
      if (entry.unwritten?.includes(file)) continue;
      const target = path.join(dir, entry.name, ...file.split('/'));
      await mkdir(path.dirname(target), { recursive: true });
      await writeFile(target, text);
    }
  }
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, 'catalog.json'), `${JSON.stringify(index, null, 2)}\n`);
  return index;
}
