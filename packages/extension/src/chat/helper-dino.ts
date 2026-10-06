/// <reference lib="dom" />
import type { Turn } from './messages.js';
import type { Motion } from './motion.js';
import { spriteCanvas } from './sprite-canvas.js';
import { TICK_MS } from './wander.js';
import { frameOf, steer, type Working } from './working.js';

/** What a helper stands for: a running subagent, or an Arena lane, with the turn that poses it. */
export type Runner = { readonly id: string; readonly turn: Turn };

type Helper = { readonly sprite: ReturnType<typeof spriteCanvas>; runner: Runner; working: Working | undefined };

/**
 * A small Noodle at 1× for each running subagent, in its child's row on the rail, posed by the child's own work as
 * the working dino is by the turn's. A child that ends takes its helper with it. The Arena's race uses its own set,
 * one per lane, in the lane's `data-helper` slot.
 */
export function helperDinos() {
  const helpers = new Map<string, Helper>();
  let motion: Motion = 'paused';
  let timer: ReturnType<typeof setInterval> | undefined;

  function update(): void {
    const still = motion === 'still';
    for (const [id, helper] of helpers) {
      helper.working = steer(helper.working, helper.runner.turn, still, Math.random);
      const slot = document.querySelector(`[data-helper="${CSS.escape(id)}"]`);
      if (helper.working === undefined || slot === null) {
        helper.sprite.element.remove();
        continue;
      }
      if (helper.sprite.element.parentElement !== slot) slot.append(helper.sprite.element);
      helper.sprite.element.dataset['pose'] = helper.working.pose;
      helper.sprite.draw(frameOf(helper.working, still));
    }
    if (helpers.size > 0 && motion === 'moving') timer ??= setInterval(tick, TICK_MS);
    else {
      clearInterval(timer);
      timer = undefined;
    }
  }

  function tick(): void {
    for (const helper of helpers.values()) if (helper.working !== undefined) helper.working = { ...helper.working, t: helper.working.t + 1 };
    update();
  }

  return {
    /** After each render: the runners shown now, whose rows may have been rebuilt. */
    show(running: readonly Runner[]): void {
      const ids = new Set(running.map((runner) => runner.id));
      for (const [id, helper] of helpers) {
        if (ids.has(id)) continue;
        helper.sprite.element.remove();
        helpers.delete(id);
      }
      for (const runner of running) {
        const helper = helpers.get(runner.id);
        if (helper === undefined) helpers.set(runner.id, { sprite: spriteCanvas('helper-dino'), runner, working: undefined });
        else helper.runner = runner;
      }
      update();
    },
    setMotion(now: Motion): void {
      motion = now;
      update();
    },
    active: (): boolean => helpers.size > 0,
  };
}
