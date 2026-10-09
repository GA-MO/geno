import { createHash } from 'node:crypto';
import path from 'node:path';
import { formatBytes } from './attachments.js';
import { configPaths, type ConfigItem, type ConfigVendor } from './config-roots.js';
import { webTargetOf } from './web.js';

/**
 * Skills and agent definitions from a catalog: a JSON index the user points Geno at, by an https URL or a local
 * folder. Installing copies an entry's files as data into the user's Geno home or the workspace, after checking each
 * file's path, size and sha256. Nothing in an entry runs: no script, no hook, no package install.
 */
export const CATALOG_KINDS = ['skill', 'agent'] as const;
export type CatalogKind = (typeof CATALOG_KINDS)[number];

export const INSTALL_SCOPES = ['user', 'project'] as const;
export type InstallScope = (typeof INSTALL_SCOPES)[number];

/** A local catalog folder holds its index under this name. */
export const CATALOG_INDEX_FILE = 'catalog.json';

export const CATALOG_LIMITS = {
  indexBytes: 2 * 1024 * 1024,
  fileBytes: 1024 * 1024,
  entryBytes: 5 * 1024 * 1024,
  files: 200,
  entries: 2_000,
  pathChars: 240,
  redirects: 5,
  timeoutMs: 20_000,
} as const;

/** `path` is where the file goes inside the entry; `url` is where it comes from, else `path` beside the index. */
export type CatalogFile = { readonly path: string; readonly sha256: string; readonly size?: number | undefined; readonly url?: string | undefined };

export type CatalogEntry = {
  readonly kind: CatalogKind;
  readonly name: string;
  readonly description: string;
  readonly version: string;
  readonly files: readonly CatalogFile[];
};

export type CatalogIndex = { readonly version: 1; readonly name?: string | undefined; readonly entries: readonly CatalogEntry[] };

/** Where a catalog's index is. `text` is how the user wrote it, which names the catalog in the manifest. */
export type CatalogSource =
  | { readonly kind: 'url'; readonly text: string; readonly url: string }
  | { readonly kind: 'folder'; readonly text: string; readonly dir: string };

export type Refused = { readonly kind: 'refused'; readonly why: string };

/** A remote URL Geno fetches a catalog from: https on a public host, never this machine or a private address. */
export function catalogUrlOf(raw: string): { readonly kind: 'remote'; readonly url: string; readonly host: string } | Refused {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return { kind: 'refused', why: `${raw} is not a full URL` };
  }
  if (url.protocol !== 'https:') return { kind: 'refused', why: `a catalog URL must use https, not ${url.protocol}` };
  const target = webTargetOf(url.href);
  if (target.kind === 'local') return { kind: 'refused', why: 'a catalog on this machine is a folder: write its path instead of a URL' };
  if (target.kind === 'refused') return { kind: 'refused', why: url.username !== '' || url.password !== '' ? 'the URL carries a user name or password' : 'the URL names a private, loopback or link-local address' };
  return target;
}

/** A catalog as the user lists it in `gcode.skills.catalogs`: an https URL of an index, or an absolute folder. */
export function catalogSourceOf(raw: string, home: string | undefined): CatalogSource | Refused {
  const text = raw.trim();
  if (text === '') return { kind: 'refused', why: 'the catalog is empty' };
  if (/^[a-z][a-z0-9+.-]*:/i.test(text)) {
    if (/^file:/i.test(text)) return { kind: 'refused', why: 'write a local catalog as a folder path, not a file: URL' };
    const url = catalogUrlOf(text);
    return url.kind === 'refused' ? url : { kind: 'url', text, url: url.url };
  }
  const expanded = text === '~' || text.startsWith('~/') ? (home === undefined ? undefined : path.join(home, text.slice(1))) : text;
  if (expanded === undefined || !path.isAbsolute(expanded)) return { kind: 'refused', why: 'a catalog folder must be an absolute path, such as ~/catalogs/team' };
  return { kind: 'folder', text, dir: path.resolve(expanded) };
}

const NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const SHA256 = /^[0-9a-f]{64}$/;

/** Why a path from a catalog is unsafe to write, if it is: it must stay inside its entry. */
export function pathProblem(file: string): string | undefined {
  if (file === '') return 'the path is empty';
  if (file.length > CATALOG_LIMITS.pathChars) return `the path is longer than ${CATALOG_LIMITS.pathChars} characters`;
  if (/[\u0000-\u001f\u007f]/.test(file)) return 'the path has a control character';
  if (file.includes('\\')) return 'the path has a backslash; use /';
  if (file.startsWith('/') || /^[a-z]:/i.test(file)) return 'the path is absolute';
  for (const segment of file.split('/')) {
    if (segment === '') return 'the path has an empty segment';
    if (segment === '.' || segment === '..') return `the path has a "${segment}" segment`;
  }
  return undefined;
}

