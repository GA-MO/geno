import { realpathSync } from 'node:fs';
import { mkdir, readdir, rename } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { parseArgs } from 'node:util';
import {
  byRecency,
  inScope,
  nextSeq,
  summarizeSession,
  titleFrom,
  type SessionScope,
  type SessionSummary,
} from '@g-code/core';
import { openSessionLog } from './chat.js';
import { UsageError, type Command, type Io } from './command.js';
import { workspaceDir } from './drive.js';
import { appendEvent, dropTornTail, readSessionLog } from './sessions.js';
import { isMissing, type Store } from './store.js';

const realOrSelf = (dir: string): string => {
  try {
    return realpathSync(dir);
  } catch {
    return dir;
  }
};

/** Where eval clones and test workspaces live, as logged (resolved) and as written. */
export const TEMP_ROOTS: readonly string[] = [
  ...new Set([tmpdir(), realOrSelf(tmpdir()), '/tmp', '/private/tmp', '/var/folders', '/private/var/folders']),
];

/** Every session log in the store that the scope shows, newest first. A log that cannot be read is reported and skipped. */
export async function listSessions(store: Store, io: Io, scope: SessionScope): Promise<SessionSummary[]> {
  let names: string[];
  try {
    names = await readdir(store.sessionsDir);
  } catch (error) {
    if (isMissing(error)) return [];
    throw error;
  }
  const summaries = await Promise.all(
    names
      .filter((name) => name.endsWith('.jsonl'))
      .map(async (name) => {
        try {
          const log = await readSessionLog(path.join(store.sessionsDir, name));
          // A subagent's session belongs to its parent's chat, not the history.
          const start = log.events[0];
          if (start?.kind === 'session-start' && start.child !== undefined) return [];
          return [summarizeSession(log.session, log.events)];
        } catch (error) {
          io.err(`warning: skipped ${name}: ${error instanceof Error ? error.message : String(error)}`);
          return [];
        }
      }),
  );
  return summaries
    .flat()
    .filter((summary) => inScope(summary, scope, TEMP_ROOTS))
    .sort(byRecency);
}

/** Logs a title for the session and returns it as stored: one line, cut to fit. */
export async function renameSession(store: Store, io: Io, rawId: string, title: string): Promise<string> {
  const stored = titleFrom(title);
  if (stored === '') throw new UsageError('a title needs some text');
  const log = await openSessionLog(store, rawId, io);
  await dropTornTail(log);
  await appendEvent(log.file, { kind: 'title', seq: nextSeq(log.events), at: new Date().toISOString(), title: stored });
  return stored;
}

/**
 * Moves the session's log, and the folder of its attachments when it has one, to the trash, where they can be
 * restored by hand. A name already in the trash gets a timestamp.
 */
export async function trashSession(store: Store, io: Io, rawId: string): Promise<string> {
  const log = await openSessionLog(store, rawId, io);
  await mkdir(store.trashDir, { recursive: true });
  const id = log.session.id;
  const taken = new Set(await readdir(store.trashDir));
  const stem = taken.has(`${id}.jsonl`) || taken.has(id) ? `${id}.${Date.now()}` : id;
  const folder = path.join(store.sessionsDir, id);
  await rename(folder, path.join(store.trashDir, stem)).catch((error: unknown) => {
    if (!isMissing(error)) throw error;
  });
  const target = path.join(store.trashDir, `${stem}.jsonl`);
  await rename(log.file, target);
  return target;
}

const formatCostUsd = (costUsd: number | null): string => (costUsd === null ? 'cost unknown' : `$${costUsd.toFixed(4)}`);

export const listSessionsCommand: Command = async (args, { io, store }) => {
  const { values } = parseArgs({ args, strict: true, options: { all: { type: 'boolean', default: false } } });
  const workspace = await workspaceDir(io.cwd, '.');
  const scope: SessionScope = values.all ? { kind: 'all' } : { kind: 'project', workspace };
  const sessions = await listSessions(store, io, scope);
  for (const s of sessions) {
    const turns = `${s.turns} ${s.turns === 1 ? 'turn' : 'turns'}`;
    io.out(`${s.id}  ${s.updatedAt}  ${turns.padStart(9)}  ${formatCostUsd(s.costUsd).padStart(12)}  ${path.basename(s.workspace)}  ${s.title}`);
  }
  io.out(`${sessions.length} ${sessions.length === 1 ? 'session' : 'sessions'} in ${values.all ? 'every project' : workspace}`);
  return 0;
};
