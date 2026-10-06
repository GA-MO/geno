import { constants } from 'node:fs';
import { access } from 'node:fs/promises';
import path from 'node:path';

// Homebrew's directories come first: VS Code started from the Dock may see a PATH without them.
const WELL_KNOWN_DIRS = ['/opt/homebrew/bin', '/usr/local/bin'];

/** The first executable called `name` in Homebrew's directories, then on PATH, then in `extraDirs`. */
export async function findExecutable(name: string, env: Readonly<Record<string, string | undefined>>, extraDirs: readonly string[] = []): Promise<string | undefined> {
  const dirs = [...WELL_KNOWN_DIRS, ...(env['PATH'] ?? '').split(path.delimiter).filter(Boolean), ...extraDirs];
  for (const dir of dirs) {
    const candidate = path.join(dir, name);
    if (await access(candidate, constants.X_OK).then(() => true, () => false)) return candidate;
  }
  return undefined;
}
