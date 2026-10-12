import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type * as vscode from 'vscode';

type Values = Readonly<Record<string, unknown>>;

/** The defaults an extension manifest contributes, by full key, as VS Code shows them before the user sets anything. */
export function defaultsOf(manifest: { readonly contributes?: { readonly configuration?: unknown } }): Values {
  const sections = [manifest.contributes?.configuration ?? []].flat() as { readonly properties?: Record<string, { readonly default?: unknown }> }[];
  return Object.fromEntries(sections.flatMap((section) => Object.entries(section.properties ?? {}).map(([key, property]) => [key, property.default])));
}

/** Whether a change to `keys` touches `section`, as VS Code's affectsConfiguration answers it, in either direction. */
export const affects = (keys: readonly string[], section: string): boolean =>
  keys.some((key) => key === section || key.startsWith(`${section}.`) || section.startsWith(`${key}.`));

/**
 * The user's settings for the web host: one flat JSON file, keyed as settings.json is, which stands in for VS Code's
 * user settings. There is no workspace scope, so a repository's own settings never reach the engine here.
 */
export class SettingsFile {
  private constructor(
    readonly file: string,
    private values: Values,
    private readonly defaults: Values,
    private readonly changed: (keys: readonly string[]) => void,
  ) {}

  static async open(file: string, defaults: Values, changed: (keys: readonly string[]) => void): Promise<SettingsFile> {
    const text = await readFile(file, 'utf8').catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return '{}';
      throw error;
    });
    let values: unknown;
    try {
      values = JSON.parse(text);
    } catch {
      throw new Error(`${file} is not valid JSON; fix or delete it`);
    }
    if (typeof values !== 'object' || values === null || Array.isArray(values)) throw new Error(`${file} must hold a JSON object of settings`);
    return new SettingsFile(file, values as Values, defaults, changed);
  }

  user(key: string): unknown {
    return this.values[key];
  }

  contributed(key: string): unknown {
    return this.defaults[key];
  }

  /** Writes the whole file again, replacing it in one step so a crash never leaves half of it. */
  async update(key: string, value: unknown): Promise<void> {
    const { [key]: _old, ...rest } = this.values;
    this.values = value === undefined ? rest : { ...rest, [key]: value };
    await mkdir(path.dirname(this.file), { recursive: true });
    const temporary = `${this.file}.${process.pid}.tmp`;
    await writeFile(temporary, `${JSON.stringify(this.values, null, 2)}\n`, { mode: 0o600 });
    await rename(temporary, this.file);
    this.changed([key]);
  }
}

/** `getConfiguration(section)` over the settings file: user values, then the manifest's defaults, then the caller's. */
export function configurationOf(settings: SettingsFile, section?: string): vscode.WorkspaceConfiguration {
  const full = (key: string) => (section === undefined || section === '' ? key : `${section}.${key}`);
  const effective = (key: string) => settings.user(full(key)) ?? settings.contributed(full(key));
  return {
    get: <T>(key: string, fallback?: T): T | undefined => (effective(key) as T | undefined) ?? fallback,
    has: (key: string) => effective(key) !== undefined,
    inspect: <T>(key: string) => ({ key: full(key), defaultValue: settings.contributed(full(key)) as T | undefined, globalValue: settings.user(full(key)) as T | undefined }),
    update: (key: string, value: unknown) => settings.update(full(key), value),
  } as vscode.WorkspaceConfiguration;
}
