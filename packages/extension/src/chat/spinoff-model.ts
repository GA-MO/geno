import type { Spinoff, SpinoffShown } from '@g-code/core/spinoff';
import type { Transcript } from './messages.js';

/**
 * Suggested tasks in the panel. The card lives on the step of the spawn_task call that offered it; a move from
 * anywhere else, such as a dismiss_task call or the user's Start, finds that card by id. The webview bundles this
 * file, so it imports only types and pure modules.
 */
export type SpinoffToView = { readonly type: 'spinoff-failed'; readonly id: string; readonly message: string };

export type SpinoffFromView =
  | { readonly type: 'spinoff-start'; readonly id: string }
  | { readonly type: 'spinoff-dismiss'; readonly id: string }
  /** Opens the task a started suggestion became. */
  | { readonly type: 'spinoff-open'; readonly id: string };

/** The transcript with `shown` applied: an offer sets its call's card, a move changes the card with that id. */
export function withSpinoff(transcript: Transcript, shown: SpinoffShown): Transcript {
  const matches = (spinoff: Spinoff | undefined, id: string, toolId: string): boolean =>
    shown.kind === 'offer' ? toolId === shown.spinoff.toolUseId : spinoff?.id === id;
  const id = shown.kind === 'offer' ? shown.spinoff.id : shown.id;
  let changed = false;
  const turns = transcript.turns.map((turn) => {
    if (!turn.blocks.some((block) => block.kind === 'tool' && matches(block.spinoff, id, block.id))) return turn;
    changed = true;
    return {
      ...turn,
      blocks: turn.blocks.map((block) => {
        if (block.kind !== 'tool' || !matches(block.spinoff, id, block.id)) return block;
        return { ...block, spinoff: shown.kind === 'offer' ? shown.spinoff : { ...block.spinoff!, state: shown.state } };
      }),
    };
  });
  return changed ? { ...transcript, turns } : transcript;
}

export const spinoffsIn = (transcript: Transcript): Spinoff[] =>
  transcript.turns.flatMap((turn) => turn.blocks.flatMap((block) => (block.kind === 'tool' && block.spinoff !== undefined ? [block.spinoff] : [])));

/** What a card offers: Start and Dismiss while open, Open once started; settled any other way, it is not drawn. */
export type SpinoffCard =
  | { readonly kind: 'open'; readonly spinoff: Spinoff; readonly starting: boolean; readonly problem: string | undefined }
  | { readonly kind: 'started'; readonly spinoff: Spinoff; readonly sessionId: string; readonly lane: string }
  | { readonly kind: 'hidden' };

/** The webview's own part of a card: a Start sent and not yet answered, or the reason it failed. */
export type SpinoffPending = Readonly<Record<string, { readonly kind: 'starting' } | { readonly kind: 'failed'; readonly message: string }>>;

export function spinoffCardOf(spinoff: Spinoff, pending: SpinoffPending): SpinoffCard {
  const { state } = spinoff;
  if (state.kind === 'started') return { kind: 'started', spinoff, sessionId: state.sessionId, lane: state.lane };
  if (state.kind !== 'offered') return { kind: 'hidden' };
  const mine = pending[spinoff.id];
  return { kind: 'open', spinoff, starting: mine?.kind === 'starting', problem: mine?.kind === 'failed' ? mine.message : undefined };
}

/** The Tasks pane's Suggested section: the session's open suggestions, newest first. */
export const openSpinoffs = (transcript: Transcript): Spinoff[] => spinoffsIn(transcript).filter((spinoff) => spinoff.state.kind === 'offered').reverse();
