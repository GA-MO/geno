import path from 'node:path';
import { byPrecedence, parseHookSettings, settingsFiles, type ConfigHomes, type HookEntry, type HookOrigin, type HookProblem, type ParsedHooks, type SettingsFile } from '@g-code/core';
import { readJson, type InstalledPlugin } from './plugins.js';
import { readSettings, type LoadedSettings } from './settings.js';

/**
 * Where hooks are read from: every settings file the config roots name, the user's own first, and the plugins'. An
 * identical handler in a later file runs once, as the earlier one. All of them run; there is no override between
 * scopes, as in Claude Code.
 */
export type HookSources = { readonly homes: ConfigHomes; readonly workspace: string; readonly plugins: readonly InstalledPlugin[] };

const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> => typeof value === 'object' && value !== null && !Array.isArray(value);

/** `enabledPlugins` across the settings files, the file that wins a scalar winning each plugin. */
function enabledPluginsOf(read: readonly LoadedSettings[]): ReadonlyMap<string, boolean> {
  const enabled = new Map<string, boolean>();
  for (const { value } of byPrecedence(read)) {
    const raw = value['enabledPlugins'];
    if (!isRecord(raw)) continue;
    for (const [key, on] of Object.entries(raw)) if (typeof on === 'boolean') enabled.set(key, on);
  }
  return enabled;
}

const originOf = (source: SettingsFile): HookOrigin => ({ file: source.file, scope: source.scope === 'user' ? 'user' : 'project' });

/**
 * Every hook the session could run, with what could not be read. Nothing here decides what runs: a project hook needs a
 * trusted workspace (`runnableEntries`), and an event Geno does not fire never runs.
 */
export async function loadHookConfig(sources: HookSources): Promise<ParsedHooks> {
  const entries: HookEntry[] = [];
  const problems: HookProblem[] = [];
  const take = (parsed: ParsedHooks) => {
    entries.push(...parsed.entries);
    problems.push(...parsed.problems);
  };
  const settings = await readSettings(settingsFiles(sources.homes, sources.workspace), (file) => file);
  for (const { source, reason } of settings.broken) problems.push({ severity: 'warning', text: `${source.file} is not valid JSON, so its hooks do not run: ${reason}` });
  const enabled = enabledPluginsOf(settings.files);
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
  for (const { source, value } of settings.files.filter(({ source }) => source.scope === 'user')) take(parseHookSettings(value, originOf(source)));
  for (const parsed of pluginHooks) take(parsed);
  for (const { source, value } of settings.files.filter(({ source }) => source.scope !== 'user')) take(parseHookSettings(value, originOf(source)));
  return { entries, problems };
}

/** The hooks that may run: the user's own always, the repository's only in a workspace the user trusts. */
export const runnableEntries = (entries: readonly HookEntry[], trusted: boolean): HookEntry[] => entries.filter((entry) => entry.origin.scope === 'user' || trusted);
