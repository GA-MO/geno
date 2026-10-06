import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import { MEMORY_SCOPES, memoryProblem, sortedMemory, type MemoryEntry, type MemoryScope } from '@g-code/core';
import { isMissing, StoreError } from './store.js';

/**
 * The memory store, under the app home and never in the repository: `memory/global.json` for every workspace, and
 * `memory/projects/<hash>.json` for one workspace, keyed by its real path. Each write replaces a whole file through
 * a rename, so a crash leaves the old file or the new one. A deleted note goes to `trash/memory/`.
 */

const entrySchema = z.strictObject({
  id: z.string().min(1),
  text: z.string(),
  scope: z.enum(MEMORY_SCOPES),
  createdAt: z.string(),
  sessionId: z.string().nullable(),
});

const fileSchema = z.strictObject({ version: z.literal(1), workspace: z.string().optional(), entries: z.array(entrySchema) });
type MemoryFile = z.infer<typeof fileSchema>;

export class MemoryError extends Error {}

export type MemoryStore = {
  /** The project's notes and the global ones, global first. */
  list(): Promise<MemoryEntry[]>;
  /** Keeps a note the user approved; refuses one over the caps. */
  add(text: string, scope: MemoryScope, sessionId: string | null): Promise<MemoryEntry>;
  edit(id: string, text: string): Promise<MemoryEntry[]>;
  /** Moves the note to the trash and answers with what is left. */
  remove(id: string): Promise<MemoryEntry[]>;
};

const workspaceKey = (workspace: string): string => createHash('sha256').update(workspace).digest('hex').slice(0, 32);

async function readMemoryFile(file: string): Promise<MemoryFile | undefined> {
  let text: string;
  try {
    text = await readFile(file, 'utf8');
  } catch (error) {
    if (isMissing(error)) return undefined;
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
  return parsed.data;
}

export async function writeAtomically(file: string, value: unknown): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true });
  const temporary = `${file}.${randomUUID()}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`);
  await rename(temporary, file);
}

/** `workspace` is the real path of the session's workspace. */
export function memoryStore(home: string, workspace: string): MemoryStore {
  const dir = path.join(home, 'memory');
  const files: Readonly<Record<MemoryScope, string>> = {
    global: path.join(dir, 'global.json'),
    project: path.join(dir, 'projects', `${workspaceKey(workspace)}.json`),
  };
  const read = async (scope: MemoryScope): Promise<MemoryEntry[]> => (await readMemoryFile(files[scope]))?.entries ?? [];
  const write = (scope: MemoryScope, entries: readonly MemoryEntry[]) =>
    writeAtomically(files[scope], { version: 1, ...(scope === 'project' ? { workspace } : {}), entries: sortedMemory(entries) });
  const list = async () => sortedMemory([...(await read('global')), ...(await read('project'))]);
  // Writes in this process take turns, so two approvals in a row never lose one another.
  let queue: Promise<unknown> = Promise.resolve();
  const serially = <T>(work: () => Promise<T>): Promise<T> => {
    const next = queue.then(work, work);
    queue = next.catch(() => {});
    return next;
  };
  const find = async (id: string) => {
    const entry = (await list()).find((e) => e.id === id);
    if (entry === undefined) throw new MemoryError(`no memory ${id}`);
    return entry;
  };

  return {
    list,
    add: (text, scope, sessionId) =>
      serially(async () => {
        const problem = memoryProblem(text, await list());
        if (problem !== undefined) throw new MemoryError(problem);
        const entry: MemoryEntry = { id: randomUUID(), text: text.trim(), scope, createdAt: new Date().toISOString(), sessionId };
        await write(scope, [...(await read(scope)), entry]);
        return entry;
      }),
    edit: (id, text) =>
      serially(async () => {
        const entry = await find(id);
        const problem = memoryProblem(text, await list(), id);
        if (problem !== undefined) throw new MemoryError(problem);
        await write(entry.scope, (await read(entry.scope)).map((e) => (e.id === id ? { ...e, text: text.trim() } : e)));
        return list();
      }),
    remove: (id) =>
      serially(async () => {
        const entry = await find(id);
        await writeAtomically(path.join(home, 'trash', 'memory', `${id}.json`), { ...entry, deletedAt: new Date().toISOString(), workspace });
        await write(entry.scope, (await read(entry.scope)).filter((e) => e.id !== id));
        return list();
      }),
  };
}
