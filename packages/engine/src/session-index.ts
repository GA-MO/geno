import { realpathSync } from 'node:fs';
import { readdir, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { inScope, searchSessions, sessionDoc, type SearchHit, type SearchOptions, type SessionDoc, type SessionScope } from '@g-code/core';
import { titleOf } from './session-replay.js';
import { readSessionLog } from './sessions.js';
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

/** A log as it was last read: its size and change time say whether it changed since, and `doc` is undefined for a subagent's log. */
type Entry = { readonly size: number; readonly mtimeMs: number; readonly doc: SessionDoc | undefined };

export type Warn = (line: string) => void;

/**
 * The store's session logs as the history lists them and the search reads them, held in memory and built on first
 * use. Each use first checks every log's size and change time and reads again only the logs that changed, so a log
 * written since is seen and a trashed one is gone.
 */
export class SessionIndex {
  private readonly entries = new Map<string, Entry>();
  private refreshed: Promise<readonly SessionDoc[]> = Promise.resolve([]);

  constructor(private readonly store: Store) {}

  /** The scope's best hits for the query. */
  async search(query: string, scope: SessionScope, options: SearchOptions, warn: Warn): Promise<SearchHit[]> {
    const docs = await this.docs(warn);
    return searchSessions(
      docs.filter((doc) => inScope(doc.summary, scope, TEMP_ROOTS)),
      query,
      options,
    );
  }

  /**
   * Every session's entry as of now; a log that cannot be read is reported and skipped. One refresh runs at a time,
   * so two searches typed in a row never read a log twice.
   */
  docs(warn: Warn): Promise<readonly SessionDoc[]> {
    const refresh = () => this.refresh(warn);
    this.refreshed = this.refreshed.then(refresh, refresh);
    return this.refreshed;
  }

  private async refresh(warn: Warn): Promise<readonly SessionDoc[]> {
    const dir = this.store.sessionsDir;
    let names: string[];
    try {
      names = (await readdir(dir)).filter((name) => name.endsWith('.jsonl'));
    } catch (error) {
      if (!isMissing(error)) throw error;
      names = [];
    }
    const files = new Set(names.map((name) => path.join(dir, name)));
    for (const file of this.entries.keys()) if (!files.has(file)) this.entries.delete(file);
    await Promise.all([...files].map((file) => this.update(file, warn)));
    return [...this.entries.values()].flatMap((entry) => (entry.doc === undefined ? [] : [entry.doc]));
  }

  private async update(file: string, warn: Warn): Promise<void> {
    try {
      const { size, mtimeMs } = await stat(file);
      const known = this.entries.get(file);
      if (known !== undefined && known.size === size && known.mtimeMs === mtimeMs) return;
      const log = await readSessionLog(file);
      const start = log.events[0];
      // A subagent's session belongs to its parent's chat, not the history.
      const child = start?.kind === 'session-start' && start.child !== undefined;
      this.entries.set(file, { size, mtimeMs, doc: child ? undefined : sessionDoc(log.session, log.events, titleOf) });
    } catch (error) {
      this.entries.delete(file);
      if (!isMissing(error)) warn(`warning: skipped ${path.basename(file)}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
}

const indexes = new Map<string, SessionIndex>();

/** The one index of the store's sessions in this process, which the history, its search and every run's recall share. */
export function sessionIndex(store: Store): SessionIndex {
  const known = indexes.get(store.sessionsDir);
  if (known !== undefined) return known;
  const index = new SessionIndex(store);
  indexes.set(store.sessionsDir, index);
  return index;
}
