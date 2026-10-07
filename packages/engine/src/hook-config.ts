import path from 'node:path';
import { parseHookSettings, type HookEntry, type HookOrigin, type HookProblem, type ParsedHooks } from '@g-code/core';
import { readJson, type InstalledPlugin } from './plugins.js';

/**
 * Where hooks are read from, the user's own files first: an identical handler in a later file runs once, as the
 * earlier one. All of them run; there is no override between scopes, as in Claude Code.
 */
export type HookSources = {
  /** Claude Code's config dir, `~/.claude` or CLAUDE_CONFIG_DIR. */
  readonly claudeDir: string | undefined;
  /** Geno's own folder, `~/.g-code` or GCODE_HOME. */
  readonly appHome: string;
  readonly workspace: string;
  readonly plugins: readonly InstalledPlugin[];
};

type SettingsFile = { readonly file: string; readonly scope: HookOrigin['scope'] };

const settingsFiles = ({ claudeDir, appHome, workspace }: HookSources): SettingsFile[] => [
  { file: path.join(appHome, 'settings.json'), scope: 'user' },
  ...(claudeDir === undefined ? [] : [{ file: path.join(claudeDir, 'settings.json'), scope: 'user' as const }]),
  { file: path.join(workspace, '.gcode.json'), scope: 'project' },
  { file: path.join(workspace, '.claude', 'settings.json'), scope: 'project' },
  { file: path.join(workspace, '.claude', 'settings.local.json'), scope: 'project' },
];

const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> => typeof value === 'object' && value !== null && !Array.isArray(value);

/** `enabledPlugins` across the settings files, a later file over an earlier one, as Claude Code merges its scopes. */
function enabledPluginsOf(read: readonly { readonly value: unknown }[]): ReadonlyMap<string, boolean> {
  const enabled = new Map<string, boolean>();
  for (const { value } of read) {
    const raw = isRecord(value) ? value['enabledPlugins'] : undefined;
    if (!isRecord(raw)) continue;
    for (const [key, on] of Object.entries(raw)) if (typeof on === 'boolean') enabled.set(key, on);
  }
  return enabled;
}

/**
 * Every hook the session could run, with what could not be read. Nothing here decides what runs: a project hook needs a
 * trusted workspace (`runnableEntries`), and an event Geno does not fire never runs.
 */
export async function loadHookConfig(sources: HookSources): Promise<ParsedHooks> {
  const entries: HookEntry[] = [];
  const problems: HookProblem[] = [];
  const read: { readonly file: SettingsFile; readonly value: unknown }[] = [];
  const take = (parsed: ParsedHooks) => {
    entries.push(...parsed.entries);
    problems.push(...parsed.problems);
  };
  const files = settingsFiles(sources);
  for (const file of files) {
    const raw = await readJson(file.file);
    if (raw.kind === 'broken') problems.push({ severity: 'warning', text: `${file.file} is not valid JSON, so its hooks do not run: ${raw.reason}` });
    if (raw.kind === 'read') read.push({ file, value: raw.value });
  }
  const enabled = enabledPluginsOf(read);
  const pluginHooks: ParsedHooks[] = [];
  for (const plugin of sources.plugins) {
    if (plugin.key !== undefined && enabled.get(plugin.key) === false) continue;
    const file = path.join(plugin.root, 'hooks', 'hooks.json');
    const raw = await readJson(file);
    if (raw.kind === 'broken') problems.push({ severity: 'warning', text: `${file} is not valid JSON, so the ${plugin.name} plugin's hooks do not run: ${raw.reason}` });
    if (raw.kind !== 'read') continue;
    const origin: HookOrigin = { file, scope: plugin.project === true ? 'project' : 'user', plugin: { name: plugin.name, root: plugin.root } };
    pluginHooks.push(parseHookSettings(raw.value, origin));
  }
  for (const { file, value } of read.filter(({ file }) => file.scope === 'user')) take(parseHookSettings(value, file));
  for (const parsed of pluginHooks) take(parsed);
  for (const { file, value } of read.filter(({ file }) => file.scope === 'project')) take(parseHookSettings(value, file));
  return { entries, problems };
}

/** The hooks that may run: the user's own always, the repository's only in a workspace the user trusts. */
export const runnableEntries = (entries: readonly HookEntry[], trusted: boolean): HookEntry[] => entries.filter((entry) => entry.origin.scope === 'user' || trusted);
