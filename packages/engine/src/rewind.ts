import { parseArgs } from 'node:util';
import { nextSeq, type TurnEvent } from '@g-code/core';
import { openSessionLog } from './chat.js';
import { restore, shadowRepoFor } from './checkpoints.js';
import { UsageError, type Command } from './command.js';
import { EngineError } from './errors.js';
import { appendEvent, dropTornTail, type SessionLog } from './sessions.js';
import type { Store } from './store.js';

export const checkpointsOf = (events: readonly TurnEvent[]) =>
  events.filter((e): e is Extract<TurnEvent, { kind: 'checkpoint' }> => e.kind === 'checkpoint');

/** Restores the workspace to the checkpoint before `turnSeq` and logs it. Returns the workspace-relative paths it touched. */
export async function rewindTo(store: Store, log: SessionLog, turnSeq: number): Promise<{ readonly sha: string; readonly files: string[] }> {
  const checkpoints = checkpointsOf(log.events);
  const checkpoint = checkpoints.find((c) => c.turnSeq === turnSeq);
  if (checkpoint === undefined) {
    const known = checkpoints.map((c) => c.turnSeq).join(', ') || 'none';
    throw new EngineError(`session ${log.session.id} has no checkpoint before turn ${turnSeq}; checkpoints exist before turns: ${known}`);
  }
  const files = await restore(shadowRepoFor(store, log.session.workspace), checkpoint.sha);
  await dropTornTail(log);
  await appendEvent(log.file, { kind: 'restored', seq: nextSeq(log.events), at: new Date().toISOString(), turnSeq, sha: checkpoint.sha, files });
  return { sha: checkpoint.sha, files };
}

export const rewind: Command = async (args, { io, store }) => {
  const { values } = parseArgs({ args, strict: true, options: { session: { type: 'string' }, to: { type: 'string' } } });
  if (values.session === undefined || values.to === undefined) throw new UsageError('--session and --to are required');
  const turnSeq = Number(values.to);
  if (!Number.isInteger(turnSeq) || turnSeq < 1) throw new UsageError('--to must be a turn number');

  const log = await openSessionLog(store, values.session, io);
  const { sha, files } = await rewindTo(store, log, turnSeq);
  io.out(`restored ${log.session.workspace} to the checkpoint before turn ${turnSeq} (${sha.slice(0, 12)})`);
  for (const file of files) io.out(`  ${file}`);
  if (files.length === 0) io.out('  no files changed');
  return 0;
};
