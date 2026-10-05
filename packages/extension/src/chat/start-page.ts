/// <reference lib="dom" />
import { h, icon } from './dom.js';
import { formatAgo } from './history-state.js';
import type { FromView, Header, HistoryRow } from './messages.js';
import type { Motion } from './motion.js';
import { recentSessions } from './recents.js';
import { spriteCanvas } from './sprite-canvas.js';
import { STAND } from './sprite.js';
import { frameOf, next, poke, SCALE, start, TICK_MS, type Scene } from './wander.js';

/** The shadow sits under the body's middle, this many sprite pixels from the side Noodle faces away from. */
const BODY_MIDDLE = 10;
/** Height at which the shadow is smallest. */
const SHADOW_FADE_PX = 64;

/**
 * The new chat's page: Noodle alone, wandering on its own, then `geno`, the project and its branch, and the
 * project's newest sessions to continue. `motion` decides whether Noodle moves, holds, or stands still.
 */
export function startPage(post: (message: FromView) => void) {
  const sprite = spriteCanvas('start-dino');
  const shadow = h('div', { class: 'start-shadow', 'aria-hidden': 'true' });
  const stage = h('div', { class: 'start-stage' }, shadow, sprite.element);
  const project = h('span', { class: 'start-project' });
  const branch = h('span', { class: 'start-branch' });
  const branchPart = h('span', { class: 'start-branch-part', hidden: true }, icon('git-branch'), branch);
  const list = h('ul', { class: 'start-recents-list' });
  const recents = h('section', { class: 'start-recents', 'aria-label': 'Continue a chat', hidden: true }, h('h2', { class: 'start-recents-title' }, 'Continue'), list);
  const element = h(
    'section',
    { class: 'start-page empty-state', 'aria-label': 'New chat' },
    stage,
    h('h1', { class: 'start-name' }, 'geno', h('span', { class: 'start-cursor', 'aria-hidden': 'true' })),
    h('p', { class: 'start-where' }, h('span', { class: 'start-project-part' }, icon('folder'), project), branchPart),
    recents,
  );

  let width = 0;
  let scene: Scene = start({ width });
  let motion: Motion = 'paused';
  let timer: ReturnType<typeof setInterval> | undefined;

  /** Writes a style only when it changes, so a tick in which Noodle stands still costs the page nothing. */
  const styled = new Map<string, string>();
  function style(target: HTMLElement, key: string, property: 'transform' | 'opacity', value: string): void {
    if (styled.get(key) === value) return;
    styled.set(key, value);
    target.style[property] = value;
  }

  function place(): void {
    const frame = motion === 'still' ? STAND : frameOf(scene);
    sprite.draw(frame);
    style(sprite.element, 'dino', 'transform', `translate(${Math.round(scene.x)}px, ${-Math.round(scene.y)}px)`);
    if (element.dataset['move'] !== scene.move) element.dataset['move'] = scene.move;
    const middle = scene.x + SCALE * (scene.facing > 0 ? BODY_MIDDLE : 24 - BODY_MIDDLE);
    const size = (1 - 0.6 * Math.min(1, scene.y / SHADOW_FADE_PX)).toFixed(2);
    style(shadow, 'shadow', 'transform', `translateX(${Math.round(middle)}px) translateX(-50%) scale(${size})`);
    style(shadow, 'shade', 'opacity', size);
  }

  function tick(): void {
    scene = next(scene, { width }, Math.random);
    place();
  }

  new ResizeObserver(() => {
    const before = width;
    width = stage.clientWidth;
    if (before === 0 || motion === 'still') scene = start({ width });
    place();
  }).observe(stage);

  sprite.element.addEventListener('click', () => {
    if (motion !== 'moving') return;
    scene = poke(scene, Math.random);
    place();
  });

  function setMotion(now: Motion): void {
    motion = now;
    if (motion === 'moving') timer ??= setInterval(tick, TICK_MS);
    else {
      clearInterval(timer);
      timer = undefined;
    }
    if (motion === 'still') scene = start({ width });
    element.dataset['motion'] = motion;
    place();
  }

  function showRecents(rows: readonly HistoryRow[]): void {
    const now = Date.now();
    const recent = recentSessions(rows);
    recents.hidden = recent.length === 0;
    list.replaceChildren(
      ...recent.map((row) =>
        h(
          'li',
          {},
          h(
            'button',
            { type: 'button', class: 'start-recent', 'data-session': row.id, title: `Continue “${row.title}”`, onclick: () => post({ type: 'open-session', id: row.id, workspace: row.workspace }) },
            h('span', { class: 'start-recent-title' }, row.title),
            h('span', { class: 'start-recent-ago' }, formatAgo(row.updatedAt, now)),
          ),
        ),
      ),
    );
  }

  return {
    element,
    setMotion,
    /** Asks for this project's sessions, each time the page comes back. */
    refresh: () => post({ type: 'list-sessions', scope: 'project' }),
    header: ({ project: name, branch: checkedOut }: Header) => {
      project.textContent = name;
      branch.textContent = checkedOut ?? '';
      branchPart.hidden = checkedOut === undefined;
    },
    listed: showRecents,
  };
}
