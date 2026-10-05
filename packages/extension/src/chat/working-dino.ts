/// <reference lib="dom" />
import type { Turn } from './messages.js';
import type { Motion } from './motion.js';
import { spriteCanvas } from './sprite-canvas.js';
import { TICK_MS } from './wander.js';
import { frameOf, steer, type Working } from './working.js';

/** The rail's steps the dino can stand beside: not the changes card or the changed files, which close the rail. */
const STEPS = ':scope > .rail > .step:not(.step-changes, .step-files)';

/** The running turn's current step, its last; once the turn ends, its summary line if it folded. */
function anchorOf(shell: HTMLElement, ending: boolean): HTMLElement | null {
  const fold = ending ? shell.querySelector<HTMLElement>(':scope > .rail > .step-fold') : null;
  return fold ?? [...shell.querySelectorAll<HTMLElement>(STEPS)].at(-1) ?? null;
}

/**
 * Noodle at 2× beside the current step of the last turn while it runs, then for its turn-end move. The turn's
 * 24 px avatar steps aside meanwhile (`data-working` on the turn), so there is one Noodle at a time.
 */
export function workingDino() {
  const sprite = spriteCanvas('working-dino');
  let working: Working | undefined;
  let turn: Turn | undefined;
  let shell: HTMLElement | undefined;
  let motion: Motion = 'paused';
  let timer: ReturnType<typeof setInterval> | undefined;

  function update(): void {
    working = steer(working, turn, motion === 'still', Math.random);
    const anchor = working === undefined || shell === undefined ? null : anchorOf(shell, working.ending);
    if (working === undefined || anchor === null) {
      sprite.element.remove();
      delete shell?.dataset['working'];
    } else {
      if (sprite.element.parentElement !== anchor) anchor.append(sprite.element);
      shell!.dataset['working'] = working.pose;
      sprite.element.dataset['pose'] = working.pose;
      sprite.draw(frameOf(working, motion === 'still'));
    }
    if (working !== undefined && motion === 'moving') timer ??= setInterval(tick, TICK_MS);
    else {
      clearInterval(timer);
      timer = undefined;
    }
  }

  function tick(): void {
    if (working !== undefined) working = { ...working, t: working.t + 1 };
    update();
  }

  return {
    /** After each render: the last turn and its element, whose rail may have been rebuilt. */
    show(last: Turn | undefined, element: HTMLElement | undefined): void {
      if (shell !== element) delete shell?.dataset['working'];
      turn = last;
      shell = element;
      update();
    },
    setMotion(now: Motion): void {
      motion = now;
      update();
    },
    active: (): boolean => working !== undefined,
  };
}
