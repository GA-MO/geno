/// <reference lib="dom" />
import { h } from './dom.js';
import { gazeOf, peekState, type PeekInput, type PeekState } from './peek-model.js';
import { spriteCanvas } from './sprite-canvas.js';
import { STAND, type Eye } from './sprite.js';

/** Noodle's head, rows 0 to 11, and the columns around it. */
const HEAD = { x: 12, y: 0, width: 12, height: 12 } as const;
/** The peek draws the head at 2×. */
const SCALE = 2;
/** The eye's middle inside the head, in page pixels. */
const EYE = { x: (17 - HEAD.x + 1) * SCALE, y: (3 + 0.5) * SCALE } as const;
const BLINK_EVERY_MS = 4000;
const BLINK_MS = 140;

/**
 * Noodle's head peeking over the composer's top edge while the chat is idle after a turn. Its eyes follow the
 * pointer unless `tracking` is off; it ducks behind the composer while the user is typing, and is away during a turn.
 */
export function peek() {
  const head = spriteCanvas('peek-head', HEAD);
  const element = h('div', { class: 'peek', 'aria-hidden': 'true', 'data-state': 'away' }, head.element);
  let state: PeekState = 'away';
  let eye: Eye = 'open';
  let tracking = true;
  let blink: ReturnType<typeof setInterval> | undefined;

  const draw = (shown: Eye) => head.draw({ ...STAND, eye: shown });

  function look(next: Eye): void {
    eye = next;
    draw(eye);
  }

  function update(input: PeekInput): void {
    state = peekState(input);
    element.dataset['state'] = state;
    const blinking = state === 'up' && tracking;
    if (blinking) blink ??= setInterval(() => (draw('blink'), setTimeout(() => draw(eye), BLINK_MS)), BLINK_EVERY_MS);
    else {
      clearInterval(blink);
      blink = undefined;
    }
  }

  let pending: { readonly x: number; readonly y: number } | undefined;
  document.addEventListener('mousemove', (event) => {
    if (!tracking || state !== 'up') return;
    const first = pending === undefined;
    pending = { x: event.clientX, y: event.clientY };
    if (!first) return;
    requestAnimationFrame(() => {
      const box = head.element.getBoundingClientRect();
      look(gazeOf(pending!.x - (box.left + EYE.x), pending!.y - (box.top + EYE.y)));
      pending = undefined;
    });
  });
  document.documentElement.addEventListener('mouseleave', () => look('open'));

  look('open');
  return {
    element,
    update,
    /** Off under reduced motion and in high contrast: the head looks ahead and does not blink. */
    setTracking: (on: boolean, input: PeekInput) => {
      tracking = on;
      if (!on) look('open');
      update(input);
    },
  };
}
