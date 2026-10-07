import { readFile, realpath, stat } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import { isMissing } from './store.js';

/**
 * Claude Code plugins the user installed, read in place from `~/.claude/plugins/installed_plugins.json`. Geno only
 * reads them: their skills join the slash commands, and their folders become read-only roots for the read tools.
 */

/**
 * `root` is a real path, so the read tools can compare a resolved file against it. `key` is its `name@marketplace` in
 * installed_plugins.json; `project` marks a plugin installed for this workspace's project rather than for the user.
 */
export type InstalledPlugin = { readonly name: string; readonly root: string; readonly key?: string | undefined; readonly project?: true | undefined };

/** Each problem names its file or plugin; a broken file is reported and skipped, never thrown. */
export type PluginScan = { readonly plugins: readonly InstalledPlugin[]; readonly problems: readonly string[] };

const NO_PLUGINS: PluginScan = { plugins: [], problems: [] };

const installSchema = z.looseObject({ scope: z.string(), installPath: z.string().min(1), projectPath: z.string().optional() });
const installedSchema = z.looseObject({ plugins: z.record(z.string(), z.array(installSchema)) });
const manifestSchema = z.looseObject({ name: z.string().min(1).optional() });

/** Claude Code's config dir: CLAUDE_CONFIG_DIR, else `$HOME/.claude`; undefined when the environment names neither. */
export const claudeDirOf = (env: Readonly<Record<string, string | undefined>>): string | undefined =>
  env['CLAUDE_CONFIG_DIR'] || (env['HOME'] ? path.join(env['HOME'], '.claude') : undefined);

const canonical = (file: string): Promise<string> => realpath(file).catch(() => file);

export async function readJson(file: string): Promise<{ readonly kind: 'missing' } | { readonly kind: 'read'; readonly value: unknown } | { readonly kind: 'broken'; readonly reason: string }> {
  let text: string;
  try {
    text = await readFile(file, 'utf8');
  } catch (error) {
    return isMissing(error) ? { kind: 'missing' } : { kind: 'broken', reason: (error as Error).message };
  }
  try {
    return { kind: 'read', value: JSON.parse(text) };
  } catch (error) {
    return { kind: 'broken', reason: (error as Error).message };
  }
}

type Resolved = { readonly plugin: InstalledPlugin } | { readonly problem: string };

/** A plugin without a manifest is named by its key, `name@marketplace`, as Claude Code does. */
async function resolvePlugin(key: string, installPath: string, claudeDir: string, project: boolean): Promise<Resolved> {
  const root = await realpath(installPath).catch(() => undefined);
  if (root === undefined || !(await stat(root)).isDirectory()) return { problem: `${key}: ${installPath} does not exist` };
  // A plugin folder becomes readable to the model, so it must never take in the Claude config dir and its credentials.
  const fromRoot = path.relative(root, claudeDir);
  if (!fromRoot.startsWith('..') && !path.isAbsolute(fromRoot)) return { problem: `${key}: ${installPath} holds the Claude config dir, so it is not read` };
  const manifestFile = path.join(root, '.claude-plugin', 'plugin.json');
  const manifest = await readJson(manifestFile);
  if (manifest.kind === 'broken') return { problem: `${key}: ${manifestFile} is not valid JSON: ${manifest.reason}` };
  const parsed = manifest.kind === 'read' ? manifestSchema.safeParse(manifest.value) : undefined;
  if (parsed !== undefined && !parsed.success) return { problem: `${key}: ${manifestFile}: ${z.prettifyError(parsed.error)}` };
  return { plugin: { name: parsed?.data.name ?? key.split('@')[0]!, root, key, ...(project ? { project: true as const } : {}) } };
}

/** The plugins installed for the user, plus those installed for this workspace's project, sorted by key. */
export async function loadPlugins(claudeDir: string | undefined, workspace: string): Promise<PluginScan> {
  if (claudeDir === undefined) return NO_PLUGINS;
  const file = path.join(claudeDir, 'plugins', 'installed_plugins.json');
  const raw = await readJson(file);
  if (raw.kind === 'missing') return NO_PLUGINS;
  if (raw.kind === 'broken') return { plugins: [], problems: [`${file} is not valid JSON: ${raw.reason}`] };
  const parsed = installedSchema.safeParse(raw.value);
  if (!parsed.success) return { plugins: [], problems: [`${file}: ${z.prettifyError(parsed.error)}`] };

  const project = await canonical(workspace);
  const claudeReal = await canonical(claudeDir);
  const plugins: InstalledPlugin[] = [];
  const problems: string[] = [];
  for (const key of Object.keys(parsed.data.plugins).toSorted()) {
    const applies = [];
    for (const install of parsed.data.plugins[key]!) {
      if (install.projectPath === undefined || (await canonical(install.projectPath)) === project) applies.push(install);
    }
    const install = applies[0];
    if (install === undefined) continue;
    const resolved = await resolvePlugin(key, install.installPath, claudeReal, install.projectPath !== undefined);
    if ('plugin' in resolved) plugins.push(resolved.plugin);
    else problems.push(resolved.problem);
  }
  return { plugins, problems };
}
