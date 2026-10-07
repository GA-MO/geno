/**
 * Rewind and fork from a prompt (U50). The log is append-only: a rewind of the conversation logs a `cut`, and every
 * reader sees the session through `cutView`. A fork copies the cut view up to and including one turn into a new log.
 */

import type { Session, SessionId, TurnEvent, TurnEventKind } from './session.js';
import { toolUsesOf } from './session.js';
import { startsTurn } from './steer.js';

/** What "Rewind to here" restores: the files from the checkpoint before the turn, the conversation before it, or both. */
export type RewindChoice = { readonly kind: 'files' } | { readonly kind: 'conversation' } | { readonly kind: 'both' };
export type RewindKind = RewindChoice['kind'];

export const REWIND_KINDS = ['files', 'conversation', 'both'] as const satisfies readonly RewindKind[];

export const REWINDS: { readonly [K in RewindKind]: { readonly files: boolean; readonly conversation: boolean } } = {
  files: { files: true, conversation: false },
  conversation: { files: false, conversation: true },
  both: { files: true, conversation: true },
};

/** The conversation from the prompt at `turnSeq` on was cut: that prompt went back to the composer. */
export type CutEvent = { readonly kind: 'cut'; readonly seq: number; readonly at: string; readonly turnSeq: number };

/** Where a fork came from, kept on its session-start. `title` is the origin's title when it was forked. */
export type ForkOrigin = { readonly sessionId: SessionId; readonly turnSeq: number; readonly title: string };

/**
 * What a cut keeps of the events it passes over: the settings the user chose, review decisions and the user's chapters,
 * which hold after the cut, and nothing of the cut turns themselves. A chapter whose message the cut dropped goes with it
 * in `chaptersOf`.
 */
const KEPT_BY_CUT: Readonly<Record<TurnEventKind, boolean>> = {
  'session-start': true,
  mode: true,
  effort: true,
  'backend-model': true,
  title: true,
  review: true,
  spinoff: true,
  chapter: true,
  // SessionStart's output is the session's context, like its start.
  'hook-context': true,
  user: false,
  assistant: false,
  error: false,
  'tool-result': false,
  'report-nudge': false,
  checkpoint: false,
  restored: false,
  retry: false,
  'child-start': false,
  'child-end': false,
  'lane-apply': false,
  'background-end': false,
  wait: false,
  wake: false,
  'backend-start': false,
  notice: false,
  cut: false,
  compact: false,
  'file-changed': false,
};

/**
 * What a fork leaves out of the turns it takes: a wait or a pending wake-up would be taken up again, and the source's
 * cuts are already applied.
 */
const skippedByFork = (event: TurnEvent): boolean => event.kind === 'wait' || event.kind === 'cut' || (event.kind === 'wake' && event.note.kind === 'scheduled');

/** The tool call an event belongs to, for the events that answer or report on one. */
function toolUseOf(event: TurnEvent): string | undefined {
  if (event.kind === 'tool-result' || event.kind === 'child-start' || event.kind === 'child-end') return event.toolUseId;
  if (event.kind === 'background-end') return event.job.toolUseId;
  if (event.kind === 'wake' && 'toolUseId' in event.note) return event.note.toolUseId;
  return undefined;
}

/** A turn starts at a prompt or a lane apply, as the panel draws turns. */
const isTurnStart = (event: TurnEvent): boolean => startsTurn(event) || event.kind === 'lane-apply';

const promptIndex = (events: readonly TurnEvent[], turnSeq: number): number => events.findIndex((e) => startsTurn(e) && e.seq === turnSeq);

/**
 * The session as of its cuts. A cut drops its prompt and everything logged after it but the settings and review
 * decisions, then stands in their place, so it holds the highest seq and `nextSeq` goes on from it. A report that comes
 * later for a tool call a cut dropped, such as a stopped background command's end, is dropped too.
 */
