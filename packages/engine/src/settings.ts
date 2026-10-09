import path from 'node:path';
import { z } from 'zod';
import {
  APPROVAL_MODES,
  byPrecedence,
  EFFORTS,
  EXTERNAL_BACKEND_IDS,
  LEGACY_SETTINGS_FILE,
  SEED_IDS,
  settingsFiles,
  type ConfigHomes,
  type SettingsFile,
} from '@g-code/core';
import { readJson } from './plugins.js';

/**
 * One schema for every settings file the config roots name (docs/config.md): Claude Code's keys, which Geno reads from
 * any vendor's file, and Geno's own, which it reads only from its own files.
 */

/** Claude Code's keys that Geno reads; `$schema` only points an editor at a schema. */
const SHARED_KEYS: ReadonlySet<string> = new Set(['permissions', 'hooks', 'enabledPlugins', '$schema']);

const commandList = z.union([z.string().min(1).transform((one) => [one]), z.array(z.string().min(1))]);

const variantSchema = z.strictObject({
  seed: z.enum(SEED_IDS as [string, ...string[]]).default('plain'),
  model: z.string().min(1).nullable().default(null),
  effort: z.enum(EFFORTS).nullable().default(null),
  backend: z.enum(EXTERNAL_BACKEND_IDS).optional(),
});

/**
 * Geno's own keys. A key with `user: false` belongs to a project's files alone: laneSetup runs outside the sandbox in
 * every lane of the repository, which the user approves once per repository.
 */
const GENO_KEYS = {
  check: { schema: z.string().min(1), user: true },
  agentTool: { schema: z.array(z.enum(APPROVAL_MODES)), user: true },
  appendSystemPrompt: { schema: z.string().min(1), user: true },
  arena: {
    schema: z.strictObject({ variety: z.enum(['seeds', 'effort', 'models']).optional(), models: z.array(z.string().min(1)).optional(), variants: z.array(variantSchema).optional() }),
    user: true,
  },
  laneSetup: { schema: commandList, user: false },
} as const satisfies Readonly<Record<string, { readonly schema: z.ZodType; readonly user: boolean }>>;

export type GenoKey = keyof typeof GENO_KEYS;
export type GenoSetting<K extends GenoKey> = { readonly value: z.output<(typeof GENO_KEYS)[K]['schema']>; readonly source: SettingsFile };
/** Each key from the file that wins it: a project-local file over a project-shared one over the user's. */
export type GenoSettings = { readonly [K in GenoKey]?: GenoSetting<K> };

export type LoadedSettings = { readonly source: SettingsFile; readonly value: Readonly<Record<string, unknown>> };

export type SettingsRead = {
  /** The files that exist and parse, in `settingsFiles` order. */
  readonly files: readonly LoadedSettings[];
  /** Files that exist but are not JSON; each reader says what it skips. */
  readonly broken: readonly { readonly source: SettingsFile; readonly reason: string }[];
  readonly geno: GenoSettings;
  /** At most one line per file about what Geno ignores in it, and one about `.gcode.json` beside its successor. */
  readonly notes: readonly string[];
};

const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> => typeof value === 'object' && value !== null && !Array.isArray(value);
const isGenoKey = (key: string): key is GenoKey => Object.hasOwn(GENO_KEYS, key);

/** A settings file as the user reads it: workspace-relative, under `~/`, or absolute. */
export const settingsLabel =
  (workspace: string, home: string | undefined) =>
  (file: string): string => {
    if (file.startsWith(`${workspace}${path.sep}`)) return path.relative(workspace, file);
    return home !== undefined && file.startsWith(`${home}${path.sep}`) ? `~/${path.relative(home, file)}` : file;
  };

const genoFileFor = (source: SettingsFile): string => (source.scope === 'user' ? '~/.g-code/settings.json' : '.g-code/settings.json');

export async function readSettings(sources: readonly SettingsFile[], shown: (file: string) => string): Promise<SettingsRead> {
  const files: LoadedSettings[] = [];
  const broken: { source: SettingsFile; reason: string }[] = [];
  const notes: string[] = [];
  const candidates = new Map<GenoKey, { readonly source: SettingsFile; readonly value: unknown }[]>();
  for (const source of sources) {
    const raw = await readJson(source.file);
    if (raw.kind === 'missing') continue;
    if (raw.kind === 'broken') {
      broken.push({ source, reason: raw.reason });
      continue;
    }
    if (!isRecord(raw.value)) {
      notes.push(`${shown(source.file)}: Geno ignores the file, which is not a JSON object`);
      continue;
    }
    files.push({ source, value: raw.value });
    const ignored: string[] = [];
    for (const [key, given] of Object.entries(raw.value)) {
      if (SHARED_KEYS.has(key)) continue;
      // Claude Code has many keys Geno has no use for, and its files are Claude Code's to check.
      if (!isGenoKey(key)) {
        if (source.vendor !== 'claude') ignored.push(`${key}, which it does not know`);
        continue;
      }
      if (source.vendor !== 'geno') ignored.push(`${key}, which it reads only from ${genoFileFor(source)}`);
      else if (source.scope === 'user' && !GENO_KEYS[key].user) ignored.push(`${key}, which only a project's .g-code/settings.json may set`);
      else {
        const parsed = GENO_KEYS[key].schema.safeParse(given);
        if (parsed.success) candidates.set(key, [...(candidates.get(key) ?? []), { source, value: parsed.data }]);
        else ignored.push(`${key}, which is not valid: ${z.prettifyError(parsed.error).replace(/\n/g, ' ')}`);
      }
    }
    if (ignored.length > 0) notes.push(`${shown(source.file)}: Geno ignores ${ignored.join('; ')}`);
  }
  const geno: Partial<Record<GenoKey, { readonly source: SettingsFile; readonly value: unknown }>> = {};
  for (const [key, given] of candidates) geno[key] = byPrecedence(given).at(-1)!;
  const shared = files.filter(({ source }) => source.vendor === 'geno' && source.scope === 'project-shared');
  if (shared.length === 2) notes.push(`${LEGACY_SETTINGS_FILE} is read beneath .g-code/settings.json, whose keys win; move its keys there`);
  return { files, broken, geno: geno as GenoSettings, notes };
}

/** Geno's own keys for a run in `workspace`, with every file the config roots name. */
export const genoSettings = async (homes: ConfigHomes, workspace: string): Promise<SettingsRead> => readSettings(settingsFiles(homes, workspace), settingsLabel(workspace, homes.user));
