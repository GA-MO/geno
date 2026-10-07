import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import type { MessageStreamParams, TextBlockParam, Tool } from '@anthropic-ai/sdk/resources/messages/messages';
import { buildRequest, specOf, toChatRequest, type TurnEvent } from '@g-code/core';
import { attachmentsDir, loadAttachments } from './attachments.js';
import { UsageError } from './command.js';
import { writeAtomically } from './memory.js';
import { homeOf, isMissing, type Store } from './store.js';

/**
 * A request without its messages: the model, the limits, the tools and the system prompt. Kept once per distinct body
 * under `snapshots/` in the app home and named on each model turn, so with the log, which the messages are a function
 * of, every call can be rebuilt byte for byte.
 */
export type RequestSnapshot = Omit<MessageStreamParams, 'messages'>;

const snapshotsDir = (store: Store): string => path.join(homeOf(store), 'snapshots');

/** Keeps a request's snapshot and answers with its name; a body already kept is not written again. */
export function snapshotKeeper(store: Store): (request: MessageStreamParams) => Promise<string> {
  const kept = new Set<string>();
  return async (request) => {
    const { messages: _, ...snapshot } = request;
    const name = createHash('sha256').update(JSON.stringify(snapshot)).digest('hex').slice(0, 32);
    if (!kept.has(name)) {
      await writeAtomically(path.join(snapshotsDir(store), `${name}.json`), snapshot);
      kept.add(name);
    }
    return name;
  };
}

async function readSnapshot(store: Store, name: string): Promise<RequestSnapshot> {
  const file = path.join(snapshotsDir(store), `${name}.json`);
  try {
    return JSON.parse(await readFile(file, 'utf8')) as RequestSnapshot;
  } catch (error) {
    if (isMissing(error)) throw new UsageError(`the snapshot ${name} is gone from ${snapshotsDir(store)}`);
    throw error;
  }
}

const systemText = (system: RequestSnapshot['system']): string => (typeof system === 'string' ? system : (system ?? []).map((block: TextBlockParam) => block.text).join(''));

/** The body the call that logged turn `seq` sent, rebuilt from its snapshot and the events before it, as its wire sent it. */
export async function loggedRequest(store: Store, events: readonly TurnEvent[], seq: number): Promise<unknown> {
  const index = events.findIndex((event) => event.kind === 'assistant' && event.seq === seq);
  const turn = events[index];
  const start = events[0];
  if (turn?.kind !== 'assistant' || turn.issuedBy === 'user') throw new UsageError(`turn ${seq} is not a model turn`);
  if (turn.snapshot === undefined) throw new UsageError(`turn ${seq} was logged before requests were kept`);
  if (start?.kind !== 'session-start') throw new UsageError('the log has no session start');
  const snapshot = await readSnapshot(store, turn.snapshot);
  const before = events.slice(0, index);
  const stored = await loadAttachments(attachmentsDir(store, start.session.id), before);
  const { messages } = buildRequest(start.session, before, (snapshot.tools ?? []) as readonly Tool[], systemText(snapshot.system), stored);
  const request: MessageStreamParams = { ...snapshot, messages };
  // The Anthropic SDK's stream call adds `stream: true`; the OpenAI-compatible wire translates the whole request.
  return specOf(start.session.provider).adapter === 'anthropic' ? { ...request, stream: true } : toChatRequest(request);
}