/** The file an entry of this kind cannot do without, which a preview shows. */
export const mainFileOf = (entry: Pick<CatalogEntry, 'kind' | 'name'>): string => (entry.kind === 'skill' ? 'SKILL.md' : `${entry.name}.md`);

/** Why an entry cannot be installed as listed, before any file is fetched. */
export function entryProblem(entry: CatalogEntry): string | undefined {
  if (!NAME.test(entry.name) || entry.name.length > 64) return 'its name must be lowercase letters, digits and single hyphens, at most 64 characters';
  if (entry.description.trim() === '') return 'it has no description';
  if (entry.files.length === 0) return 'it lists no files';
  if (entry.files.length > CATALOG_LIMITS.files) return `it lists more than ${CATALOG_LIMITS.files} files`;
  const seen = new Set<string>();
  let total = 0;
  for (const file of entry.files) {
    const problem = pathProblem(file.path);
    if (problem !== undefined) return `${file.path}: ${problem}`;
    // macOS folders ignore case, so two paths that differ only in case would write one file.
    const key = file.path.toLowerCase();
    if (seen.has(key)) return `${file.path} is listed twice`;
    seen.add(key);
    if (!SHA256.test(file.sha256)) return `${file.path}: its sha256 must be 64 lowercase hex digits`;
    if (file.size !== undefined && file.size > CATALOG_LIMITS.fileBytes) return `${file.path} is larger than the ${formatBytes(CATALOG_LIMITS.fileBytes)} a file may be`;
    total += file.size ?? 0;
  }
  if (total > CATALOG_LIMITS.entryBytes) return `its files add up to more than ${formatBytes(CATALOG_LIMITS.entryBytes)}`;
  const main = mainFileOf(entry);
  if (entry.kind === 'agent' && (entry.files.length !== 1 || entry.files[0]!.path !== main)) return `an agent definition is one file, ${main}`;
  if (!entry.files.some((file) => file.path === main)) return `it has no ${main}`;
  return undefined;
}

/** Where one file's bytes come from. A folder's file is `rel` inside `dir`; the engine checks no symlink leads out. */
export type FileOrigin = { readonly kind: 'url'; readonly url: string } | { readonly kind: 'folder'; readonly dir: string; readonly rel: string };

const HAS_SCHEME = /^[a-z][a-z0-9+.-]*:/i;

export function fileOriginOf(source: CatalogSource, file: CatalogFile): FileOrigin | Refused {
  const ref = file.url ?? file.path;
  if (HAS_SCHEME.test(ref)) {
    const url = catalogUrlOf(ref);
    return url.kind === 'refused' ? url : { kind: 'url', url: url.url };
  }
  const problem = pathProblem(ref);
  if (problem !== undefined) return { kind: 'refused', why: `${ref}: ${problem}` };
  if (source.kind === 'folder') return { kind: 'folder', dir: source.dir, rel: ref };
  const url = catalogUrlOf(new URL(ref, source.url).href);
  return url.kind === 'refused' ? url : { kind: 'url', url: url.url };
}

export const sha256Hex = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex');

/** Why fetched bytes are not the file the catalog lists, if they are not. */
export function fileProblem(file: CatalogFile, bytes: Uint8Array): string | undefined {
  if (bytes.byteLength > CATALOG_LIMITS.fileBytes) return `${file.path} is larger than the ${formatBytes(CATALOG_LIMITS.fileBytes)} a file may be`;
  if (file.size !== undefined && bytes.byteLength !== file.size) return `${file.path} is ${bytes.byteLength} bytes, not the ${file.size} the catalog lists`;
  const actual = sha256Hex(bytes);
  if (actual !== file.sha256) return `${file.path} does not match its sha256 in the catalog (got ${actual.slice(0, 12)}…, expected ${file.sha256.slice(0, 12)}…)`;
  return undefined;
}

/** Each word of the query appears in the entry's name or description, ignoring case. */
export function matchesQuery(entry: Pick<CatalogEntry, 'name' | 'description'>, query: string): boolean {
  const hay = `${entry.name}\n${entry.description}`.toLowerCase();
  return query.toLowerCase().split(/\s+/).filter(Boolean).every((word) => hay.includes(word));
}

/**
 * The root an install goes to: Geno's home for the user, and the project's `.claude`, which Claude Code reads as well
 * as Geno, so a teammate on either gets what the repository installed.
 */
const INSTALL_VENDORS: Readonly<Record<InstallScope, ConfigVendor>> = { user: 'geno', project: 'claude' };
const INSTALL_ITEMS: Readonly<Record<CatalogKind, ConfigItem>> = { skill: 'skills', agent: 'agents' };

/** `user` is Geno's home (`~/.g-code`), `project` the workspace. */
export type InstallBases = { readonly user: string; readonly project: string };

