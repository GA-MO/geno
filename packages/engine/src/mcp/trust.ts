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

export async function readTrust(store: Store): Promise<readonly McpTrustEntry[]> {
  let text: string;
  try {
    text = await readFile(store.mcpTrustFile, 'utf8');
  } catch (error) {
    if (isMissing(error)) return [];
    throw error;
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (error) {
    throw new StoreError(store.mcpTrustFile, (error as Error).message);
  }
  const parsed = trustFileSchema.safeParse(raw);
  if (!parsed.success) throw new StoreError(store.mcpTrustFile, z.prettifyError(parsed.error));
  return parsed.data.servers;
}

/** Approves this exact definition for this workspace. It replaces an older approval of the same name, so a changed server is one entry. */
export async function approveServer(store: Store, workspace: string, config: McpServerConfig): Promise<McpTrustEntry> {
  const entry: McpTrustEntry = { workspace, name: config.name, hash: definitionHash(config), approvedAt: new Date().toISOString() };
  const kept = (await readTrust(store)).filter((old) => old.workspace !== workspace || old.name !== config.name);
  const servers = [...kept, entry].sort((a, b) => (a.workspace === b.workspace ? (a.name < b.name ? -1 : 1) : a.workspace < b.workspace ? -1 : 1));
  await mkdir(path.dirname(store.mcpTrustFile), { recursive: true });
  const tmp = `${store.mcpTrustFile}.${process.pid}.tmp`;
  await writeFile(tmp, `${JSON.stringify({ version: 1, servers }, null, 2)}\n`);
  await rename(tmp, store.mcpTrustFile);
  return entry;
}
