/// <reference lib="dom" />
import { h, icon } from './dom.js';

export type SendMenuHooks = {
  /** Sends the draft, or queues it while a turn runs. */
  readonly send: () => void;
  /** Runs the draft as the task of a new lane. */
  readonly runInLane: () => void;
  readonly hasDraft: () => boolean;
  readonly running: () => boolean;
};

/**
 * The send menu: a narrow chevron beside Send and Stop that opens the other ways to send the draft. It keeps the mode
 * menu's keys: arrows move, Enter and Space choose, Escape closes onto the chevron, Tab closes and moves on.
 */
export function sendMenu(hooks: SendMenuHooks) {
  const button = h(
    'button',
    { type: 'button', class: 'composer-icon send-more', title: 'More ways to send', 'aria-label': 'More ways to send', 'aria-haspopup': 'menu', 'aria-expanded': 'false', 'aria-controls': 'send-menu' },
    icon('chevron-up'),
  );
  const menu = h('ul', { class: 'model-menu send-menu', id: 'send-menu', role: 'menu', 'aria-label': 'Send', hidden: true });
  const items = () => [...menu.querySelectorAll<HTMLElement>('[role="menuitem"]:not([aria-disabled="true"])')];

  const option = (action: string, name: string, detail: string, enabled: boolean, run: () => void) =>
    h(
      'li',
      {
        class: 'model-option',
        role: 'menuitem',
        tabindex: '-1',
        'data-action': action,
        ...(enabled ? {} : { 'aria-disabled': 'true' }),
        onclick: () => {
          if (!enabled) return;
          close();
          run();
        },
      },
      icon(action === 'lane' ? 'repo-forked' : 'arrow-up', 'send-option-icon'),
      h('span', { class: 'model-option-text' }, h('span', { class: 'model-option-name' }, name), h('span', { class: 'model-option-detail' }, detail)),
    );

  function draw(): void {
    const draft = hooks.hasDraft();
    menu.replaceChildren(
      option('send', hooks.running() ? 'Queue follow-up' : 'Send', 'Enter', draft, hooks.send),
      option('lane', 'Run in a new lane', 'in the background', draft, hooks.runInLane),
      ...(draft ? [] : [h('li', { class: 'menu-note', role: 'presentation' }, 'Type a task first.')]),
    );
  }

  function open(): void {
    draw();
    menu.hidden = false;
    button.setAttribute('aria-expanded', 'true');
    (items()[0] ?? menu.querySelector<HTMLElement>('[role="menuitem"]'))?.focus();
  }

  function close(): void {
    if (menu.hidden) return;
    menu.hidden = true;
    button.setAttribute('aria-expanded', 'false');
    if (button.isConnected) button.focus();
  }

  button.addEventListener('click', () => (menu.hidden ? open() : close()));
  menu.addEventListener('keydown', (event) => {
    const all = items();
    const at = all.indexOf(document.activeElement as HTMLElement);
    if (event.key === 'Tab') return close();
    const moves: Readonly<Record<string, () => void>> = {
      ArrowDown: () => all[(at + 1) % all.length]?.focus(),
      ArrowUp: () => all[(at - 1 + all.length) % all.length]?.focus(),
      Enter: () => all[at]?.click(),
      ' ': () => all[at]?.click(),
      Escape: close,
    };
    const move = moves[event.key];
    if (move === undefined) return;
    event.preventDefault();
    event.stopPropagation();
    move();
  });
  document.addEventListener('mousedown', (event) => {
    if (!menu.hidden && !menu.contains(event.target as Node) && !button.contains(event.target as Node)) close();
  });

  return { button, menu, close };
}
