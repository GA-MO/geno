/// <reference lib="dom" />
import { h, icon } from './dom.js';
import { confirmOf, restoredText, REWIND_ITEMS, type RewindFromView, type RewindItem, type RewindState } from './rewind-model.js';
import { chapterForm } from './chapter-view.js';

/** The chapter part of a message's menu and slot: mark one here, rename or remove the one here, and the title field. */
export type ChapterSlot = {
  readonly marked: boolean;
  /** What the title field starts with while it shows; undefined when it does not. */
  readonly editing: string | undefined;
  readonly problem: string | undefined;
  readonly edit: () => void;
  readonly save: (title: string) => void;
  readonly remove: () => void;
  readonly cancel: () => void;
};

type ChapterItem = { readonly action: 'mark' | 'remove'; readonly icon: string; readonly label: string; readonly detail: string };

const chapterItems = (marked: boolean): readonly ChapterItem[] =>
  marked
    ? [
        { action: 'mark', icon: 'edit', label: 'Rename the chapter', detail: 'Change the title this message starts' },
        { action: 'remove', icon: 'close', label: 'Remove the chapter', detail: 'This message no longer starts a chapter' },
      ]
    : [{ action: 'mark', icon: 'bookmark', label: 'Mark a chapter here', detail: 'Start a chapter at this message, for the chapter list' }];

const ITEM_ICONS: { readonly [K in RewindItem['action']]: string } = { files: 'discard', conversation: 'comment-discussion', both: 'history', fork: 'repo-forked' };

const WORKING: { readonly [K in RewindItem['action']]: string } = {
  files: 'Looking at the files…',
  conversation: 'Rewinding…',
  both: 'Rewinding…',
  fork: 'Forking…',
};

/** The menu last focused, which a click elsewhere closes; one listener serves every message's menu. */
let openMenu: { readonly wrap: HTMLElement; readonly close: () => void } | undefined;
document.addEventListener('mousedown', (event) => {
  if (openMenu !== undefined && !openMenu.wrap.contains(event.target as Node)) openMenu.close();
});

/**
 * The message's menu: a small button over the bubble's corner, shown on hover and on keyboard focus, that opens the
 * rewinds and the fork. It keeps the send menu's keys: arrows move, Enter and Space choose, Escape closes onto the
 * button, Tab closes and moves on.
 */
