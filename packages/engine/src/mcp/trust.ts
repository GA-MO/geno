import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import { definitionHash, type McpServerConfig, type McpTrustEntry } from '@g-code/core';
import { isMissing, StoreError, type Store } from '../store.js';

const trustFileSchema = z.strictObject({
  version: z.literal(1),
  servers: z.array(
    z.strictObject({ workspace: z.string().min(1), name: z.string().min(1), hash: z.string().startsWith('sha256:'), approvedAt: z.string() }),
  ),
});

const disabledFileSchema = z.strictObject({
  version: z.literal(1),
  servers: z.array(z.strictObject({ workspace: z.string().min(1), name: z.string().min(1) })),
});

async function readJson<T>(file: string, schema: z.ZodType<T>, empty: T): Promise<T> {
  let text: string;
  try {
    text = await readFile(file, 'utf8');
  } catch (error) {
    if (isMissing(error)) return empty;
    throw error;
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (error) {
    throw new StoreError(file, (error as Error).message);
  }
  const parsed = schema.safeParse(raw);
  if (!parsed.success) throw new StoreError(file, z.prettifyError(parsed.error));
  return parsed.data;
}

async function writeJson(file: string, value: unknown): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  await writeFile(tmp, `${JSON.stringify(value, null, 2)}\n`);
  await rename(tmp, file);
}

type Keyed = { readonly workspace: string; readonly name: string };
const byWorkspaceThenName = (a: Keyed, b: Keyed): number => (a.workspace === b.workspace ? (a.name < b.name ? -1 : 1) : a.workspace < b.workspace ? -1 : 1);

export async function readTrust(store: Store): Promise<readonly McpTrustEntry[]> {
  return (await readJson(store.mcpTrustFile, trustFileSchema, { version: 1, servers: [] })).servers;
}

/** Approves this exact definition for this workspace. It replaces an older approval of the same name, so a changed server is one entry. */
export async function approveServer(store: Store, workspace: string, config: McpServerConfig): Promise<McpTrustEntry> {
  const entry: McpTrustEntry = { workspace, name: config.name, hash: definitionHash(config), approvedAt: new Date().toISOString() };
  const kept = (await readTrust(store)).filter((old) => old.workspace !== workspace || old.name !== config.name);
  await writeJson(store.mcpTrustFile, { version: 1, servers: [...kept, entry].sort(byWorkspaceThenName) });
  return entry;
}

/** The names of the servers the user turned off in this workspace. */
export async function readDisabled(store: Store, workspace: string): Promise<ReadonlySet<string>> {
  const { servers } = await readJson(store.mcpDisabledFile, disabledFileSchema, { version: 1, servers: [] });
  return new Set(servers.filter((entry) => entry.workspace === workspace).map((entry) => entry.name));
}

export async function setDisabled(store: Store, workspace: string, name: string, disabled: boolean): Promise<void> {
  const { servers } = await readJson(store.mcpDisabledFile, disabledFileSchema, { version: 1, servers: [] });
  const kept = servers.filter((entry) => entry.workspace !== workspace || entry.name !== name);
  await writeJson(store.mcpDisabledFile, { version: 1, servers: (disabled ? [...kept, { workspace, name }] : kept).sort(byWorkspaceThenName) });
}
