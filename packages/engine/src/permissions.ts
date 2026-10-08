import { createHash, randomUUID } from 'node:crypto';
import { readFile, realpath } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import {
  claudePermissions,
  DOMAIN_TOOLS,
  isCommandRule,
  isDomainRule,
  isMcpToolRule,
  isPathRule,
  PATH_EFFECTS,
  PATH_TOOLS,
  RULE_EFFECTS,
  type CommandScope,
  type DeniedTool,
  type NewRule,
  type PermissionRule,
  type PermissionsFile,
} from '@g-code/core';
import type { AddedDirectory } from './directories.js';
import { claudeSettingsFiles } from './hook-config.js';
import { laneAt } from './lanes.js';
import { readJson } from './plugins.js';
import { writeAtomically } from './memory.js';
import { isMissing, StoreError } from './store.js';

/**
 * The workspace's permission rules, under the app home and never in the repository:
 * `permissions/<hash>.json`, keyed by the workspace's real path. A lane shares its main checkout's rules.
 */
export type PermissionStore = {
  readonly workspace: string;
  list(): Promise<readonly PermissionRule[]>;
  /** Saves a rule; one with the same target (`sameTarget`) is replaced, so saving twice keeps one. */
  add(rule: NewRule): Promise<readonly PermissionRule[]>;
  remove(id: string): Promise<readonly PermissionRule[]>;
};

const ruleSchema = z.union([
  z.strictObject({
    id: z.string().min(1),
    effect: z.enum(RULE_EFFECTS),
    pattern: z.tuple([z.string().min(1)], z.string()),
    exact: z.literal(true).optional(),
    createdAt: z.string(),
  }),
  z.strictObject({
    id: z.string().min(1),
    effect: z.enum(PATH_EFFECTS),
    tool: z.enum(PATH_TOOLS),
    path: z.string().min(1),
    createdAt: z.string(),
  }),
  z.strictObject({
    id: z.string().min(1),
    effect: z.enum(RULE_EFFECTS),
    tool: z.enum(DOMAIN_TOOLS),
    domain: z.string().min(1),
    createdAt: z.string(),
  }),
  z.strictObject({
    id: z.string().min(1),
    effect: z.enum(RULE_EFFECTS),
    mcp: z.string().min(1),
    createdAt: z.string(),
  }),
]);
const fileSchema = z.strictObject({ version: z.literal(1), workspace: z.string(), rules: z.array(ruleSchema) });

const sameWords = (a: readonly string[], b: readonly string[]) => a.length === b.length && a.every((word, i) => word === b[i]);
/** Whether a new rule replaces an old one: the same words, the same tool and path or domain, or the same MCP name. */
const sameTarget = (a: PermissionRule, b: NewRule): boolean => {
  if (isPathRule(a) && isPathRule(b)) return a.tool === b.tool && a.path === b.path;
  if (isDomainRule(a) && isDomainRule(b)) return a.tool === b.tool && a.domain === b.domain;
  if (isMcpToolRule(a) && isMcpToolRule(b)) return a.mcp === b.mcp;
  return isCommandRule(a) && isCommandRule(b) && sameWords(a.pattern, b.pattern);
};

/** The workspace whose rules a session follows: its main checkout when it runs in a lane. */
export async function rulesWorkspace(workspace: string, home: string | undefined): Promise<string> {
  const real = await realpath(workspace).catch(() => workspace);
  return (await laneAt(real, home).catch(() => undefined))?.repo.main ?? real;
}

export function permissionStore(appHome: string, workspace: string, now: () => Date = () => new Date()): PermissionStore {
  const file = path.join(appHome, 'permissions', `${createHash('sha256').update(workspace).digest('hex').slice(0, 32)}.json`);

  async function read(): Promise<readonly PermissionRule[]> {
    let text: string;
    try {
      text = await readFile(file, 'utf8');
    } catch (error) {
      if (isMissing(error)) return [];
      throw error;
    }
    let raw: unknown;
    try {
      raw = JSON.parse(text);
    } catch (error) {
      throw new StoreError(file, (error as Error).message);
    }
    const parsed = fileSchema.safeParse(raw);
    if (!parsed.success) throw new StoreError(file, z.prettifyError(parsed.error));
    return parsed.data.rules as readonly PermissionRule[];
  }

  async function write(rules: readonly PermissionRule[]): Promise<readonly PermissionRule[]> {
    const record: PermissionsFile = { version: 1, workspace, rules };
    await writeAtomically(file, record);
    return rules;
  }

  return {
    workspace,
    list: read,
    async add(rule) {
      const kept = (await read()).filter((old) => !sameTarget(old, rule));
      return write([...kept, { ...rule, id: randomUUID(), createdAt: now().toISOString() }]);
    },
    async remove(id) {
      return write((await read()).filter((rule) => rule.id !== id));
    },
  };
}

