import { createHash } from 'node:crypto';
import { access, mkdir, realpath } from 'node:fs/promises';
import path from 'node:path';
import { incrementalTsc } from '@g-code/core';

/** The check after edits: the command the model is shown, the command that runs, and where else it may write. */
export type CheckCommand = { readonly shown: string; readonly run: string; readonly writable: readonly string[] };

/** Where a workspace's check keeps what it learned between runs, under the app home, never in the workspace. */
export const checkCacheDir = (appHome: string, workspace: string): string =>
  path.join(appHome, 'check-cache', createHash('sha256').update(workspace).digest('hex').slice(0, 16));

const exists = (file: string): Promise<boolean> =>
  access(file).then(
    () => true,
    () => false,
  );

/** `command` as it runs in `workspace` (a real path): a plain `tsc --noEmit` becomes incremental, anything else runs as it is. */
export async function checkCommand(command: string | undefined, workspace: string, appHome: string): Promise<CheckCommand | undefined> {
  if (command === undefined) return undefined;
  const cache = checkCacheDir(appHome, workspace);
  const localTsc = await exists(path.join(workspace, 'node_modules', '.bin', 'tsc'));
  const run = incrementalTsc(command, path.join(cache, 'tsbuildinfo'), localTsc);
  if (run === undefined) return { shown: command, run: command, writable: [] };
  await mkdir(cache, { recursive: true });
  // The sandbox matches real paths.
  return { shown: command, run, writable: [await realpath(cache)] };
}
