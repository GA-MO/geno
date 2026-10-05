/// <reference lib="dom" />
import { h, icon } from './dom.js';
import type { ModeOption, Modes } from './messages.js';

/** How the composer names each mode the engine offers, with its icon; an unknown mode shows the engine's own name. */
const LOOKS: Readonly<Record<string, { readonly label: string; readonly icon: string }>> = {
  plan: { label: 'Plan', icon: 'checklist' },
  ask: { label: 'Ask before risky commands', icon: 'shield' },
  auto: { label: 'Auto', icon: 'zap' },
};

const lookOf = (mode: ModeOption | undefined, id: string) => LOOKS[id] ?? { label: mode?.name ?? id, icon: 'settings' };

const words = (text: string): string => text.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

/** The engine's description, unless it only repeats the label. */
const detailOf = (mode: ModeOption, label: string): string | undefined =>
  mode.description === undefined || words(mode.description) === words(label) ? undefined : mode.description;

/**
 * The composer's approval mode: a button naming the mode, which opens a menu of the modes the engine offers.
 * Choosing one asks the extension to switch; the button changes when the engine confirms. `onShow` hears each mode.
 */
export function modePicker(choose: (modeId: string) => void, onShow: (modes: Modes) => void) {
  let modes: Modes = { current: 'ask', available: [] };
  const glyph = h('span', { class: 'mode-icon' });
  const label = h('span', { class: 'mode-name' });
  const element = h(
    'button',
    { type: 'button', class: 'mode-picker', 'aria-haspopup': 'menu', 'aria-expanded': 'false', 'aria-controls': 'mode-menu', onclick: () => (menu.hidden ? open() : close()) },
    glyph,
    label,
    icon('chevron-down', 'mode-chevron'),
  );
  const menu = h('ul', { class: 'mode-menu', id: 'mode-menu', role: 'menu', 'aria-label': 'Approval mode', hidden: true });

  function items(): HTMLElement[] {
    return [...menu.querySelectorAll<HTMLElement>('[role="menuitemradio"]')];
  }

  function open(): void {
    menu.replaceChildren(
      ...modes.available.map((mode) => {
        const look = lookOf(mode, mode.id);
        const detail = detailOf(mode, look.label);
        return h(
          'li',
          {
            class: `mode-option mode-${mode.id}`,
            role: 'menuitemradio',
            tabindex: '-1',
            'aria-checked': String(mode.id === modes.current),
            'data-mode': mode.id,
            onclick: () => {
              close();
              if (mode.id !== modes.current) choose(mode.id);
            },
          },
          icon(look.icon, 'mode-option-icon'),
          h('span', { class: 'mode-option-text' }, h('span', { class: 'mode-option-name' }, look.label), detail !== undefined && h('span', { class: 'mode-option-detail' }, detail)),
          mode.id === modes.current && icon('check', 'mode-check'),
        );
      }),
    );
    menu.hidden = false;
    element.setAttribute('aria-expanded', 'true');
    (items().find((item) => item.getAttribute('aria-checked') === 'true') ?? items()[0])?.focus();
  }

  function close(): void {
    if (menu.hidden) return;
    menu.hidden = true;
    element.setAttribute('aria-expanded', 'false');
    element.focus();
  }

  menu.addEventListener('keydown', (event) => {
    const all = items();
    const at = all.indexOf(document.activeElement as HTMLElement);
    const moves: Readonly<Record<string, () => void>> = {
      ArrowDown: () => all[(at + 1) % all.length]?.focus(),
      ArrowUp: () => all[(at - 1 + all.length) % all.length]?.focus(),
      Enter: () => all[at]?.click(),
      ' ': () => all[at]?.click(),
      Escape: close,
      Tab: close,
    };
    const move = moves[event.key];
    if (move === undefined) return;
    event.preventDefault();
    event.stopPropagation();
    move();
  });
  document.addEventListener('mousedown', (event) => {
    if (!menu.hidden && !menu.contains(event.target as Node) && !element.contains(event.target as Node)) close();
  });

  return {
    element,
    menu,
    show(next: Modes): void {
      modes = next;
      const look = lookOf(next.available.find((m) => m.id === next.current), next.current);
      glyph.replaceChildren(icon(look.icon));
      label.textContent = look.label;
      element.dataset['mode'] = next.current;
      element.title = `${next.available.find((m) => m.id === next.current)?.description ?? look.label} Click to change.`;
      onShow(next);
    },
  };
}
