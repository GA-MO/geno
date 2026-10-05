import type { Eye } from './sprite.js';

/** The head over the composer: peeking, ducked behind it, or away while there is nothing to peek at. */
export type PeekState = 'up' | 'ducked' | 'away';

export type PeekInput = { readonly turns: number; readonly running: boolean; readonly composerFocused: boolean; readonly draft: string };

export function peekState({ turns, running, composerFocused, draft }: PeekInput): PeekState {
  if (turns === 0 || running) return 'away';
  return composerFocused || draft.trim() !== '' ? 'ducked' : 'up';
}

/** The pointer counts as above the eye only this far up, so a pointer over the composer leaves the gaze level. */
const UP_PX = 40;

const GAZE: Readonly<Record<'level' | 'up', Readonly<Record<'left' | 'right', Eye>>>> = {
  level: { left: 'left', right: 'open' },
  up: { left: 'upLeft', right: 'up' },
};

/** The eye that looks toward the pointer, `dx` and `dy` page pixels from the eye. */
export const gazeOf = (dx: number, dy: number): Eye => GAZE[dy < -UP_PX ? 'up' : 'level'][dx < 0 ? 'left' : 'right'];