/** Where a session finds Claude Code's settings, and whether VS Code trusts the workspace. */
export type ClaudeSettingsSources = { readonly claudeDir: string | undefined; readonly trusted: boolean };

export type SourcedDeniedTool = DeniedTool & { readonly source: string };

/**
 * A workspace's rules with Claude Code's beneath them, the tools a Claude Code file denies by name, and the
 * `additionalDirectories` its files add, as written and read-only.
 */
export type SessionPermissions = PermissionStore & {
  deniedTool(tool: string): Promise<SourcedDeniedTool | undefined>;
  directories(): Promise<readonly AddedDirectory[]>;
};

/**
 * Geno's own store over Claude Code's settings files, read at each call as the store is. Deny and ask rules from every
 * file apply; an allow from the repository's files only in a trusted workspace, since anyone who can commit wrote it.
 * The local file comes before the shared one and the shared one before the user's. That orders only which rule a
 * refusal names, as a deny anywhere beats an allow anywhere. A rule Geno cannot apply is reported once through `warn`.
 * The repository's `additionalDirectories` also wait for trust, since reading a directory unasked is an allow.
 */
export function layeredPermissions(store: PermissionStore, { claudeDir, trusted }: ClaudeSettingsSources, scope: CommandScope, warn: (line: string) => void): SessionPermissions {
  const warned = new Set<string>();
  const once = (line: string) => {
    if (warned.has(line)) return;
    warned.add(line);
    warn(line);
  };
  const shown = (file: string): string => {
    if (file.startsWith(`${store.workspace}${path.sep}`)) return path.relative(store.workspace, file);
    return file.startsWith(`${scope.home}${path.sep}`) ? `~/${path.relative(scope.home, file)}` : file;
  };

  async function imported(): Promise<{ readonly rules: readonly PermissionRule[]; readonly deniedTools: readonly SourcedDeniedTool[]; readonly directories: readonly AddedDirectory[] }> {
    const rules: PermissionRule[] = [];
    const deniedTools: SourcedDeniedTool[] = [];
    const directories: AddedDirectory[] = [];
    for (const { file, scope: from } of claudeSettingsFiles(claudeDir, store.workspace).toReversed()) {
      const source = shown(file);
      const raw = await readJson(file);
      if (raw.kind === 'broken') once(`permissions: ${source} is not valid JSON, so its rules do not apply: ${raw.reason}`);
      if (raw.kind !== 'read') continue;
      const parsed = claudePermissions(raw.value, { ...scope, workspace: store.workspace });
      if (parsed.skipped.length > 0) once(`permissions: ${source}: Geno skips the rules it cannot apply: ${parsed.skipped.join(', ')}`);
      const held = !trusted && from === 'project' ? parsed.rules.filter((rule) => rule.effect === 'allow').length : 0;
      if (held > 0) once(`permissions: ${source}: ${held} allow ${held === 1 ? 'rule waits' : 'rules wait'} for a trusted workspace`);
      parsed.rules.forEach((rule, i) => {
        if (rule.effect !== 'allow' || from === 'user' || trusted) rules.push({ ...rule, id: `${source}#${i}`, createdAt: '', source } as PermissionRule);
      });
      deniedTools.push(...parsed.deniedTools.map((denied) => ({ ...denied, source })));
      if (!trusted && from === 'project' && parsed.directories.length > 0) once(`permissions: ${source}: additionalDirectories ${parsed.directories.length === 1 ? 'waits' : 'wait'} for a trusted workspace`);
      // Read-only: Claude Code asks before an edit there, and Geno, which edits unasked, keeps no checkpoint outside the workspace.
      else directories.push(...parsed.directories.map((given) => ({ path: given, writable: false, source })));
    }
    return { rules, deniedTools, directories };
  }

  return {
    ...store,
    async list() {
      return [...(await store.list()), ...(await imported()).rules];
    },
    async deniedTool(tool) {
      return (await imported()).deniedTools.find((denied) => denied.tool === tool);
    },
    async directories() {
      return (await imported()).directories;
    },
  };
}
