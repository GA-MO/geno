/// <reference lib="dom" />
import { CHAPTER_LIMITS, type ChapterMark } from '@g-code/core/chapters';
import { h, icon } from './dom.js';
import type { TocEntry } from './chapter-model.js';

/** A chapter's divider: a thin rule with the title, a heading so a screen reader can jump between chapters too. */
export const chapterDivider = (mark: ChapterMark, anchor: string, by: 'agent' | 'user'): HTMLElement =>
  h(
    'h2',
    { class: 'chapter-divider', 'data-chapter': anchor, 'data-by': by, ...(mark.summary === undefined ? {} : { title: mark.summary }) },
    h('span', { class: 'chapter-title' }, mark.title),
  );

/** The title field under a message, to mark or rename the chapter that starts there. Enter saves, Escape cancels. */
export function chapterForm(turn: string, initial: string, renaming: boolean, problem: string | undefined, save: (title: string) => void, cancel: () => void): HTMLElement {
  const field = h('input', { type: 'text', class: 'chapter-input', value: initial, maxlength: CHAPTER_LIMITS.title, 'aria-label': 'Chapter title', placeholder: 'Chapter title', 'data-focus': `chapter-title:${turn}` });
  const submit = (event: Event) => {
    event.preventDefault();
    if (field.value.trim() !== '') save(field.value.trim());
  };
  return h(
    'form',
    {
      class: 'chapter-form',
      onsubmit: submit,
      onkeydown: (event: Event) => {
        if ((event as KeyboardEvent).key !== 'Escape') return;
        event.preventDefault();
        event.stopPropagation();
        cancel();
      },
    },
    icon('bookmark'),
    field,
    h('button', { type: 'submit', class: 'button small' }, renaming ? 'Rename' : 'Mark chapter'),
    h('button', { type: 'button', class: 'button small secondary', onclick: cancel }, 'Cancel'),
    problem !== undefined && h('p', { class: 'chapter-problem', role: 'alert' }, icon('error'), h('span', {}, problem)),
  );
}

/** Below this width an open list covers the chat, so choosing a chapter closes it. */
const NARROW_PX = 480;

export type Toc = {
  /** The zero-height slot above the transcript that the floating list hangs from. */
  readonly element: HTMLElement;
  /** Shows the rows, or nothing for a chat without chapters, with the row at `current` marked. */
  show(entries: readonly TocEntry[], current: number): void;
};

/**
 * The table of contents: a small button at the transcript's top left, beside the stuck request, that opens the list
 * of chapters, the current one marked. The list stays open while the chat scrolls, so the current row follows the reading, until the button,
 * Escape, or a choice on a narrow panel closes it. Arrows, Home and End move between rows.
 */
export function chapterToc(jump: (entry: TocEntry) => void): Toc {
  const listId = 'chapter-toc-list';
  const toggle = h('button', { type: 'button', class: 'chapter-toc-toggle', 'aria-expanded': 'false', 'aria-controls': listId, 'data-focus': 'chapter-toc' }, icon('list-unordered'));
  const list = h('ol', { class: 'chapter-toc-list', id: listId, hidden: true });
  const nav = h('nav', { class: 'chapter-toc', 'aria-label': 'Chapters' }, toggle, list);
  const element = h('div', { class: 'chapter-toc-slot', hidden: true }, nav);
  let shown: readonly TocEntry[] = [];
  let rows: HTMLButtonElement[] = [];

  const setOpen = (open: boolean): void => {
    list.hidden = !open;
    nav.classList.toggle('open', open);
    toggle.setAttribute('aria-expanded', String(open));
  };
  const close = (): void => {
    setOpen(false);
    toggle.focus();
  };
  toggle.addEventListener('click', () => {
    setOpen(list.hidden);
    if (!list.hidden) (rows.find((row) => row.getAttribute('aria-current') === 'true') ?? rows[0])?.focus();
  });
  list.addEventListener('keydown', (event) => {
    const at = rows.indexOf(document.activeElement as HTMLButtonElement);
    const moves: Readonly<Record<string, () => void>> = {
      ArrowDown: () => rows[Math.min(rows.length - 1, at + 1)]?.focus(),
      ArrowUp: () => rows[Math.max(0, at - 1)]?.focus(),
      Home: () => rows[0]?.focus(),
      End: () => rows.at(-1)?.focus(),
      Escape: close,
    };
    const move = moves[event.key];
    if (move === undefined) return;
    event.preventDefault();
    event.stopPropagation();
    move();
  });

  const build = (entries: readonly TocEntry[]): void => {
    rows = entries.map((entry) =>
      h(
        'button',
        {
          type: 'button',
          class: 'chapter-toc-item',
          'data-anchor': entry.anchor,
          'data-by': entry.by,
          onclick: () => {
            jump(entry);
            if (window.innerWidth < NARROW_PX) setOpen(false);
          },
        },
        h('span', { class: 'chapter-toc-title' }, entry.title),
        entry.summary !== undefined && h('span', { class: 'chapter-toc-summary' }, entry.summary),
      ),
    );
    list.replaceChildren(...rows.map((row) => h('li', {}, row)));
  };

  return {
    element,
    show(entries, at) {
      if (JSON.stringify(entries) !== JSON.stringify(shown)) build(entries);
      shown = entries;
      element.hidden = entries.length === 0;
      if (entries.length === 0) return setOpen(false);
      rows.forEach((row, i) => (i === at ? row.setAttribute('aria-current', 'true') : row.removeAttribute('aria-current')));
      const title = entries[at]?.title ?? '';
      toggle.title = `Chapters: ${title}`;
      toggle.setAttribute('aria-label', `Chapters, ${entries.length - (entries[0]?.by === 'start' ? 1 : 0)} marked. Now in: ${title}`);
    },
  };
}
