import path from 'node:path';

/**
 * Every place Geno reads its configuration from (docs/config.md). A root is one vendor's folder in one place: Geno's
 * own, the vendor-neutral `.agents`, or Claude Code's, for the user or for the project. Each reader takes its paths
 * from here, so a new location or vendor is one row.
 */

/** Within a place, an earlier vendor wins: Geno's own name, then the vendor-neutral one, then Claude Code's. */
export const CONFIG_VENDORS = ['geno', 'agents', 'claude'] as const;
export type ConfigVendor = (typeof CONFIG_VENDORS)[number];

export const CONFIG_PLACES = ['user', 'project'] as const;
export type ConfigPlace = (typeof CONFIG_PLACES)[number];

/** Lowest first: a project-local file beats a project-shared one, which beats the user's. */
export const SETTINGS_SCOPES = ['user', 'project-shared', 'project-local'] as const;
export type SettingsScope = (typeof SETTINGS_SCOPES)[number];

/** What a root may hold, by its path inside the root. */
export const CONFIG_ITEMS = { commands: 'commands', skills: 'skills', agents: 'agents', workflows: 'workflows', launch: 'launch.json' } as const;
export type ConfigItem = keyof typeof CONFIG_ITEMS;

/**
 * Where the user's roots sit: Geno's app home (`~/.g-code`, or GCODE_HOME), the home `~` names, and Claude Code's
 * config dir (`~/.claude`, or CLAUDE_CONFIG_DIR). An undefined one leaves its roots out.
 */
export type ConfigHomes = { readonly app: string; readonly user: string | undefined; readonly claude?: string | undefined };

type Env = Readonly<Record<string, string | undefined>>;

/** Geno's app home: GCODE_HOME, else `.g-code` in the OS's home. */
export const appHomeOf = (env: Env, osHome: string): string => path.resolve(env['GCODE_HOME'] || path.join(osHome, '.g-code'));

/** Claude Code's config dir: CLAUDE_CONFIG_DIR, else `$HOME/.claude`; undefined when the environment names neither. */
export const claudeDirOf = (env: Env): string | undefined => env['CLAUDE_CONFIG_DIR'] || (env['HOME'] ? path.join(env['HOME'], '.claude') : undefined);

/** The user's home is never guessed, so a sealed environment reads nothing from it. */
export const configHomesOf = (appHome: string, env: Env): ConfigHomes => ({ app: appHome, user: env['HOME'] || undefined, claude: claudeDirOf(env) });

type VendorRow = {
  /** The user's root, and the folder it lives under, which a watch never climbs above. */
  readonly user: (homes: ConfigHomes) => { readonly base: string; readonly dir: string } | undefined;
  /** The project's root, relative to the workspace. */
  readonly project: string;
  readonly holds: Readonly<Record<ConfigPlace, readonly ConfigItem[]>>;
};

const SHARED_ITEMS: readonly ConfigItem[] = ['commands', 'skills', 'agents'];

export const CONFIG_ROOTS: Readonly<Record<ConfigVendor, VendorRow>> = {
  geno: {
    user: (homes) => ({ base: homes.app, dir: homes.app }),
    project: '.g-code',
    holds: { user: [...SHARED_ITEMS, 'workflows'], project: [...SHARED_ITEMS, 'workflows', 'launch'] },
  },
  agents: {
    user: (homes) => (homes.user === undefined ? undefined : { base: homes.user, dir: path.join(homes.user, '.agents') }),
    project: '.agents',
    holds: { user: SHARED_ITEMS, project: SHARED_ITEMS },
  },
  claude: {
    user: (homes) => (homes.claude === undefined ? undefined : { base: homes.claude, dir: homes.claude }),
    project: '.claude',
    holds: { user: SHARED_ITEMS, project: [...SHARED_ITEMS, 'launch'] },
  },
};

export type ConfigRoot = { readonly vendor: ConfigVendor; readonly place: ConfigPlace; readonly base: string; readonly dir: string };

/** Every root the homes name, the user's first, each place in vendor order. */
export function configRoots(homes: ConfigHomes, workspace: string): ConfigRoot[] {
  return CONFIG_PLACES.flatMap((place) =>
    CONFIG_VENDORS.flatMap((vendor): ConfigRoot[] => {
      if (place === 'project') return [{ vendor, place, base: workspace, dir: path.join(workspace, CONFIG_ROOTS[vendor].project) }];
      const at = CONFIG_ROOTS[vendor].user(homes);
      return at === undefined ? [] : [{ vendor, place, ...at }];
    }),
  );
}

export type ConfigPath = ConfigRoot & { readonly path: string };

/** `item` in each root that holds it, in configRoots order. */
export const configPaths = (homes: ConfigHomes, workspace: string, item: ConfigItem): ConfigPath[] =>
  configRoots(homes, workspace).flatMap((root) => (CONFIG_ROOTS[root.vendor].holds[root.place].includes(item) ? [{ ...root, path: path.join(root.dir, CONFIG_ITEMS[item]) }] : []));

/** `item` in each project root that holds it, workspace-relative with `/`, as the model and the user read it. */
export const projectItemFiles = (item: ConfigItem): string[] =>
  CONFIG_VENDORS.flatMap((vendor) => (CONFIG_ROOTS[vendor].holds.project.includes(item) ? [`${CONFIG_ROOTS[vendor].project}/${CONFIG_ITEMS[item]}`] : []));

/** `legacy` marks `.gcode.json`, read as the project's shared Geno file beneath `.g-code/settings.json`. */
export type SettingsFile = { readonly file: string; readonly vendor: ConfigVendor; readonly scope: SettingsScope; readonly legacy?: true | undefined };

export const LEGACY_SETTINGS_FILE = '.gcode.json';

/** The project's settings files, shared then local, each in vendor order; alone for what only a repository may set. */
export function projectSettingsFiles(workspace: string): SettingsFile[] {
  const files: SettingsFile[] = [];
  for (const vendor of CONFIG_VENDORS) {
    files.push({ file: path.join(workspace, CONFIG_ROOTS[vendor].project, 'settings.json'), vendor, scope: 'project-shared' });
    if (vendor === 'geno') files.push({ file: path.join(workspace, LEGACY_SETTINGS_FILE), vendor, scope: 'project-shared', legacy: true });
  }
  for (const vendor of CONFIG_VENDORS) files.push({ file: path.join(workspace, CONFIG_ROOTS[vendor].project, 'settings.local.json'), vendor, scope: 'project-local' });
  return files;
}

/**
 * Every settings file, by scope (user, project-shared, project-local) and, in each, by vendor: `settings.json` in each
 * root, and `settings.local.json` too in a project's.
 */
export const settingsFiles = (homes: ConfigHomes, workspace: string): SettingsFile[] => [
  ...configRoots(homes, workspace).flatMap((root): SettingsFile[] => (root.place === 'user' ? [{ file: path.join(root.dir, 'settings.json'), vendor: root.vendor, scope: 'user' }] : [])),
  ...projectSettingsFiles(workspace),
];

const rank = (file: SettingsFile): number => SETTINGS_SCOPES.indexOf(file.scope) * 10 - CONFIG_VENDORS.indexOf(file.vendor) * 2 - (file.legacy === true ? 1 : 0);

/** Lowest precedence first, so a later file's value wins: by scope, then Geno over `.agents` over Claude Code. */
export const byPrecedence = <T extends { readonly source: SettingsFile }>(files: readonly T[]): T[] => files.toSorted((a, b) => rank(a.source) - rank(b.source));
