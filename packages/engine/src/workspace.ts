import { realpath, stat } from 'node:fs/promises';
import path from 'node:path';
import { EngineError } from './errors.js';
import { isMissing } from './store.js';

export async function workspaceDir(cwd: string, raw: string): Promise<string> {
  try {
    const real = await realpath(path.resolve(cwd, raw));
    if ((await stat(real)).isDirectory()) return real;
  } catch (error) {
    if (!isMissing(error)) throw error;
  }
  throw new EngineError(`workspace ${raw} is not a directory`);
}