/**
 * `target` is what the install adds: a skill's folder, or an agent's one file. `owns` is the folder Geno creates
 * and may remove once empty; an agent's file sits in a folder that others share, so it owns none.
 */
export function installTargetOf(entry: Pick<CatalogEntry, 'kind' | 'name'>, scope: InstallScope, bases: InstallBases): { readonly dir: string; readonly target: string; readonly owns: string | undefined } {
  const parent = configPaths({ app: bases.user, user: undefined }, bases.project, INSTALL_ITEMS[entry.kind]).find((root) => root.place === scope && root.vendor === INSTALL_VENDORS[scope])!.path;
  if (entry.kind === 'skill') {
    const dir = path.join(parent, entry.name);
    return { dir, target: dir, owns: dir };
  }
  return { dir: parent, target: path.join(parent, mainFileOf(entry)), owns: undefined };
}

/** A skill or agent Geno already loads, by its name; plugin skills carry a namespace, so they never clash. */
export type ExistingItem = { readonly kind: CatalogKind; readonly name: string; readonly path: string };

export type InstalledFile = { readonly path: string; readonly sha256: string };

/** One install Geno made, kept in its manifest so Uninstall removes only these files. */
export type InstallRecord = {
  readonly id: string;
  readonly kind: CatalogKind;
  readonly name: string;
  readonly description: string;
  readonly version: string;
  readonly scope: InstallScope;
  /** The workspace's real path, for a project install. */
  readonly workspace?: string | undefined;
  /** The catalog as the user listed it. */
  readonly catalog: string;
  readonly target: string;
  readonly owns?: string | undefined;
  readonly files: readonly InstalledFile[];
  readonly installedAt: string;
};

export type InstallManifest = { readonly version: 1; readonly installs: readonly InstallRecord[] };

export type PlannedWrite = { readonly file: CatalogFile; readonly origin: FileOrigin; readonly dest: string };

export type InstallPlan = {
  readonly kind: 'install';
  readonly entry: CatalogEntry;
  readonly source: CatalogSource;
  readonly scope: InstallScope;
  readonly workspace: string;
  readonly target: string;
  readonly owns: string | undefined;
  readonly writes: readonly PlannedWrite[];
};

/** `installed` means this very entry is already there, so installing again changes nothing. */
export type PlanOutcome = InstallPlan | { readonly kind: 'installed'; readonly record: InstallRecord } | Refused;

export type PlanInput = {
  readonly entry: CatalogEntry;
  readonly source: CatalogSource;
  readonly scope: InstallScope;
  readonly bases: InstallBases;
  readonly existing: readonly ExistingItem[];
  readonly records: readonly InstallRecord[];
  /** Whether something is already at the target, on disk. */
  readonly occupied: boolean;
};

const sameFiles = (record: InstallRecord, entry: CatalogEntry, dir: string): boolean =>
  record.files.length === entry.files.length && entry.files.every((file) => record.files.some((f) => f.path === path.join(dir, file.path) && f.sha256 === file.sha256));

const KIND_WORDS: Readonly<Record<CatalogKind, string>> = { skill: 'a skill', agent: 'an agent' };

/** What installing an entry would write, or why it may not. */
export function planInstall({ entry, source, scope, bases, existing, records, occupied }: PlanInput): PlanOutcome {
  const problem = entryProblem(entry);
  if (problem !== undefined) return { kind: 'refused', why: `${entry.name}: ${problem}` };
  const { dir, target, owns } = installTargetOf(entry, scope, bases);
  const writes: PlannedWrite[] = [];
  for (const file of entry.files) {
    const origin = fileOriginOf(source, file);
    if (origin.kind === 'refused') return { kind: 'refused', why: `${file.path}: ${origin.why}` };
    writes.push({ file, origin, dest: path.join(dir, file.path) });
  }
  const mine = records.find((record) => record.target === target);
  if (mine !== undefined) {
    if (mine.kind === entry.kind && mine.catalog === source.text && sameFiles(mine, entry, dir)) return { kind: 'installed', record: mine };
    return { kind: 'refused', why: `${mine.name} ${mine.version} from ${mine.catalog} is already installed at ${target}; uninstall it first` };
  }
  if (occupied) return { kind: 'refused', why: `${target} already exists, and Geno does not overwrite files it did not install` };
  const clash = existing.find((item) => item.kind === entry.kind && item.name === entry.name);
  if (clash !== undefined) return { kind: 'refused', why: `${KIND_WORDS[entry.kind]} named ${entry.name} already exists at ${clash.path}` };
  return { kind: 'install', entry, source, scope, workspace: bases.project, target, owns, writes };
}