export function cutView(events: readonly TurnEvent[]): TurnEvent[] {
  const view: TurnEvent[] = [];
  const cutUses = new Set<string>();
  for (const event of events) {
    if (event.kind === 'cut') {
      const at = promptIndex(view, event.turnSeq);
      const dropped = at === -1 ? [] : view.splice(at);
      for (const e of dropped) if (e.kind === 'assistant') for (const use of toolUsesOf(e.content)) cutUses.add(use.id);
      view.push(...dropped.filter((e) => KEPT_BY_CUT[e.kind]), event);
      continue;
    }
    const use = toolUseOf(event);
    if (use !== undefined && cutUses.has(use)) continue;
    view.push(event);
  }
  return view;
}

type UserEvent = Extract<TurnEvent, { kind: 'user' }>;

/** The prompt that starts the turn at `turnSeq` in a cut view; a steer, or a seq a cut dropped, starts none. */
export const promptAt = (view: readonly TurnEvent[], turnSeq: number): UserEvent | undefined => {
  const event = view[promptIndex(view, turnSeq)];
  return event !== undefined && startsTurn(event) ? event : undefined;
};

/** The events of the turn at `turnSeq`, from its prompt up to the next turn's start. */
export function turnEvents(view: readonly TurnEvent[], turnSeq: number): TurnEvent[] {
  const at = promptIndex(view, turnSeq);
  if (at === -1) return [];
  const next = view.findIndex((e, i) => i > at && isTurnStart(e));
  return view.slice(at, next === -1 ? view.length : next);
}

/** The checkpoint taken before the turn's first model call, the files as they were when the prompt was sent. */
export const checkpointOfTurn = (view: readonly TurnEvent[], turnSeq: number): Extract<TurnEvent, { kind: 'checkpoint' }> | undefined =>
  turnEvents(view, turnSeq).find((e): e is Extract<TurnEvent, { kind: 'checkpoint' }> => e.kind === 'checkpoint');

/** Tool calls of the turns a cut at `turnSeq` drops, whose background commands the cut stops. */
export function toolUsesFrom(view: readonly TurnEvent[], turnSeq: number): Set<string> {
  const at = promptIndex(view, turnSeq);
  const uses = new Set<string>();
  if (at === -1) return uses;
  for (const e of view.slice(at)) if (e.kind === 'assistant') for (const use of toolUsesOf(e.content)) uses.add(use.id);
  return uses;
}

/**
 * A fork's log: a new session-start for `fork`, then the source's cut view up to and including the turn at `turnSeq`,
 * steers and child events in place. Checkpoints take the fork's id, so it rewinds files on its own lineage. Undefined
 * when no turn starts at `turnSeq`.
 */
export function forkEvents(events: readonly TurnEvent[], turnSeq: number, fork: { readonly id: SessionId; readonly createdAt: string; readonly title: string }): TurnEvent[] | undefined {
  const view = cutView(events);
  const head = view[0];
  if (head?.kind !== 'session-start' || promptAt(view, turnSeq) === undefined) return undefined;
  const turn = turnEvents(view, turnSeq);
  const upTo = view.indexOf(turn.at(-1)!);
  const session: Session = { ...head.session, id: fork.id, createdAt: fork.createdAt };
  const origin: ForkOrigin = { sessionId: head.session.id, turnSeq, title: fork.title };
  const copied = view.slice(1, upTo + 1).flatMap((e): TurnEvent[] => {
    if (skippedByFork(e)) return [];
    return [e.kind === 'checkpoint' ? { ...e, sessionId: fork.id } : e];
  });
  // The user can mark a chapter at a message long after its turn ended; the fork keeps the ones its turns hold.
  const prompts = new Set(copied.flatMap((e) => (startsTurn(e) ? [e.seq] : [])));
  const chapters = view.slice(upTo + 1).filter((e) => e.kind === 'chapter' && prompts.has(e.turnSeq));
  return [
    {
      kind: 'session-start',
      session,
      ...(head.context === undefined ? {} : { context: head.context }),
      ...(head.environment === undefined ? {} : { environment: head.environment }),
      fork: origin,
    },
    ...copied,
    ...chapters,
  ];
}
