// Portions ported from Pi (https://github.com/earendil-works/pi) at b2b5c42, Copyright (c) 2025 Mario Zechner, MIT License.

import { execFile } from 'node:child_process';
import { mkdir, readdir, readFile, realpath, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import {
  isSecretPath,
  stripHidden,
  type InstructionFile,
  type LoadedContext,
  type NestedInstructionFile,
  type ProjectRule,
  type RuleTrigger,
  type SkillEntry,
} from '@g-code/core';
import { comparePaths } from './tools/ripgrep.js';

const execFileAsync = promisify(execFile);

/** Per directory the first of these that is a file wins. */
const INSTRUCTION_NAMES = ['AGENTS.override.md', 'AGENTS.md', 'CLAUDE.md'] as const;
/** Claude Code's project files beside the workspace's own, loaded after it. */
const WORKSPACE_EXTRAS = [path.join('.claude', 'CLAUDE.md'), 'CLAUDE.local.md'] as const;
/** Claude Code skips a larger instruction file. */
const MAX_INSTRUCTION_BYTES = 4 * 1024 * 1024;
/** How many `@path` hops below a loaded file are followed, as in Claude Code. */
const MAX_IMPORT_DEPTH = 4;
const RULES_DIR = path.join('.cursor', 'rules');
/** Listing the workspace for nested instruction files stops after this, so a huge tree outside a repository cannot stall a session's start. */
const NESTED_SCAN_MS = 5_000;
export const SKILL_ROOTS = [path.join('.agents', 'skills'), path.join('.claude', 'skills')] as const;

const clean = (text: string): string => stripHidden(text.replace(/\r\n?/g, '\n'));

export async function readIfFile(file: string): Promise<string | undefined> {
  try {
    if (!(await stat(file)).isFile()) return undefined;
    return clean(await readFile(file, 'utf8'));
  } catch {
    // Missing or unreadable context never stops a session from starting.
    return undefined;
  }
}

const canonical = (file: string): Promise<string> => realpath(file).catch(() => file);

const isFile = (file: string): Promise<boolean> =>
  stat(file).then(
    (info) => info.isFile(),
    () => false,
  );

async function instructionFileIn(dir: string): Promise<string | undefined> {
  for (const name of INSTRUCTION_NAMES) if (await isFile(path.join(dir, name))) return path.join(dir, name);
  return undefined;
}

type GitPaths = { readonly repoDir: string; readonly commonGitDir: string };

/** The nearest repository at or above `dir`: a `.git` directory, or a worktree's `.git` file naming its git dir. */
async function findGitPaths(dir: string): Promise<GitPaths | undefined> {
  for (let current = dir; ; current = path.dirname(current)) {
    const gitPath = path.join(current, '.git');
    const info = await stat(gitPath).catch(() => undefined);
    if (info?.isDirectory()) return { repoDir: current, commonGitDir: gitPath };
    if (info?.isFile()) {
      const content = (await readFile(gitPath, 'utf8')).trim();
      if (!content.startsWith('gitdir: ')) return undefined;
      const gitDir = path.resolve(current, content.slice('gitdir: '.length).trim());
      const common = await readFile(path.join(gitDir, 'commondir'), 'utf8').catch(() => undefined);
      return { repoDir: current, commonGitDir: common === undefined ? gitDir : path.resolve(gitDir, common.trim()) };
    }
    if (path.dirname(current) === current) return undefined;
  }
}

/**
 * The main repository's instruction file that a nested linked worktree's own copy shadows: both cover the same
 * repository, so loading both would apply it twice. Canonical, because git writes the worktree's gitdir as a real
 * path while the workspace may be reached through a symlink (on macOS, /tmp is /private/tmp).
 */
async function shadowedInstructionFile(workspace: string): Promise<string | undefined> {
  const git = await findGitPaths(workspace);
  if (git === undefined) return undefined;
  const commonGitDir = await canonical(git.commonGitDir);
  const worktreeRoot = await canonical(git.repoDir);
  const mainRepoRoot = path.dirname(commonGitDir);
  // False for an ordinary repository, and for a sibling worktree, whose main repository is not an ancestor.
  if (!worktreeRoot.startsWith(`${mainRepoRoot}${path.sep}`)) return undefined;
  // Only a main checkout of the same repository holds that git dir; a bare layout or a submodule does not.
  if ((await canonical(path.join(mainRepoRoot, '.git'))) !== commonGitDir) return undefined;
  const own = await instructionFileIn(worktreeRoot);
  return own === undefined ? undefined : path.join(mainRepoRoot, path.basename(own));
}

export const shownPath = (workspace: string, file: string): string => {
  const relative = path.relative(workspace, file);
  return relative.startsWith('..') || path.isAbsolute(relative) ? file : relative.split(path.sep).join('/');
};

/**
 * A file loaded on its own, and how far its imports may reach: a project file's stay under `scope`, while the user's
 * own files, with no scope, may import any file but a credentials file.
 */
type Root = { readonly file: string; readonly scope: string | undefined };

/** From the filesystem root down to the workspace, one instruction file per directory, then Claude Code's extras. */
async function projectRoots(workspace: string): Promise<Root[]> {
  const shadowed = await shadowedInstructionFile(workspace);
  const roots: Root[] = [];
  const seen = new Set<string>();
  for (let dir = workspace; ; dir = path.dirname(dir)) {
    const file = await instructionFileIn(dir);
    const real = file === undefined ? undefined : await canonical(file);
    // Walking up, a file reached twice is shown by its nearest path.
    if (file !== undefined && real !== undefined && real !== shadowed && !seen.has(real)) {
      roots.unshift({ file, scope: dir });
      seen.add(real);
    }
    if (path.dirname(dir) === dir) break;
  }
  return [...roots, ...WORKSPACE_EXTRAS.map((name) => ({ file: path.join(workspace, name), scope: workspace }))];
}

/** Where the user's own instruction files live: Geno's app home, the home `~` names, and Claude Code's config dir. */
export type UserDirs = { readonly app: string; readonly home: string | undefined; readonly claude: string | undefined };

const userRoots = (dirs: UserDirs): Root[] =>
  [globalRulesFile(dirs.app), ...(dirs.claude === undefined ? [] : [path.join(dirs.claude, 'CLAUDE.md')])].map((file) => ({ file, scope: undefined }));

/** The targets of the lines that are a lone `@path`, outside fenced code blocks. */
function importsOf(text: string): string[] {
  const targets: string[] = [];
  let fence: string | undefined;
  for (const line of text.split('\n')) {
    const marker = /^\s*(```|~~~)/.exec(line)?.[1];
    if (marker !== undefined) {
      if (fence === undefined) fence = marker;
      else if (fence === marker) fence = undefined;
      continue;
    }
    const target = /^\s*@(\S+)\s*$/.exec(line)?.[1];
    if (fence === undefined && target !== undefined) targets.push(target);
  }
  return targets;
}

type Read = { readonly kind: 'text'; readonly text: string } | { readonly kind: 'missing' } | { readonly kind: 'too-big'; readonly bytes: number };

async function readInstruction(file: string): Promise<Read> {
  const info = await stat(file).catch(() => undefined);
  if (info === undefined || !info.isFile()) return { kind: 'missing' };
  if (info.size > MAX_INSTRUCTION_BYTES) return { kind: 'too-big', bytes: info.size };
  const text = await readIfFile(file);
  return text === undefined ? { kind: 'missing' } : { kind: 'text', text };
}

const posix = (file: string): string => file.split(path.sep).join('/');

const within = (dir: string, file: string): boolean => {
  const relative = path.relative(dir, file);
  return !relative.startsWith('..') && !path.isAbsolute(relative);
};

/** One load of every instruction file: a file reached twice, by any route, loads the first time only. */
type Walk = { readonly workspace: string; readonly home: string | undefined; readonly seen: Set<string>; readonly problems: string[] };

/** The line that imported a file: the importer as shown, and the `@path` as written. */
type ImportLine = { readonly importer: string; readonly target: string };

/** The file an import names, or why it is skipped. */
async function importTarget(walk: Walk, root: Root, importer: string, target: string, depth: number): Promise<{ readonly file: string } | { readonly why: string }> {
  if (depth > MAX_IMPORT_DEPTH) return { why: `imports nest at most ${MAX_IMPORT_DEPTH} levels deep` };
  const fromHome = target.startsWith('~/');
  if (fromHome && walk.home === undefined) return { why: 'the environment names no home directory' };
  const file = fromHome ? path.join(walk.home ?? '', target.slice(2)) : path.resolve(path.dirname(importer), target);
  const real = await canonical(file);
  if (isSecretPath(posix(file)) || isSecretPath(posix(real))) return { why: 'it names a credentials file' };
  if (root.scope !== undefined && !within(await canonical(root.scope), real)) return { why: `a project file can import only files under ${root.scope}` };
  return { file };
}

/** `file`, then depth first the files its `@path` lines import, each right after its importer. */
async function withImports(walk: Walk, root: Root, file: string, from: ImportLine | undefined, depth: number): Promise<InstructionFile[]> {
  const real = await canonical(file);
  if (walk.seen.has(real)) return [];
  const shown = shownPath(walk.workspace, file);
  const skipped = (why: string) => walk.problems.push(from === undefined ? `${shown}: skipped, ${why}` : `${from.importer}: @${from.target} skipped, ${why}`);
  const read = await readInstruction(file);
  if (read.kind === 'too-big') skipped(`it is ${read.bytes.toLocaleString('en-US')} bytes, over the 4 MiB limit`);
  // A file loaded on its own is optional; one a line names should be there.
  if (read.kind === 'missing' && from !== undefined) skipped('there is no such file');
  if (read.kind !== 'text') return [];
  // The user's rules file starts out empty (ensureGlobalRules), and an empty file of theirs says nothing.
  if (root.scope === undefined && read.text.trim() === '') return [];
  walk.seen.add(real);
  const loaded: InstructionFile[] = [{ path: shown, text: read.text, ...(from === undefined ? {} : { importedFrom: from.importer }) }];
  for (const target of importsOf(read.text)) {
    const next = await importTarget(walk, root, file, target, depth + 1);
    if ('why' in next) walk.problems.push(`${shown}: @${target} skipped, ${next.why}`);
    else loaded.push(...(await withImports(walk, root, next.file, { importer: shown, target }, depth + 1)));
  }
  return loaded;
}

async function loadLayer(walk: Walk, roots: readonly Root[]): Promise<InstructionFile[]> {
  const loaded: InstructionFile[] = [];
  for (const root of roots) loaded.push(...(await withImports(walk, root, root.file, undefined, 0)));
  return loaded;
}

type ExecFailure = Error & { readonly code?: number | string; readonly killed?: boolean; readonly stdout?: string };

/**
 * Below the workspace, each directory's instruction file by the same precedence as above it, outer directories first.
 * ripgrep lists the candidates and skips `.git`, `node_modules`, what the repository ignores, and symlinks.
 */
async function nestedInstructionPaths(workspace: string, rg: string): Promise<{ readonly files: readonly string[] } | { readonly why: string }> {
  const names: readonly string[] = INSTRUCTION_NAMES;
  const args = ['--files', '--hidden', '--no-config', '--glob', '!.git', '--glob', '!node_modules', ...names.flatMap((name) => ['--glob', name]), '--', '.'];
  let listed: string;
  try {
    listed = (await execFileAsync(rg, args, { cwd: workspace, timeout: NESTED_SCAN_MS, maxBuffer: 64 * 1024 * 1024 })).stdout;
  } catch (error) {
    const failure = error as ExecFailure;
    if (failure.code === 'ENOENT') return { why: `ripgrep (${rg}) is not installed or not on PATH` };
    if (failure.killed === true) return { why: `listing the workspace took over ${NESTED_SCAN_MS / 1000} s` };
    // ripgrep exits 1 when nothing matched, and 2 after an unreadable directory, still listing the rest.
    if (typeof failure.code !== 'number') return { why: `ripgrep failed: ${failure.message}` };
    listed = failure.stdout ?? '';
  }
  const chosen = new Map<string, string>();
  for (const line of listed.split('\n')) {
    const file = line.replace(/^\.\//, '');
    const dir = path.posix.dirname(file);
    const name = path.posix.basename(file);
    if (dir === '.' || !names.includes(name)) continue;
    const held = chosen.get(dir);
    if (held === undefined || names.indexOf(name) < names.indexOf(held)) chosen.set(dir, name);
  }
  return { files: [...chosen].toSorted(([a], [b]) => comparePaths(a, b)).map(([dir, name]) => `${dir}/${name}`) };
}

/**
 * Each nested file with its imports, by the rules of the files the session opens with, and never one of those. A file
 * two directories import is listed under each, with its importer there; the attacher hands it out once.
 */
async function loadNested(walk: Walk, rg: string): Promise<NestedInstructionFile[]> {
  const found = await nestedInstructionPaths(walk.workspace, rg);
  if ('why' in found) {
    walk.problems.push(`nested instruction files not loaded: ${found.why}`);
    return [];
  }
  const opened = new Set(walk.seen);
  const nested: NestedInstructionFile[] = [];
  for (const file of found.files) {
    const absolute = path.join(walk.workspace, file);
    const loaded = await withImports({ ...walk, seen: new Set(opened) }, { file: absolute, scope: walk.workspace }, absolute, undefined, 0);
    nested.push(...loaded.filter((each) => each.text.trim() !== '').map((each) => ({ ...each, dir: path.posix.dirname(file) })));
  }
  return nested;
}

export type Frontmatter = { readonly fields: Readonly<Record<string, string | readonly string[]>>; readonly body: string };

/** A double-quoted value keeps YAML's escaped quotes and backslashes, as pstack's descriptions use them. */
const unquote = (value: string): string => {
  const quoted = /^(["'])(.*)\1$/.exec(value.trim());
  if (quoted === null) return value.trim();
  return quoted[1] === '"' ? quoted[2]!.replace(/\\(["\\])/g, '$1') : quoted[2]!;
};

/**
 * The `key: value` header between `---` lines. Not full YAML on purpose: Cursor writes `globs: *.ts`, which YAML
 * reads as an alias. A value may be a `- item` list, a `[a, b]` list, or a `>` or `|` block on indented lines.
 */
export function parseFrontmatter(text: string): Frontmatter {
  const match = /^---\n([\s\S]*?)\n---(?:\n|$)/.exec(text);
  if (match === null) return { fields: {}, body: text };
  const fields: Record<string, string | string[]> = {};
  const lines = match[1]!.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const field = /^([A-Za-z][\w-]*):(.*)$/.exec(lines[i]!);
    if (field === null) continue;
    const key = field[1]!;
    const value = field[2]!.trim();
    const nested: string[] = [];
    while (i + 1 < lines.length && /^\s+\S|^-\s/.test(lines[i + 1]!)) nested.push(lines[++i]!.trim());
    if (value.startsWith('[') && value.endsWith(']')) {
      fields[key] = value.slice(1, -1).split(',').map(unquote).filter((item) => item !== '');
    } else if (value === '' && nested.every((line) => line.startsWith('-'))) {
      fields[key] = nested.map((line) => unquote(line.slice(1)));
    } else if (/^[>|][+-]?$/.test(value)) {
      fields[key] = nested.join(value.startsWith('>') ? ' ' : '\n');
    } else {
      fields[key] = unquote([value, ...nested].join(' '));
    }
  }
  return { fields, body: text.slice(match[0].length) };
}

const asText = (value: string | readonly string[] | undefined): string => (typeof value === 'string' ? value.trim() : '');

const asList = (value: string | readonly string[] | undefined): string[] =>
  (typeof value === 'string' ? value.split(',') : (value ?? [])).map((item) => unquote(item)).filter((item) => item !== '');

/** How Cursor decides when a rule applies; undefined for a manual rule, which only an explicit mention would load. */
export function triggerOf(fields: Frontmatter['fields']): RuleTrigger | undefined {
  if (asText(fields['alwaysApply']).toLowerCase() === 'true') return { kind: 'always' };
  const globs = asList(fields['globs']);
  if (globs.length > 0) return { kind: 'globs', globs };
  const description = asText(fields['description']);
  return description === '' ? undefined : { kind: 'requested', description };
}

export const sortedEntries = async (dir: string) =>
  (await readdir(dir, { withFileTypes: true }).catch(() => [])).toSorted((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));

export async function loadCursorRules(workspace: string): Promise<ProjectRule[]> {
  const dir = path.join(workspace, RULES_DIR);
  const rules: ProjectRule[] = [];
  for (const entry of await sortedEntries(dir)) {
    if (!entry.name.endsWith('.mdc')) continue;
    const text = await readIfFile(path.join(dir, entry.name));
    if (text === undefined) continue;
    const { fields, body } = parseFrontmatter(text);
    const trigger = triggerOf(fields);
    if (trigger !== undefined) rules.push({ path: shownPath(workspace, path.join(dir, entry.name)), trigger, text: body.trim() });
  }
  return rules;
}

/** Skills by frontmatter name; one without a description is skipped, and a name already listed keeps its first. */
export async function loadSkills(workspace: string): Promise<SkillEntry[]> {
  const skills: SkillEntry[] = [];
  for (const root of SKILL_ROOTS) {
    for (const entry of await sortedEntries(path.join(workspace, root))) {
      if (!entry.isDirectory()) continue;
      const file = path.join(workspace, root, entry.name, 'SKILL.md');
      const text = await readIfFile(file);
      if (text === undefined) continue;
      const { fields } = parseFrontmatter(text);
      const name = asText(fields['name']) || entry.name;
      const description = asText(fields['description']);
      if (description === '' || skills.some((skill) => skill.name === name)) continue;
      skills.push({ name, description, path: shownPath(workspace, file) });
    }
  }
  return skills;
}

export const globalRulesFile = (home: string): string => path.join(home, 'AGENTS.md');

/** The global rules file, created empty when missing; one that exists is left as it is. */
export async function ensureGlobalRules(home: string): Promise<string> {
  const file = globalRulesFile(home);
  await mkdir(home, { recursive: true });
  await writeFile(file, '', { flag: 'wx' }).catch((error: unknown) => {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
  });
  return file;
}

/** What a session loads, and a line for the user about each file it skipped. */
export type ContextScan = { readonly context: LoadedContext; readonly problems: readonly string[] };

/**
 * `user` names where the user's own files live, which load first; undefined loads only the workspace's context. `rg`
 * is the ripgrep that lists the nested instruction files.
 */
export async function loadProjectContext(workspace: string, user?: UserDirs, rg = 'rg'): Promise<ContextScan> {
  const root = await canonical(workspace);
  const walk: Walk = { workspace: root, home: user?.home, seen: new Set(), problems: [] };
  // The user's files go first, so a project file that is one of them, or imports one, does not load it again.
  const own = user === undefined ? [] : await loadLayer(walk, userRoots(user));
  const instructions = await loadLayer(walk, await projectRoots(root));
  const [nested, rules, skills] = await Promise.all([loadNested(walk, rg), loadCursorRules(root), loadSkills(root)]);
  return { context: { ...(own.length === 0 ? {} : { user: own }), instructions, rules, skills, ...(nested.length === 0 ? {} : { nested }) }, problems: walk.problems };
}