export const recordOf = (plan: InstallPlan, id: string, at: Date): InstallRecord => ({
  id,
  kind: plan.entry.kind,
  name: plan.entry.name,
  description: plan.entry.description,
  version: plan.entry.version,
  scope: plan.scope,
  ...(plan.scope === 'project' ? { workspace: plan.workspace } : {}),
  catalog: plan.source.text,
  target: plan.target,
  ...(plan.owns === undefined ? {} : { owns: plan.owns }),
  files: plan.writes.map((write) => ({ path: write.dest, sha256: write.file.sha256 })),
  installedAt: at.toISOString(),
});

/** What a file Geno installed looks like now: as written, edited since, or gone. */
export type InstalledFileState = { readonly path: string; readonly state: 'same' | 'changed' | 'missing' };

export type UninstallPlan = {
  readonly remove: readonly string[];
  /** Files the user changed since the install, which stay. */
  readonly keep: readonly string[];
  /** Folders to remove when empty, deepest first, all inside the folder the install owns. */
  readonly dirs: readonly string[];
};

const within = (root: string, file: string): boolean => {
  const rel = path.relative(root, file);
  return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel);
};

/** Removes the installed files that are as Geno wrote them, and the folders that leaves empty, and nothing else. */
export function planUninstall(record: InstallRecord, states: readonly InstalledFileState[]): UninstallPlan {
  const owns = record.owns;
  const ours = (file: string) => (owns === undefined ? file === record.target : within(owns, file));
  const stateOf = new Map(states.map((s) => [s.path, s.state]));
  const remove = record.files.filter((file) => ours(file.path) && stateOf.get(file.path) === 'same').map((file) => file.path);
  const keep = record.files.filter((file) => stateOf.get(file.path) === 'changed').map((file) => file.path);
  if (owns === undefined) return { remove, keep, dirs: [] };
  const dirs = new Set<string>([owns]);
  for (const file of record.files) for (let dir = path.dirname(file.path); within(owns, dir); dir = path.dirname(dir)) dirs.add(dir);
  return { remove, keep, dirs: [...dirs].toSorted((a, b) => b.length - a.length || a.localeCompare(b)) };
}

/** The installs that apply in a workspace: every user install, and the project installs of this workspace. */
export const installsFor = (records: readonly InstallRecord[], workspace: string): InstallRecord[] =>
  records.filter((record) => record.scope === 'user' || record.workspace === workspace);

export const SKILLS_METHOD = '_gcode/skills';
export const CATALOG_SEARCH_METHOD = '_gcode/catalogSearch';
export const CATALOG_PREVIEW_METHOD = '_gcode/catalogPreview';
export const CATALOG_INSTALL_METHOD = '_gcode/catalogInstall';
export const CATALOG_UNINSTALL_METHOD = '_gcode/catalogUninstall';

/** A skill or agent Geno loads from the workspace or the user's home, and the install that put it there, if Geno did. */
export type InstalledItem = {
  readonly kind: CatalogKind;
  readonly name: string;
  readonly description: string;
  readonly where: 'workspace' | 'user';
  readonly path: string;
  readonly install?: { readonly id: string; readonly version: string; readonly catalog: string } | undefined;
  /** False for an install whose files no longer load, such as a skill folder the user emptied. */
  readonly loads: boolean;
};

export type SkillsRequest = { readonly cwd: string };
export type SkillsResponse = { readonly items: readonly InstalledItem[]; readonly pluginSkills: number };

export type CatalogHit = {
  readonly catalog: string;
  readonly catalogName: string;
  readonly kind: CatalogKind;
  readonly name: string;
  readonly description: string;
  readonly version: string;
  readonly files: readonly { readonly path: string; readonly size?: number | undefined }[];
  readonly installed: readonly InstallScope[];
  /** Why it cannot be installed as listed. */
  readonly problem?: string | undefined;
};

export type CatalogSearchRequest = { readonly cwd: string; readonly catalogs: readonly string[]; readonly query: string };
/** Each problem names its catalog; one catalog that fails leaves the others' hits. */
export type CatalogSearchResponse = { readonly hits: readonly CatalogHit[]; readonly problems: readonly string[] };

export type CatalogItemRequest = { readonly cwd: string; readonly catalog: string; readonly kind: CatalogKind; readonly name: string };
/** The entry's main file, checked against its sha256: its frontmatter as pairs, and its body. */
export type CatalogPreviewResponse = { readonly hit: CatalogHit; readonly file: string; readonly fields: readonly (readonly [string, string])[]; readonly body: string };

export type CatalogInstallRequest = CatalogItemRequest & { readonly scope: InstallScope };
export type CatalogInstallResponse = { readonly record: InstallRecord; readonly already: boolean; readonly skills: SkillsResponse };

export type CatalogUninstallRequest = { readonly cwd: string; readonly id: string };
export type CatalogUninstallResponse = { readonly kept: readonly string[]; readonly skills: SkillsResponse };
