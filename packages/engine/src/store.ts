import { mkdir, readdir, readFile, rename, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import { z } from 'zod';
import { EngineError } from './errors.js';
import {
  appHomeOf,
  asTaskId,
  asTripleId,
  TRIPLE_SCOPES,
  type ApplyTriple,
  type EvalTask,
  type TaskId,
  type TripleId,
} from '@g-code/core';

export class StoreError extends EngineError {
  constructor(
    readonly file: string,
    detail: string,
  ) {
    super(`${file}: ${detail}`);
  }
}

const absolutePath = z.string().refine(path.isAbsolute, 'must be an absolute path');

const evalTaskSchema = z.strictObject({
  id: z.string().min(1).transform(asTaskId),
  repo: absolutePath,
  baseCommit: z.string().min(1),
  prompt: z.string(),
  setup: z.string(),
  verify: z.string(),
});

const applyTripleSchema = z.strictObject({
  id: z.string().min(1).transform(asTripleId),
  // Triples mined before file slicing existed carry no scope; they were all whole commits.
  scope: z.enum(TRIPLE_SCOPES).default('commit'),
  repo: absolutePath,
  commit: z.string().min(1),
  path: z.string().min(1),
  instruction: z.string(),
  before: z.string(),
  expected: z.string(),
});

export type Store = {
  readonly evalsDir: string;
  readonly tasksDir: string;
  readonly triplesDir: string;
  readonly sessionsDir: string;
  /** Deleted session logs, kept rather than erased. */
  readonly trashDir: string;
  readonly spillDir: string;
  readonly checkpointsDir: string;
  readonly tabEvents: string;
  /** The user's own MCP servers, trusted. */
  readonly mcpConfigFile: string;
  /** The workspace MCP servers the user approved. */
  readonly mcpTrustFile: string;
  /** The MCP servers the user turned off, per workspace. */
  readonly mcpDisabledFile: string;
};

export function openStore(env: Readonly<Record<string, string | undefined>>): Store {
  const root = appHomeOf(env, homedir());
  const evalsDir = path.join(root, 'evals');
  return {
    evalsDir,
    sessionsDir: path.join(root, 'sessions'),
    trashDir: path.join(root, 'trash'),
    spillDir: path.join(root, 'spill'),
    checkpointsDir: path.join(root, 'checkpoints'),
    tabEvents: path.join(root, 'tab-events.jsonl'),
    mcpConfigFile: path.join(root, 'mcp.json'),
    mcpTrustFile: path.join(root, 'mcp-trust.json'),
    mcpDisabledFile: path.join(root, 'mcp-disabled.json'),
    tasksDir: path.join(evalsDir, 'tasks'),
    triplesDir: path.join(evalsDir, 'apply'),
  };
}

/** `~/.g-code`, or GCODE_HOME: the store keeps everything under it. */
export const homeOf = (store: Store): string => path.dirname(store.sessionsDir);

export const isMissing = (error: unknown): boolean => (error as NodeJS.ErrnoException).code === 'ENOENT';

async function parseFile<T>(file: string, schema: z.ZodType<T>): Promise<T> {
  const text = await readFile(file, 'utf8');
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (error) {
    throw new StoreError(file, error instanceof Error ? error.message : String(error));
  }
  const parsed = schema.safeParse(raw);
  if (!parsed.success) throw new StoreError(file, z.prettifyError(parsed.error));
  return parsed.data;
}

async function readDir<T>(dir: string, schema: z.ZodType<T>): Promise<T[]> {
  let names: string[];
  try {
    names = await readdir(dir);
  } catch (error) {
    if (isMissing(error)) return [];
    throw error;
  }
  const files = names.filter((name) => name.endsWith('.json')).sort();
  return Promise.all(files.map((name) => parseFile(path.join(dir, name), schema)));
}

export const readTasks = (store: Store): Promise<EvalTask[]> => readDir(store.tasksDir, evalTaskSchema);

export const taskDir = (store: Store, id: TaskId): string => path.join(store.tasksDir, id);

export async function readTask(store: Store, id: TaskId): Promise<EvalTask | undefined> {
  try {
    return await parseFile(path.join(store.tasksDir, `${id}.json`), evalTaskSchema);
  } catch (error) {
    if (isMissing(error)) return undefined;
    throw error;
  }
}

export const readTriples = (store: Store): Promise<ApplyTriple[]> =>
  readDir(store.triplesDir, applyTripleSchema);

export const tripleFile = (store: Store, id: TripleId): string =>
  path.join(store.triplesDir, `${id}.json`);

export async function readTriple(store: Store, id: TripleId): Promise<ApplyTriple | undefined> {
  const file = tripleFile(store, id);
  try {
    return await parseFile(file, applyTripleSchema);
  } catch (error) {
    if (isMissing(error)) return undefined;
    throw error;
  }
}

export async function writeTriple(store: Store, triple: ApplyTriple): Promise<void> {
  await mkdir(store.triplesDir, { recursive: true });
  const file = tripleFile(store, triple.id);
  const tmp = `${file}.${process.pid}.tmp`;
  await writeFile(tmp, `${JSON.stringify(triple, null, 2)}\n`);
  await rename(tmp, file);
}
