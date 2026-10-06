/// <reference lib="dom" />
import type { Child } from './messages.js';
import type { Motion } from './motion.js';
import { spriteCanvas } from './sprite-canvas.js';
import { TICK_MS } from './wander.js';
import { frameOf, steer, type Working } from './working.js';

type Helper = { readonly sprite: ReturnType<typeof spriteCanvas>; child: Child; working: Working | undefined };

/**
 * A small Noodle at 1× for each running subagent, in its child's row on the rail, posed by the child's own work as
 * the working dino is by the turn's. A child that ends takes its helper with it.
 */
export function helperDinos() {
  const helpers = new Map<string, Helper>();
  let motion: Motion = 'paused';
  let timer: ReturnType<typeof setInterval> | undefined;

  function update(): void {
    const still = motion === 'still';
    for (const [id, helper] of helpers) {
      helper.working = steer(helper.working, helper.child.turn, still, Math.random);
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
    /** After each render: the children running now, whose rows may have been rebuilt. */
    show(running: readonly Child[]): void {
      const ids = new Set(running.map((child) => child.id));
      for (const [id, helper] of helpers) {
        if (ids.has(id)) continue;
        helper.sprite.element.remove();
        helpers.delete(id);
      }
      for (const child of running) {
        const helper = helpers.get(child.id);
        if (helper === undefined) helpers.set(child.id, { sprite: spriteCanvas('helper-dino'), child, working: undefined });
        else helper.child = child;
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
