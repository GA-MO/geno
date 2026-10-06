import { randomUUID } from 'node:crypto';
import { cp, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { parseArgs } from 'node:util';
import {
  asSessionId,
  checkpointOfTurn,
  forkEvents,
  nextSeq,
  promptAt,
  REWINDS,
  titleOf,
  UNTITLED,
  type RewindChoice,
  type TurnEvent,
} from '@g-code/core';
import { openSessionLog } from './chat.js';
import { changedSince, restore, shadowRepoFor } from './checkpoints.js';
import { UsageError, type Command } from './command.js';
import { EngineError } from './errors.js';
import { appendEvent, dropTornTail, readSessionLog, sessionFile, type SessionLog } from './sessions.js';
import { isMissing, type Store } from './store.js';

type CheckpointEvent = Extract<TurnEvent, { kind: 'checkpoint' }>;

export const checkpointsOf = (events: readonly TurnEvent[]) => events.filter((e): e is CheckpointEvent => e.kind === 'checkpoint');

async function restoreCheckpoint(store: Store, log: SessionLog, checkpoint: CheckpointEvent): Promise<string[]> {
  const files = await restore(shadowRepoFor(store, log.session.workspace), checkpoint.sha);
  await dropTornTail(log);
  await appendEvent(log.file, { kind: 'restored', seq: nextSeq(log.events), at: new Date().toISOString(), turnSeq: checkpoint.turnSeq, sha: checkpoint.sha, files });
  return files;
}

/** Restores the workspace to the checkpoint before model call `turnSeq` and logs it. Returns the workspace-relative paths it touched. */
export async function rewindTo(store: Store, log: SessionLog, turnSeq: number): Promise<{ readonly sha: string; readonly files: string[] }> {
  const checkpoints = checkpointsOf(log.events);
  const checkpoint = checkpoints.find((c) => c.turnSeq === turnSeq);
  if (checkpoint === undefined) {
    const known = checkpoints.map((c) => c.turnSeq).join(', ') || 'none';
    throw new EngineError(`session ${log.session.id} has no checkpoint before turn ${turnSeq}; checkpoints exist before turns: ${known}`);
  }
  return { sha: checkpoint.sha, files: await restoreCheckpoint(store, log, checkpoint) };
}

const promptOf = (log: SessionLog, turnSeq: number) => {
  const prompt = promptAt(log.events, turnSeq);
  if (prompt === undefined) throw new EngineError(`session ${log.session.id} has no prompt at event ${turnSeq}`);
  return prompt;
};

const checkpointOf = (log: SessionLog, turnSeq: number): CheckpointEvent => {
  promptOf(log, turnSeq);
  const checkpoint = checkpointOfTurn(log.events, turnSeq);
  if (checkpoint === undefined) throw new EngineError(`the turn at event ${turnSeq} never reached the model, so it has no checkpoint to restore`);
  return checkpoint;
};

/**
 * What restoring the files before the turn at `turnSeq` would do: the paths it would rewrite or delete, and the paths
 * edited since the session's last checkpoint, which no checkpoint holds and a restore would lose.
 */
export async function rewindPreview(store: Store, log: SessionLog, turnSeq: number): Promise<{ readonly files: string[]; readonly unsaved: string[] }> {
  const repo = shadowRepoFor(store, log.session.workspace);
  const files = await changedSince(repo, checkpointOf(log, turnSeq).sha);
  const last = checkpointsOf(log.events).at(-1);
  return { files, unsaved: last === undefined ? [] : await changedSince(repo, last.sha) };
}

/** The prompt as the user typed it, for the composer: a command goes back as `/name args`, not its expansion. */
export const typedPrompt = (prompt: Extract<TurnEvent, { kind: 'user' }>): string =>
  prompt.command === undefined ? prompt.content : `/${prompt.command.name}${prompt.command.args === '' ? '' : ` ${prompt.command.args}`}`;

/**
 * Rewinds the session to before the turn at `turnSeq`: the files from that turn's checkpoint, the conversation by a
 * logged cut, or both, files first so the cut drops the restore's notice with the turns it is about.
 */
export async function rewindSession(store: Store, log: SessionLog, turnSeq: number, choice: RewindChoice): Promise<{ readonly files: string[]; readonly prompt: string }> {
  const { files: restoresFiles, conversation } = REWINDS[choice.kind];
  const prompt = promptOf(log, turnSeq);
  if (conversation && log.session.backend !== undefined) throw new EngineError('an external agent keeps its own conversation, so only its files can be restored');
  const files = restoresFiles ? await restoreCheckpoint(store, log, checkpointOf(log, turnSeq)) : [];
  if (conversation) {
    const now = await readSessionLog(log.file);
    await dropTornTail(now);
    await appendEvent(log.file, { kind: 'cut', seq: nextSeq(now.events), at: new Date().toISOString(), turnSeq });
  }
  return { files, prompt: typedPrompt(prompt) };
}

/** A new session with the conversation up to and including the turn at `turnSeq`, and a copy of the source's attachments. */
export async function forkSession(store: Store, log: SessionLog, turnSeq: number): Promise<SessionLog> {
  if (log.session.backend !== undefined) throw new EngineError('an external agent keeps its own conversation, so its sessions cannot be forked');
  const head = log.events[0];
  if (head?.kind === 'session-start' && head.child !== undefined) throw new EngineError('a subagent session cannot be forked; fork its parent');
  const id = asSessionId(randomUUID());
  const events = forkEvents(log.events, turnSeq, { id, createdAt: new Date().toISOString(), title: titleOf(log.events) ?? UNTITLED });
  if (events === undefined) throw new EngineError(`session ${log.session.id} has no prompt at event ${turnSeq}`);
  await cp(path.join(store.sessionsDir, log.session.id), path.join(store.sessionsDir, id), { recursive: true, errorOnExist: true }).catch((error: unknown) => {
    if (!isMissing(error)) throw error;
  });
  const file = sessionFile(store, id);
  await writeFile(file, events.map((e) => `${JSON.stringify(e)}\n`).join(''), { flag: 'wx' });
  return readSessionLog(file);
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
