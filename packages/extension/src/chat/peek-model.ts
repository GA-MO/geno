import type { Eye, PeekMove } from './sprite.js';

/**
 * Noodle peeking over the composer, only while the user types. `act` is the move on screen, or `away` behind the
 * composer; `waved` is whether this page has waved yet, at most once; `blocked` is a turn running or the chat not shown.
 */
export type PeekAct = PeekMove | 'away';
export type Peek = { readonly act: PeekAct; readonly waved: boolean; readonly blocked: boolean };

export type PeekEvent =
  /** A keystroke changed the draft. */
  | { readonly kind: 'typed'; readonly draft: string }
  | { readonly kind: 'sent' }
  | { readonly kind: 'blocked'; readonly on: boolean }
  /** No typing for QUIET_MS; `random` in [0, 1) picks the move. */
  | { readonly kind: 'quiet'; readonly random: number }
  /** The act on screen played to its end. */
  | { readonly kind: 'played' };

export const HIDDEN: Peek = { act: 'away', waved: false, blocked: false };

/** It climbs once the draft holds this many characters. */
export const CLIMB_AT = 3;
export const QUIET_MS = 3000;

/** After a pause in typing, one of these, then back to typing. */
const PAUSE_MOVES: readonly PeekMove[] = ['drum', 'lookAround'];

/** What follows each act once it has played. */
const AFTER: Readonly<Record<PeekAct, (peek: Peek) => Peek>> = {
  climb: (peek) => (peek.waved ? { ...peek, act: 'typing' } : { ...peek, act: 'wave', waved: true }),
  wave: (peek) => ({ ...peek, act: 'typing' }),
  drum: (peek) => ({ ...peek, act: 'typing' }),
  lookAround: (peek) => ({ ...peek, act: 'typing' }),
  typing: (peek) => peek,
  duck: (peek) => ({ ...peek, act: 'away' }),
  away: (peek) => peek,
};

const isUp = (act: PeekAct): boolean => act !== 'away' && act !== 'duck';
const duck = (peek: Peek): Peek => (isUp(peek.act) ? { ...peek, act: 'duck' } : peek);

export function peekNext(peek: Peek, event: PeekEvent): Peek {
  switch (event.kind) {
    case 'typed': {
      const length = event.draft.trim().length;
      if (length === 0) return duck(peek);
      if (peek.blocked) return peek;
      if (!isUp(peek.act)) return length >= CLIMB_AT ? { ...peek, act: 'climb' } : peek;
      return PAUSE_MOVES.includes(peek.act as PeekMove) ? { ...peek, act: 'typing' } : peek;
    }
    case 'sent':
      return duck(peek);
    case 'blocked':
      return event.on ? duck({ ...peek, blocked: true }) : { ...peek, blocked: false };
    case 'quiet':
      return peek.act === 'typing' ? { ...peek, act: PAUSE_MOVES[Math.floor(event.random * PAUSE_MOVES.length)]! } : peek;
    case 'played':
      return AFTER[peek.act](peek);
  }
}

/** The pointer counts as above the eye only this far up, so a pointer over the composer leaves the gaze level. */
const UP_PX = 40;

const GAZE: Readonly<Record<'level' | 'up', Readonly<Record<'left' | 'right', Eye>>>> = {
  level: { left: 'left', right: 'open' },
  up: { left: 'upLeft', right: 'up' },
};

/** The eye that looks toward the pointer, `dx` and `dy` page pixels from the eye. */
export const gazeOf = (dx: number, dy: number): Eye => GAZE[dy < -UP_PX ? 'up' : 'level'][dx < 0 ? 'left' : 'right'];
