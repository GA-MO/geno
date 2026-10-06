import { createHash, randomUUID } from 'node:crypto';
import { readFile, realpath } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import { RULE_EFFECTS, type CommandPattern, type PermissionRule, type PermissionsFile, type RuleEffect } from '@g-code/core';
import { laneAt } from './lanes.js';
import { writeAtomically } from './memory.js';
import { isMissing, StoreError } from './store.js';

/**
 * The workspace's permission rules, under the app home and never in the repository:
 * `permissions/<hash>.json`, keyed by the workspace's real path. A lane shares its main checkout's rules.
 */
export type PermissionStore = {
  readonly workspace: string;
  list(): Promise<readonly PermissionRule[]>;
  /** Saves a rule; one for the same pattern is replaced, so saving twice keeps one. */
  add(effect: RuleEffect, pattern: CommandPattern): Promise<readonly PermissionRule[]>;
  remove(id: string): Promise<readonly PermissionRule[]>;
};

const ruleSchema = z.strictObject({
  id: z.string().min(1),
  effect: z.enum(RULE_EFFECTS),
  pattern: z.tuple([z.string().min(1)], z.string()),
  createdAt: z.string(),
});
const fileSchema = z.strictObject({ version: z.literal(1), workspace: z.string(), rules: z.array(ruleSchema) });

const sameWords = (a: readonly string[], b: readonly string[]) => a.length === b.length && a.every((word, i) => word === b[i]);

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
    async add(effect, pattern) {
      const kept = (await read()).filter((rule) => !sameWords(rule.pattern, pattern));
      return write([...kept, { id: randomUUID(), effect, pattern, createdAt: now().toISOString() }]);
    },
    async remove(id) {
      return write((await read()).filter((rule) => rule.id !== id));
    },
  };
}