function rewindMenu(turn: string, post: (message: RewindFromView) => void, chapter: ChapterSlot): HTMLElement {
  const menuId = `rewind-menu-${turn}`;
  const button = h(
    'button',
    { type: 'button', class: 'icon-button rewind-button', title: 'Rewind, fork or mark a chapter', 'aria-label': 'Rewind, fork or mark a chapter at this message', 'aria-haspopup': 'menu', 'aria-expanded': 'false', 'aria-controls': menuId, 'data-focus': `rewind:${turn}` },
    icon('history'),
  );
  const menu = h('ul', { class: 'model-menu rewind-menu', id: menuId, role: 'menu', 'aria-label': 'Rewind, fork or mark a chapter', hidden: true });
  const items = () => [...menu.querySelectorAll<HTMLElement>('[role="menuitem"]')];
  const choose = (item: RewindItem) => {
    close();
    post(item.action === 'fork' ? { type: 'fork', turn } : { type: 'rewind', turn, kind: item.action, confirmed: false });
  };
  menu.append(
    ...REWIND_ITEMS.flatMap((item) => [
      ...(item.action === 'fork' ? [h('li', { class: 'rewind-separator', role: 'separator' })] : []),
      h(
        'li',
        { class: 'model-option', role: 'menuitem', tabindex: '-1', 'data-action': item.action, onclick: () => choose(item) },
        icon(ITEM_ICONS[item.action], 'send-option-icon'),
        h('span', { class: 'model-option-text' }, h('span', { class: 'model-option-name' }, item.label), h('span', { class: 'model-option-detail' }, item.detail)),
      ),
    ]),
    h('li', { class: 'rewind-separator', role: 'separator' }),
    ...chapterItems(chapter.marked).map((item) =>
      h(
        'li',
        {
          class: 'model-option',
          role: 'menuitem',
          tabindex: '-1',
          'data-action': `chapter-${item.action}`,
          onclick: () => {
            close();
            if (item.action === 'mark') chapter.edit();
            else chapter.remove();
          },
        },
        icon(item.icon, 'send-option-icon'),
        h('span', { class: 'model-option-text' }, h('span', { class: 'model-option-name' }, item.label), h('span', { class: 'model-option-detail' }, item.detail)),
      ),
    ),
  );
  const wrap = h('div', { class: 'rewind' }, button, menu);

  function open(): void {
    menu.hidden = false;
    wrap.classList.add('open');
    button.setAttribute('aria-expanded', 'true');
    items()[0]?.focus();
  }
  function close(): void {
    if (menu.hidden) return;
    menu.hidden = true;
    wrap.classList.remove('open');
    button.setAttribute('aria-expanded', 'false');
    if (button.isConnected) button.focus();
  }
  button.addEventListener('click', () => (menu.hidden ? open() : close()));
  button.addEventListener('keydown', (event) => {
    if (event.key !== 'ArrowDown' || !menu.hidden) return;
    event.preventDefault();
    open();
  });
  menu.addEventListener('keydown', (event) => {
    const all = items();
    const at = all.indexOf(document.activeElement as HTMLElement);
    if (event.key === 'Tab') return close();
    const moves: Readonly<Record<string, () => void>> = {
      ArrowDown: () => all[(at + 1) % all.length]?.focus(),
      ArrowUp: () => all[(at - 1 + all.length) % all.length]?.focus(),
      Home: () => all[0]?.focus(),
      End: () => all.at(-1)?.focus(),
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
  wrap.addEventListener('focusin', () => (openMenu = { wrap, close }));
  return wrap;
}

/** The files a restore rewrites, and a warning when it loses edits no checkpoint holds; the keyboard starts on Cancel then. */
function confirmCard(turn: string, state: Extract<RewindState, { kind: 'confirm' }>, post: (message: RewindFromView) => void, cancel: () => void): HTMLElement {
  const words = confirmOf(state);
  const keyboard = { 'data-keyboard': true };
  return h(
    'div',
    {
      class: `rewind-confirm${words.loses === undefined ? '' : ' loses'}`,
      role: 'alertdialog',
      'aria-label': words.button,
      onkeydown: (event: Event) => {
        if ((event as KeyboardEvent).key !== 'Escape') return;
        event.preventDefault();
        event.stopPropagation();
        cancel();
      },
    },
    h('p', { class: 'rewind-confirm-title' }, words.title),
    words.loses !== undefined && h('p', { class: 'rewind-confirm-loses' }, icon('warning'), h('span', {}, words.loses)),
    h(
      'div',
      { class: 'rewind-confirm-actions' },
      h('button', { type: 'button', class: 'button small secondary', 'data-action': 'cancel', onclick: cancel, ...(words.safeFirst ? keyboard : {}) }, 'Cancel'),
      h(
        'button',
        { type: 'button', class: 'button small', 'data-action': 'confirm', onclick: () => post({ type: 'rewind', turn, kind: state.action, confirmed: true }), ...(words.safeFirst ? {} : keyboard) },
        words.button,
      ),
    ),
  );
}

const LINES: { readonly [K in Exclude<RewindState['kind'], 'confirm'>]: (state: Extract<RewindState, { kind: K }>) => HTMLElement } = {
  working: ({ action }) => h('p', { class: 'rewind-line', role: 'status' }, icon('loading', 'codicon-modifier-spin'), h('span', {}, WORKING[action])),
  restored: ({ files }) => h('p', { class: 'rewind-line', role: 'status' }, icon('check'), h('span', {}, restoredText(files))),
  failed: ({ message }) => h('p', { class: 'rewind-line failed', role: 'alert' }, icon('error'), h('span', {}, message)),
};

/** What sits under a message: its menu while it offers one, how a rewind or fork from it goes, and the chapter title field. */
export function rewindSlot(turn: string, offered: boolean, state: RewindState | undefined, post: (message: RewindFromView) => void, clear: () => void, chapter: ChapterSlot): HTMLElement {
  const line =
    state === undefined
      ? undefined
      : state.kind === 'confirm'
        ? confirmCard(turn, state, post, clear)
        : (LINES[state.kind] as (s: RewindState) => HTMLElement)(state);
  const field =
    chapter.editing !== undefined
      ? chapterForm(turn, chapter.editing, chapter.marked, chapter.problem, chapter.save, chapter.cancel)
      : chapter.problem !== undefined && h('p', { class: 'rewind-line failed', role: 'alert' }, icon('error'), h('span', {}, chapter.problem));
  return h('div', { class: 'rewind-slot-body' }, offered && rewindMenu(turn, post, chapter), line, field);
}
