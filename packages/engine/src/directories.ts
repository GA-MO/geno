import { realpath, stat } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';

/**
 * The variable that adds directories beyond the workspace, which the editor's `gcode.additionalDirectories` sets: a
 * JSON list of paths, each a string, read-only, or `{ "path", "writable" }`.
 */
export const ADDITIONAL_DIRECTORIES_ENV = 'GCODE_ADDITIONAL_DIRECTORIES';
export const ADDITIONAL_DIRECTORIES_SETTING = 'gcode.additionalDirectories';

const settingSchema = z.array(z.union([z.string(), z.strictObject({ path: z.string(), writable: z.boolean().optional() })]));

/**
 * A directory beyond the workspace the session's tools and commands may read, and write when `writable`, and the
 * setting or file that adds it. `path` is as written until `addedDirectories` makes it real.
 */
export type AddedDirectory = { readonly path: string; readonly writable: boolean; readonly source: string };

/** The directories `gcode.additionalDirectories` adds, or a problem that leaves them all out. */
export function settingDirectories(env: Readonly<Record<string, string | undefined>>): { readonly entries: readonly AddedDirectory[]; readonly problem?: string } {
  const raw = env[ADDITIONAL_DIRECTORIES_ENV];
  if (raw === undefined || raw.trim() === '') return { entries: [] };
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch (error) {
    return { entries: [], problem: `${ADDITIONAL_DIRECTORIES_SETTING} is not valid JSON, so it adds no directory: ${(error as Error).message}` };
  }
  const parsed = settingSchema.safeParse(value);
  if (!parsed.success) return { entries: [], problem: `${ADDITIONAL_DIRECTORIES_SETTING} adds no directory: ${z.prettifyError(parsed.error)}` };
  return {
    entries: parsed.data.flatMap((entry) => {
      const { path: given, writable = false } = typeof entry === 'string' ? { path: entry } : entry;
      return given.trim() === '' ? [] : [{ path: given.trim(), writable, source: ADDITIONAL_DIRECTORIES_SETTING }];
    }),
  };
}

/**
 * Each entry's real path, `~/` from the home and a relative one from the workspace, as Claude Code resolves
 * `additionalDirectories`. A path that is no directory is left out with one line through `warn`. An entry named twice
 * is writable when any of its entries is.
 */
export async function addedDirectories(entries: readonly AddedDirectory[], workspace: string, home: string, warn: (line: string) => void): Promise<readonly AddedDirectory[]> {
  const found = new Map<string, AddedDirectory>();
  for (const entry of entries) {
    const given = entry.path === '~' || entry.path.startsWith('~/') ? path.join(home, entry.path.slice(1)) : path.resolve(workspace, entry.path);
    const real = await realpath(given).catch(() => undefined);
    if (real === undefined || !(await stat(real)).isDirectory()) {
      warn(`directories: ${entry.source}: ${entry.path} is not a directory, so it is not added`);
      continue;
    }
    const known = found.get(real);
    found.set(real, { ...entry, path: real, writable: entry.writable || known?.writable === true, source: known?.source ?? entry.source });
  }
  return [...found.values()];
}

/** The directories a session's tools and commands may reach beyond the workspace. */
export type WorkingDirectories = {
  readonly added: readonly AddedDirectory[];
  /** Real paths the read tools and commands may read: the added directories, then those allowed for the session. */
  readable(): readonly string[];
  /** Real paths an edit and a command may write: the added directories marked writable. */
  writable(): readonly string[];
  /** Lets the rest of the session read `directory`, from "Allow this directory for the session". */
  allow(directory: string): void;
};

/** `session` holds the directories allowed for the session, kept by the caller so they outlive one run. */
export function workingDirectories(added: readonly AddedDirectory[], session: Set<string>): WorkingDirectories {
  return {
    added,
    readable: () => [...added.map((dir) => dir.path), ...session],
    writable: () => added.filter((dir) => dir.writable).map((dir) => dir.path),
    allow: (directory) => {
      session.add(directory);
    },
  };
}
