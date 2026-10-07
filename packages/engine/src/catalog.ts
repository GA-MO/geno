import { randomUUID } from 'node:crypto';
import { lstat, mkdir, readFile, realpath, rename, rm, rmdir, stat, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import {
  CATALOG_INDEX_FILE,
  CATALOG_KINDS,
  CATALOG_LIMITS,
  catalogSourceOf,
  catalogUrlOf,
  entryProblem,
  fileOriginOf,
  fileProblem,
  formatBytes,
  INSTALL_SCOPES,
  installsFor,
  installTargetOf,
  mainFileOf,
  matchesQuery,
  planInstall,
  planUninstall,
  recordOf,
  sha256Hex,
  type CatalogEntry,
  type CatalogHit,
  type CatalogIndex,
  type CatalogInstallRequest,
  type CatalogInstallResponse,
  type CatalogItemRequest,
  type CatalogPreviewResponse,
  type CatalogSearchResponse,
  type CatalogSource,
  type CatalogUninstallResponse,
  type ExistingItem,
  type FileOrigin,
  type InstalledFileState,
  type InstalledItem,
  type InstallManifest,
  type InstallRecord,
  type SkillsResponse,
} from '@g-code/core';
import type { Homes } from './commands.js';
import { loadCommands } from './commands.js';
import { EngineError } from './errors.js';
import { holdingLock } from './file-lock.js';
import { writeAtomically } from './memory.js';
import type { InstalledPlugin } from './plugins.js';
import { parseFrontmatter } from './project-context.js';
import { isMissing } from './store.js';
import { loadAgents } from './subagents.js';
import { pidAlive } from './wait-hooks.js';
import { get, guardedResolve, type Resolve } from './tools/web.js';

/**
 * Settings' Skills section in the engine: what Geno loads from the workspace and the user's home, and installs from
 * the catalogs the user lists. A catalog's files are only ever read and written as bytes; nothing here runs them.
 */
export class CatalogError extends EngineError {}

const fileSchema = z.object({
  path: z.string(),
  sha256: z.string(),
  size: z.number().int().nonnegative().optional(),
  url: z.string().optional(),
});
const entrySchema = z.object({
  kind: z.enum(CATALOG_KINDS),
  name: z.string(),
  description: z.string(),
  version: z.string().min(1).max(64),
  files: z.array(fileSchema).max(CATALOG_LIMITS.files + 1),
});
const indexSchema = z.object({ version: z.literal(1), name: z.string().optional(), entries: z.array(entrySchema).max(CATALOG_LIMITS.entries) }) satisfies z.ZodType<CatalogIndex>;

const recordSchema = z.object({
  id: z.string().min(1),
  kind: z.enum(CATALOG_KINDS),
  name: z.string(),
  description: z.string(),
  version: z.string(),
  scope: z.enum(INSTALL_SCOPES),
  workspace: z.string().optional(),
  catalog: z.string(),
  target: z.string(),
  owns: z.string().optional(),
  files: z.array(z.object({ path: z.string(), sha256: z.string() })),
  installedAt: z.string(),
}) satisfies z.ZodType<InstallRecord>;
const manifestSchema = z.object({ version: z.literal(1), installs: z.array(recordSchema) });

const within = (root: string, file: string): boolean => {
  const rel = path.relative(root, file);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
};

const canonical = (file: string): Promise<string> => realpath(file).catch(() => file);

/** A file of a local catalog. Its real path must stay in the catalog folder, so a symlink cannot lead out. */
async function readLocal(dir: string, rel: string, maxBytes: number): Promise<Buffer> {
  const root = await realpath(dir).catch(() => {
    throw new CatalogError(`the catalog folder ${dir} does not exist`);
  });
  const real = await realpath(path.join(root, rel)).catch((error: unknown) => {
    throw new CatalogError(isMissing(error) ? `${rel} is not in the catalog folder ${dir}` : `could not read ${rel}: ${(error as Error).message}`);
  });
  if (!within(root, real)) throw new CatalogError(`${rel} is a symlink that leads outside the catalog folder ${dir}`);
  const info = await stat(real);
  if (!info.isFile()) throw new CatalogError(`${rel} in ${dir} is not a file`);
  if (info.size > maxBytes) throw new CatalogError(`${rel} is larger than ${formatBytes(maxBytes)}`);
  return readFile(real);
}

const ACCEPT = 'application/json,text/markdown;q=0.9,text/plain;q=0.8,*/*;q=0.1';

/**
 * A remote catalog file over https, through web_fetch's guards: every hop must be https to a public host, and the
 * name's addresses are checked and pinned against DNS rebinding.
 */
async function readRemote(url: string, maxBytes: number, resolve: Resolve): Promise<Buffer> {
  const first = catalogUrlOf(url);
  if (first.kind === 'refused') throw new CatalogError(`${url}: ${first.why}`);
  const signal = AbortSignal.timeout(CATALOG_LIMITS.timeoutMs);
  let target = first;
  for (let hops = 0; ; hops++) {
    let response;
    try {
      response = await get(target, resolve, signal, { accept: ACCEPT, maxBytes: maxBytes + 1, agent: 'catalog' });
    } catch (error) {
      if (signal.aborted) throw new CatalogError(`${target.url} did not answer within ${CATALOG_LIMITS.timeoutMs / 1000} seconds`);
      throw new CatalogError(`could not fetch ${target.url}: ${(error as Error).message || (error as NodeJS.ErrnoException).code}`);
    }
    if (response.location !== undefined) {
      if (hops >= CATALOG_LIMITS.redirects) throw new CatalogError(`${url} redirected more than ${CATALOG_LIMITS.redirects} times`);
      const next = catalogUrlOf(new URL(response.location, target.url).href);
      if (next.kind === 'refused') throw new CatalogError(`${target.url} redirected to ${response.location}: ${next.why}`);
      target = next;
      continue;
    }
    if (response.status !== 200) throw new CatalogError(`${target.url} answered HTTP ${response.status}`);
    if (response.truncated || response.body.byteLength > maxBytes) throw new CatalogError(`${target.url} is larger than ${formatBytes(maxBytes)}`);
    return response.body;
  }
}

export type CatalogDeps = {
  /** Where a host name points; the default refuses a name that points at a private address. */
  readonly resolve?: Resolve | undefined;
  readonly now?: (() => Date) | undefined;
};

type Reader = (origin: FileOrigin, maxBytes: number) => Promise<Buffer>;

const readerOf =
  (resolve: Resolve): Reader =>
  (origin, maxBytes) =>
    origin.kind === 'folder' ? readLocal(origin.dir, origin.rel, maxBytes) : readRemote(origin.url, maxBytes, resolve);

const indexOrigin = (source: CatalogSource): FileOrigin => (source.kind === 'folder' ? { kind: 'folder', dir: source.dir, rel: CATALOG_INDEX_FILE } : { kind: 'url', url: source.url });

async function readIndex(source: CatalogSource, read: Reader): Promise<CatalogIndex> {
  const bytes = await read(indexOrigin(source), CATALOG_LIMITS.indexBytes);
  let raw: unknown;
  try {
    raw = JSON.parse(bytes.toString('utf8'));
  } catch (error) {
    throw new CatalogError(`${source.text} is not valid JSON: ${(error as Error).message}`);
  }
  const parsed = indexSchema.safeParse(raw);
  if (!parsed.success) throw new CatalogError(`${source.text} is not a catalog index: ${z.prettifyError(parsed.error)}`);
  return parsed.data;
}

/** The manifest of Geno's installs, under its home: `catalog/installs.json`. */
function manifestStore(appHome: string) {
  const file = path.join(appHome, 'catalog', 'installs.json');
  const read = async (): Promise<readonly InstallRecord[]> => {
    let text: string;
    try {
      text = await readFile(file, 'utf8');
    } catch (error) {
      if (isMissing(error)) return [];
      throw error;
    }
    const parsed = manifestSchema.safeParse(JSON.parse(text));
    if (!parsed.success) throw new CatalogError(`${file}: ${z.prettifyError(parsed.error)}`);
    return parsed.data.installs;
  };
  // Changes take turns in this process, and hold a lock against other engines, so no install loses another's record.
  let queue: Promise<unknown> = Promise.resolve();
  const change = <T>(work: (records: readonly InstallRecord[]) => Promise<{ readonly records: readonly InstallRecord[]; readonly result: T }>): Promise<T> => {
    const next = queue.then(() =>
      holdingLock(file, process.pid, pidAlive, async () => {
        const { records, result } = await work(await read());
        const manifest: InstallManifest = { version: 1, installs: records };
        await writeAtomically(file, manifest);
        return result;
      }),
    );
    queue = next.catch(() => {});
    return next;
  };
  return { read, change };
}

const fieldText = (value: string | readonly string[]): string => (typeof value === 'string' ? value : value.join(', '));

/** Why the main file would not load as the entry it claims to be, once its hash checked out. */
function mainFileProblem(entry: CatalogEntry, text: string): string | undefined {
  const { fields } = parseFrontmatter(text.replace(/\r\n?/g, '\n'));
  const named = fields['name'];
  const main = mainFileOf(entry);
  if (named !== undefined && fieldText(named).trim() !== entry.name) return `${main} names itself ${fieldText(named).trim()}, not ${entry.name}`;
  const description = fields['description'];
  if (entry.kind === 'skill' && (description === undefined || fieldText(description).trim() === '')) return `${main} has no description in its frontmatter, so Geno would not load it`;
  return undefined;
}

export type CatalogService = {
  skills(cwd: string): Promise<SkillsResponse>;
  search(cwd: string, catalogs: readonly string[], query: string): Promise<CatalogSearchResponse>;
  preview(request: CatalogItemRequest): Promise<CatalogPreviewResponse>;
  install(request: CatalogInstallRequest): Promise<CatalogInstallResponse>;
  uninstall(cwd: string, id: string): Promise<CatalogUninstallResponse>;
};

/**
 * `workspaceOf` turns the folder a request names into the workspace's real path. `plugins` lists Claude Code's
 * plugins, whose skills Settings only counts. An install never runs what it copies: each file is written as plain
 * data, mode 0644, with no executable bit.
 */
export function catalogService(
  homes: Homes,
  workspaceOf: (cwd: string) => Promise<string>,
  plugins: (workspace: string) => Promise<readonly InstalledPlugin[]>,
  deps: CatalogDeps = {},
): CatalogService {
  const read = readerOf(deps.resolve ?? guardedResolve());
  const now = deps.now ?? (() => new Date());
  const manifest = manifestStore(homes.app);

  const sourceOf = (text: string): CatalogSource => {
    const source = catalogSourceOf(text, homes.user);
    if (source.kind === 'refused') throw new CatalogError(`${text}: ${source.why}`);
    return source;
  };

  /** What Geno loads now, outside plugins, by real path, and how many plugin skills there are besides. */
  async function loaded(workspace: string) {
    const commands = await loadCommands(workspace, homes, await plugins(workspace));
    const agents = (await loadAgents(workspace, homes, [])).agents;
    const absolute = (shown: string) => (path.isAbsolute(shown) ? shown : path.join(workspace, shown));
    const items: { kind: InstalledItem['kind']; name: string; description: string; where: InstalledItem['where']; file: string; target: string }[] = [];
    const existing: ExistingItem[] = [];
    let pluginSkills = 0;
    for (const command of commands) {
      if (command.kind === 'builtin') existing.push({ kind: 'skill', name: command.name, path: 'a built-in command' });
      else if (command.kind === 'prompt') existing.push({ kind: 'skill', name: command.name, path: command.path });
      else if (command.scope === 'plugin') pluginSkills++;
      else {
        const file = absolute(command.path);
        items.push({ kind: 'skill', name: command.name, description: command.description, where: command.scope === 'workspace' ? 'workspace' : 'user', file, target: await canonical(path.dirname(file)) });
      }
    }
    for (const agent of agents) {
      if (agent.source === 'builtin' || agent.path === undefined) {
        existing.push({ kind: 'agent', name: agent.name, path: 'a built-in agent' });
        continue;
      }
      const file = absolute(agent.path);
      items.push({ kind: 'agent', name: agent.name, description: agent.description, where: agent.source === 'workspace' ? 'workspace' : 'user', file, target: await canonical(file) });
    }
    for (const item of items) existing.push({ kind: item.kind, name: item.name, path: item.file });
    return { items, existing, pluginSkills };
  }

  /** A path as Settings shows it: inside the workspace relative to it, inside the home under `~`. */
  const shown = (workspace: string, file: string): string => {
    if (within(workspace, file)) return path.relative(workspace, file).split(path.sep).join('/');
    if (homes.user !== undefined && within(homes.user, file)) return `~/${path.relative(homes.user, file)}`;
    return file;
  };

  async function skills(workspace: string): Promise<SkillsResponse> {
    const { items, pluginSkills } = await loaded(workspace);
    const records = installsFor(await manifest.read(), workspace);
    const byTarget = new Map(await Promise.all(records.map(async (record) => [await canonical(record.target), record] as const)));
    const listed: InstalledItem[] = items.map(({ target, file, ...item }) => {
      const record = byTarget.get(target);
      byTarget.delete(target);
      return { ...item, path: shown(workspace, file), loads: true, ...(record === undefined ? {} : { install: { id: record.id, version: record.version, catalog: record.catalog } }) };
    });
    for (const record of byTarget.values()) {
      listed.push({
        kind: record.kind,
        name: record.name,
        description: record.description,
        where: record.scope === 'user' ? 'user' : 'workspace',
        path: shown(workspace, record.target),
        install: { id: record.id, version: record.version, catalog: record.catalog },
        loads: false,
      });
    }
    return { items: listed.toSorted((a, b) => a.where.localeCompare(b.where) || a.kind.localeCompare(b.kind) || a.name.localeCompare(b.name)), pluginSkills };
  }

  const hitOf = (source: CatalogSource, index: CatalogIndex, entry: CatalogEntry, records: readonly InstallRecord[]): CatalogHit => ({
    catalog: source.text,
    catalogName: index.name ?? source.text,
    kind: entry.kind,
    name: entry.name,
    description: entry.description,
    version: entry.version,
    files: entry.files.map((file) => ({ path: file.path, ...(file.size === undefined ? {} : { size: file.size }) })),
    installed: INSTALL_SCOPES.filter((scope) => records.some((record) => record.scope === scope && record.kind === entry.kind && record.name === entry.name)),
    ...(entryProblem(entry) === undefined ? {} : { problem: entryProblem(entry) }),
  });

  async function entryOf(request: CatalogItemRequest) {
    const source = sourceOf(request.catalog);
    const index = await readIndex(source, read);
    const entry = index.entries.find((e) => e.kind === request.kind && e.name === request.name);
    if (entry === undefined) throw new CatalogError(`${source.text} has no ${request.kind} named ${request.name}`);
    return { source, index, entry };
  }

  /** The bytes of one listed file, refused unless they are exactly what the catalog's sha256 names. */
  async function verified(source: CatalogSource, entry: CatalogEntry, rel: string, origin: FileOrigin): Promise<Buffer> {
    const file = entry.files.find((f) => f.path === rel)!;
    const bytes = await read(origin, CATALOG_LIMITS.fileBytes);
    const problem = fileProblem(file, bytes);
    if (problem !== undefined) throw new CatalogError(`${entry.name} from ${source.text}: ${problem}; nothing was installed`);
    return bytes;
  }

  async function occupied(target: string): Promise<boolean> {
    try {
      await lstat(target);
      return true;
    } catch (error) {
      if (isMissing(error)) return false;
      throw error;
    }
  }

  /** The folder the install writes in must resolve inside its base, so a symlinked `.claude` cannot send it elsewhere. */
  async function checkedParent(target: string, base: string): Promise<string> {
    const parent = path.dirname(target);
    await mkdir(parent, { recursive: true });
    const [real, root] = await Promise.all([realpath(parent), canonical(base)]);
    if (!within(root, real)) throw new CatalogError(`${parent} resolves to ${real}, outside ${base}; nothing was installed`);
    return real;
  }

  async function stateOf(file: string, sha256: string): Promise<InstalledFileState['state']> {
    let info;
    try {
      info = await lstat(file);
    } catch (error) {
      if (isMissing(error)) return 'missing';
      throw error;
    }
    if (!info.isFile()) return 'changed';
    return sha256Hex(await readFile(file)) === sha256 ? 'same' : 'changed';
  }

  return {
    skills: async (cwd) => skills(await workspaceOf(cwd)),

    async search(cwd, catalogs, query) {
      const workspace = await workspaceOf(cwd);
      const records = installsFor(await manifest.read(), workspace);
      const hits: CatalogHit[] = [];
      const problems: string[] = [];
      for (const text of catalogs) {
        try {
          const source = sourceOf(text);
          const index = await readIndex(source, read);
          for (const entry of index.entries) if (matchesQuery(entry, query)) hits.push(hitOf(source, index, entry, records));
        } catch (error) {
          problems.push(error instanceof CatalogError ? error.message : `${text}: ${(error as Error).message}`);
        }
      }
      return { hits, problems };
    },

    async preview(request) {
      const workspace = await workspaceOf(request.cwd);
      const { source, index, entry } = await entryOf(request);
      const hit = hitOf(source, index, entry, installsFor(await manifest.read(), workspace));
      if (hit.problem !== undefined) throw new CatalogError(`${entry.name} cannot be installed: ${hit.problem}`);
      const main = mainFileOf(entry);
      const origin = fileOriginOf(source, entry.files.find((f) => f.path === main)!);
      if (origin.kind === 'refused') throw new CatalogError(`${main}: ${origin.why}`);
      const text = (await verified(source, entry, main, origin)).toString('utf8').replace(/\r\n?/g, '\n');
      const { fields, body } = parseFrontmatter(text);
      return { hit, file: main, fields: Object.entries(fields).map(([key, value]) => [key, fieldText(value)] as const), body };
    },

    async install(request) {
      const workspace = await workspaceOf(request.cwd);
      const { source, entry } = await entryOf(request);
      const bases = { user: homes.app, project: workspace };
      const { target } = installTargetOf(entry, request.scope, bases);
      const plan = async (records: readonly InstallRecord[]) => {
        const outcome = planInstall({ entry, source, scope: request.scope, bases, existing: (await loaded(workspace)).existing, records: installsFor(records, workspace), occupied: await occupied(target) });
        if (outcome.kind === 'refused') throw new CatalogError(outcome.why);
        return outcome;
      };
      const first = await plan(await manifest.read());
      if (first.kind === 'installed') return { record: first.record, already: true, skills: await skills(workspace) };
      // Fetched and checked before taking the manifest's lock, which another window may be waiting on.
      const files: { readonly rel: string; readonly bytes: Buffer }[] = [];
      let total = 0;
      for (const write of first.writes) {
        const bytes = await verified(source, entry, write.file.path, write.origin);
        total += bytes.byteLength;
        if (total > CATALOG_LIMITS.entryBytes) throw new CatalogError(`${entry.name}'s files add up to more than ${formatBytes(CATALOG_LIMITS.entryBytes)}; nothing was installed`);
        files.push({ rel: write.file.path, bytes });
      }
      const problem = mainFileProblem(entry, files.find((f) => f.rel === mainFileOf(entry))!.bytes.toString('utf8'));
      if (problem !== undefined) throw new CatalogError(`${problem}; nothing was installed`);
      const record = await manifest.change(async (all) => {
        const planned = await plan(all);
        if (planned.kind === 'installed') return { records: all, result: { record: planned.record, already: true } };
        const parent = await checkedParent(target, bases[request.scope]);
        // Written beside the target and renamed into place, so a failure halfway leaves no partial skill behind.
        const staged = path.join(parent, `.geno-install-${randomUUID()}`);
        try {
          for (const file of files) {
            const dest = path.join(staged, ...file.rel.split('/'));
            await mkdir(path.dirname(dest), { recursive: true });
            await writeFile(dest, file.bytes, { flag: 'wx', mode: 0o644 });
          }
          await rename(entry.kind === 'skill' ? staged : path.join(staged, mainFileOf(entry)), target);
        } finally {
          await rm(staged, { recursive: true, force: true });
        }
        const made = recordOf(planned, randomUUID(), now());
        return { records: [...all, made], result: { record: made, already: false } };
      });
      return { ...record, skills: await skills(workspace) };
    },

    async uninstall(cwd, id) {
      const workspace = await workspaceOf(cwd);
      const kept = await manifest.change(async (all) => {
        const record = installsFor(all, workspace).find((r) => r.id === id);
        if (record === undefined) throw new CatalogError(`Geno has no install ${id} here`);
        const states = await Promise.all(record.files.map(async (file) => ({ path: file.path, state: await stateOf(file.path, file.sha256) })));
        const plan = planUninstall(record, states);
        for (const file of plan.remove) await unlink(file);
        for (const dir of plan.dirs) {
          await rmdir(dir).catch((error: NodeJS.ErrnoException) => {
            if (error.code !== 'ENOENT' && error.code !== 'ENOTEMPTY' && error.code !== 'EEXIST') throw error;
          });
        }
        return { records: all.filter((r) => r.id !== id), result: plan.keep };
      });
      return { kept, skills: await skills(workspace) };
    },
  };
}
