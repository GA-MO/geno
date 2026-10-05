/// <reference lib="dom" />
import { h } from './dom.js';
import type { Motion } from './motion.js';
import { gazeOf, HIDDEN, peekNext, QUIET_MS, type Peek, type PeekEvent } from './peek-model.js';
import { spriteCanvas } from './sprite-canvas.js';
import { composePeek, PEEK_MOVES, playhead, SIZE, type PeekFrame } from './sprite.js';
import { TICK_MS } from './wander.js';

/** The peek draws Noodle at 2×. */
const SCALE = 2;
/** The eye's middle inside the canvas, in page pixels. */
const EYE = { x: (17 + 1) * SCALE, y: (3 + 0.5) * SCALE } as const;
/** Gripping the edge, looking ahead: all the peek shows when frames do not play. */
const STILL: PeekFrame = { eye: 'open', left: 'grip', right: 'grip' };

/**
 * Noodle leaning on the composer's top edge while the user types: it climbs up once per message, watches the text,
 * plays one move after a pause, and ducks behind the composer on send. The composer's edge clips the body, so
 * climbing and ducking slide all of it. Under reduced motion or high contrast it is still: no moves, no gaze.
 */
export function peek(onShown: (shown: boolean) => void) {
  const body = spriteCanvas('peek-body');
  const element = h('div', { class: 'peek', 'aria-hidden': 'true', 'data-state': 'away' }, body.element);
  let state: Peek = HIDDEN;
  let t = 0;
  let motion: Motion = 'paused';
  let timer: ReturnType<typeof setInterval> | undefined;
  let quiet: ReturnType<typeof setTimeout> | undefined;
  let pointer: { readonly x: number; readonly y: number } | undefined;
  let sunk = '';

  function frameNow(): PeekFrame | undefined {
    if (state.act === 'away') return undefined;
    if (motion === 'still') return state.act === 'duck' ? undefined : STILL;
    return playhead(PEEK_MOVES[state.act], t, true).frame;
  }

  function draw(): void {
    element.dataset['state'] = state.act;
    const frame = frameNow();
    if (frame === undefined) return;
    let eye = frame.eye;
    if (frame.toPointer === true && pointer !== undefined) {
      const box = body.element.getBoundingClientRect();
      eye = gazeOf(pointer.x - (box.left + EYE.x), pointer.y - (box.top + EYE.y));
    }
    body.paint(composePeek({ ...frame, eye }));
    const transform = `translateY(${Math.min(SIZE, frame.sink ?? 0) * SCALE}px)`;
    if (transform !== sunk) body.element.style.transform = sunk = transform;
  }

  function dispatch(event: PeekEvent): void {
    const was = state.act;
    state = peekNext(state, event);
    if (state.act !== was) t = 0;
    run();
  }

  function tick(): void {
    t++;
    if (state.act !== 'away' && playhead(PEEK_MOVES[state.act], t, true).ended) return dispatch({ kind: 'played' });
    draw();
  }

  function run(): void {
    // Without frames, a move is over as soon as it starts.
    while (motion === 'still' && state.act !== 'away' && state.act !== 'typing') state = peekNext(state, { kind: 'played' });
    onShown(state.act !== 'away');
    draw();
    if (motion === 'moving' && state.act !== 'away') timer ??= setInterval(tick, TICK_MS);
    else {
      clearInterval(timer);
      timer = undefined;
    }
  }

  document.addEventListener('mousemove', (event) => (pointer = { x: event.clientX, y: event.clientY }), { passive: true });

  return {
    element,
    /** A keystroke changed the draft; a pause after it may bring a move. */
    typed(draft: string): void {
      clearTimeout(quiet);
      dispatch({ kind: 'typed', draft });
      if (motion !== 'still') quiet = setTimeout(() => dispatch({ kind: 'quiet', random: Math.random() }), QUIET_MS);
    },
    sent(): void {
      clearTimeout(quiet);
      dispatch({ kind: 'sent' });
    },
    /** A turn runs, or the chat is not on screen. */
    blocked(on: boolean): void {
      if (on !== state.blocked) dispatch({ kind: 'blocked', on });
    },
    setMotion(now: Motion): void {
      motion = now;
      run();
    },
  };
}
