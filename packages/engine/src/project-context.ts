// Portions ported from Pi (https://github.com/earendil-works/pi) at b2b5c42, Copyright (c) 2025 Mario Zechner, MIT License.

import { mkdir, readdir, readFile, realpath, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { stripHidden, type InstructionFile, type LoadedContext, type ProjectRule, type RuleTrigger, type SkillEntry } from '@g-code/core';

/** Per directory the first of these that is a file wins. */
const INSTRUCTION_NAMES = ['AGENTS.override.md', 'AGENTS.md', 'CLAUDE.md'] as const;
const RULES_DIR = path.join('.cursor', 'rules');
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

async function instructionFileIn(dir: string): Promise<{ readonly file: string; readonly text: string } | undefined> {
  for (const name of INSTRUCTION_NAMES) {
    const file = path.join(dir, name);
    const text = await readIfFile(file);
    if (text !== undefined) return { file, text };
  }
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
  return own === undefined ? undefined : path.join(mainRepoRoot, path.basename(own.file));
}

export const shownPath = (workspace: string, file: string): string => {
  const relative = path.relative(workspace, file);
  return relative.startsWith('..') || path.isAbsolute(relative) ? file : relative.split(path.sep).join('/');
};

/** From the filesystem root down to the workspace, one instruction file per directory. */
export async function loadInstructionFiles(workspace: string): Promise<InstructionFile[]> {
  const shadowed = await shadowedInstructionFile(workspace);
  const found: InstructionFile[] = [];
  const seen = new Set<string>();
  for (let dir = workspace; ; dir = path.dirname(dir)) {
    const candidate = await instructionFileIn(dir);
    const real = candidate === undefined ? undefined : await canonical(candidate.file);
    if (candidate !== undefined && real !== undefined && real !== shadowed && !seen.has(real)) {
      found.unshift({ path: shownPath(workspace, candidate.file), text: candidate.text });
      seen.add(real);
    }
    if (path.dirname(dir) === dir) return found;
  }
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

/** `$GCODE_HOME/AGENTS.md`, the user's rules for every project; undefined when it is missing or blank. */
export async function loadGlobalInstructions(home: string): Promise<InstructionFile | undefined> {
  const file = globalRulesFile(home);
  const text = await readIfFile(file);
  return text === undefined || text.trim() === '' ? undefined : { path: file, text };
}

/** The global rules file, created empty when missing; one that exists is left as it is. */
export async function ensureGlobalRules(home: string): Promise<string> {
  const file = globalRulesFile(home);
  await mkdir(home, { recursive: true });
  await writeFile(file, '', { flag: 'wx' }).catch((error: unknown) => {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
  });
  return file;
}

/** `home` is the app home, whose AGENTS.md loads first; undefined loads only the workspace's context. */
export async function loadProjectContext(workspace: string, home?: string): Promise<LoadedContext> {
  const root = await canonical(workspace);
  const [global, loaded, rules, skills] = await Promise.all([
    home === undefined ? undefined : loadGlobalInstructions(home),
    loadInstructionFiles(root),
    loadCursorRules(root),
    loadSkills(root),
  ]);
  if (global === undefined) return { instructions: loaded, rules, skills };
  // A home inside the workspace's ancestry would otherwise load the same file twice.
  const globalReal = await canonical(global.path);
  const instructions = [];
  for (const file of loaded) if ((await canonical(path.resolve(root, file.path))) !== globalReal) instructions.push(file);
  return { global, instructions, rules, skills };
}
