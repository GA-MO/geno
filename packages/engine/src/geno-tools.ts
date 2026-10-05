import { randomUUID } from 'node:crypto';
import { mkdir, readFile, realpath, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { GENO_TOOLS } from './geno-tools.generated.js';

/**
 * Writes docs/geno-tools.md, embedded in the bundle, to `<home>/geno-tools.md` when it is missing or stale, and
 * returns its real path for the read tools. The rename keeps a concurrent session from reading half a file.
 */
export async function writeGenoTools(home: string): Promise<string> {
  const file = path.join(home, 'geno-tools.md');
  if ((await readFile(file, 'utf8').catch(() => undefined)) !== GENO_TOOLS) {
    await mkdir(home, { recursive: true });
    const temp = `${file}.${randomUUID()}.tmp`;
    await writeFile(temp, GENO_TOOLS);
    await rename(temp, file);
  }
  return realpath(file);
}
