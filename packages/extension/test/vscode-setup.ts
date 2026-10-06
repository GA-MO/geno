import { mkdir, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import { downloadAndUnzipVSCode } from '@vscode/test-electron';
import { cachePath } from './launch.js';

const STALE_MS = 15 * 60_000;

/**
 * Every worktree shares one VS Code download, and two runs unzipping into it at once leave a broken install. So the
 * download happens here, once per run and one run at a time; each test's runTests then finds it in place.
 */
export default async function setup(): Promise<void> {
  await mkdir(cachePath, { recursive: true });
  const lock = path.join(cachePath, '.download-lock');
  for (;;) {
    try {
      await mkdir(lock);
      break;
    } catch {
      const made = await stat(lock).then((s) => s.mtimeMs, () => Date.now());
      if (Date.now() - made > STALE_MS) await rm(lock, { recursive: true, force: true });
      else await new Promise((resolve) => setTimeout(resolve, 1000));
    }
  }
  try {
    await downloadAndUnzipVSCode({ cachePath, ...(process.env['GCODE_VSCODE_VERSION'] ? { version: process.env['GCODE_VSCODE_VERSION'] } : {}) });
  } finally {
    await rm(lock, { recursive: true, force: true });
  }
}
