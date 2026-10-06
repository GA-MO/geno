/// <reference lib="dom" />
import { h, icon, reconcile, type Keyed } from './dom.js';
import { formatCost } from './format.js';
import type { Snippet } from '@g-code/core';
import { CLOSED, formatAgo, hitPlace, historyReduce, shownRows, type HistoryEvent, type HistoryState, type RowMode } from './history-state.js';
import type { FromView, HistoryHit, HistoryRow, HistoryScope } from './messages.js';

const SCOPES: readonly { readonly scope: HistoryScope; readonly label: string }[] = [
  { scope: 'project', label: 'This project' },
  { scope: 'all', label: 'All projects' },
];

/** Typing waits this long for the next key before the engine searches the sessions' text. */
const SEARCH_PAUSE_MS = 120;

/** The excerpt as text with its matches in `mark`s; the text is the session's, so it is never parsed as HTML. */
function snippetNodes({ text, marks }: Snippet): (string | HTMLElement)[] {
  const nodes: (string | HTMLElement)[] = [];
  let at = 0;
  for (const [from, to] of marks) {
    if (from > at) nodes.push(text.slice(at, from));
    nodes.push(h('mark', {}, text.slice(from, to)));
    at = to;
  }
  if (at < text.length) nodes.push(text.slice(at));
  return nodes;
}

/**
 * The history list, which takes the transcript's place while open: search over the titles and the sessions' text,
 * the project or all-projects toggle, and rows that open, rename or trash a session. A row the search found opens at
 * the turn it found. `onToggle` hears when it opens or closes.
 */
export function historyPanel(post: (message: FromView) => void, onToggle: (open: boolean) => void) {
  let state: HistoryState = CLOSED;
  let pause: ReturnType<typeof setTimeout> | undefined;

  /** Asks the engine to search the text for the query as it stands, once typing pauses. */
  function searchSoon(): void {
    clearTimeout(pause);
    if (state.kind !== 'open' || state.found.kind !== 'searching') return;
    const { scope, found } = state;
    pause = setTimeout(() => post({ type: 'search-sessions', scope, query: found.query }), SEARCH_PAUSE_MS);
  }

  const search = h('input', {
    type: 'search',
    class: 'history-search-input',
    placeholder: 'Search chats',
    'aria-label': 'Search chats',
    'data-focus': 'history-search',
    oninput: () => {
      const before = state;
      apply({ type: 'query', query: search.value });
      if (state.kind === 'open' && before.kind === 'open' && state.found !== before.found) searchSoon();
    },
  });
  const scopes = SCOPES.map(({ scope, label }) =>
    h('button', { type: 'button', class: 'scope-option', role: 'radio', 'data-scope': scope, onclick: () => choose(scope) }, label),
  );
  const list = h('ul', { class: 'history-list', 'aria-label': 'Chats' });
  const note = h('p', { class: 'history-note', role: 'status' });
  const element = h(
    'section',
    { class: 'history', 'aria-label': 'Chat history', hidden: true },
    h(
      'div',
      { class: 'history-bar' },
      h('button', { type: 'button', class: 'icon-button history-back', title: 'Back to the chat (Escape)', 'aria-label': 'Back to the chat', onclick: () => apply({ type: 'close' }) }, icon('arrow-left')),
      h('h2', { class: 'history-heading' }, 'Chats'),
      h('span', { class: 'spacer' }),
      h('div', { class: 'scope-toggle', role: 'radiogroup', 'aria-label': 'Which chats' }, ...scopes),
    ),
    h('label', { class: 'history-search' }, icon('search'), search),
    note,
    list,
  );

  function choose(scope: HistoryScope): void {
    const before = state;
    apply({ type: 'scope', scope });
    if (state === before) return;
    post({ type: 'list-sessions', scope });
    searchSoon();
  }

  function apply(event: HistoryEvent): void {
    const before = state;
    state = historyReduce(state, event);
    if (state === before) return;
    if (before.kind !== state.kind) {
      element.hidden = state.kind === 'closed';
      onToggle(state.kind === 'open');
      if (state.kind === 'open') {
        search.value = '';
        post({ type: 'list-sessions', scope: state.scope });
        requestAnimationFrame(() => search.focus());
      }
    }
    render();
  }

  function render(): void {
    if (state.kind === 'closed') return;
    const { scope, listing, query, found, row } = state;
    for (const option of scopes) option.setAttribute('aria-checked', String(option.dataset['scope'] === scope));
    const rows = shownRows(state);
    note.textContent =
      listing.kind === 'loading'
        ? 'Loading chats…'
        : listing.kind === 'failed'
          ? `Could not list the chats: ${listing.message}`
          : found.kind === 'failed'
            ? `Could not search the chats’ text: ${found.message}`
            : rows.length > 0
              ? ''
              : found.kind === 'searching'
                ? 'Searching chats…'
                : query.trim() !== ''
                  ? `No chats match “${query.trim()}”.`
                  : scope === 'project'
                    ? 'No chats in this project yet.'
                    : 'No chats yet.';
    note.hidden = note.textContent === '';
    const now = Date.now();
    reconcile(
      list,
      rows.map(({ row: r, hit }): Keyed => {
        const mode = row.kind !== 'browsing' && row.id === r.id ? row.kind : 'browsing';
        return { key: r.id, deps: [r, hit, mode, scope, Math.floor(now / 60_000)], build: () => rowItem(r, hit, mode, scope, now) };
      }),
    );
  }

  function rowItem(row: HistoryRow, hit: HistoryHit | undefined, mode: RowMode['kind'], scope: HistoryScope, now: number): HTMLElement {
    const label = h('span', { class: 'history-row-title' }, row.title);
    if (mode === 'renaming') {
      const input = h('input', { type: 'text', class: 'history-rename', value: row.title, 'aria-label': `New title for ${row.title}`, 'data-focus': `rename:${row.id}` });
      const save = () => {
        const title = input.value.trim();
        if (title !== '' && title !== row.title) post({ type: 'rename-session', id: row.id, title, scope });
        apply({ type: 'browse' });
      };
      input.addEventListener('keydown', (event) => {
        if (event.key === 'Enter') save();
        if (event.key === 'Escape') {
          event.stopPropagation();
          apply({ type: 'browse' });
        }
      });
      requestAnimationFrame(() => {
        input.focus();
        input.select();
      });
      return h(
        'li',
        { class: 'history-row renaming', 'data-session': row.id },
        input,
        h('button', { type: 'button', class: 'icon-button', title: 'Save the title', 'aria-label': 'Save the title', onclick: save }, icon('check')),
        h('button', { type: 'button', class: 'icon-button', title: 'Cancel', 'aria-label': 'Cancel renaming', onclick: () => apply({ type: 'browse' }) }, icon('close')),
      );
    }
    if (mode === 'confirming') {
      const cancel = h('button', { type: 'button', class: 'button small secondary', onclick: () => apply({ type: 'browse' }) }, 'Cancel');
      requestAnimationFrame(() => cancel.focus());
      return h(
        'li',
        { class: 'history-row confirming', 'data-session': row.id },
        h('span', { class: 'history-confirm' }, 'Move ', h('strong', {}, row.title), ' to the trash?'),
        h(
          'span',
          { class: 'history-confirm-actions' },
          cancel,
          h(
            'button',
            {
              type: 'button',
              class: 'button small danger',
              onclick: () => {
                post({ type: 'delete-session', id: row.id, scope });
                apply({ type: 'browse' });
                search.focus();
              },
            },
            'Move to trash',
          ),
        ),
      );
    }
    const meta = [
      scope === 'all' ? row.project : undefined,
      formatAgo(row.updatedAt, now),
      `${row.turns} ${row.turns === 1 ? 'turn' : 'turns'}`,
      row.costUsd === null ? undefined : formatCost(row.costUsd),
    ].filter((part) => part !== undefined);
    const origin = row.forkedFrom;
    return h(
      'li',
      { class: `history-row${row.current ? ' current' : ''}${origin === undefined ? '' : ' forked'}`, 'data-session': row.id },
      h(
        'button',
        {
          type: 'button',
          class: 'history-open',
          'data-focus': `open:${row.id}`,
          title: !row.here ? `Open in the ${row.project} window` : hit?.turn != null ? `Open this chat at turn ${hit.turn.number}` : 'Open this chat',
          onclick: () => post({ type: 'open-session', id: row.id, workspace: row.workspace, turnSeq: hit?.turn?.seq }),
        },
        h('span', { class: 'history-row-head' }, label, row.current && h('span', { class: 'history-current' }, 'Current'), !row.here && icon('link-external', 'history-elsewhere')),
        h('span', { class: 'history-meta' }, meta.join(' · ')),
        hit !== undefined &&
          h(
            'span',
            { class: 'history-hit' },
            h('span', { class: 'history-hit-place' }, hitPlace(hit, now)),
            h('span', { class: 'history-snippet' }, ...snippetNodes(hit.snippet)),
          ),
      ),
      h(
        'span',
        { class: 'history-actions' },
        h('button', { type: 'button', class: 'icon-button', title: 'Rename', 'aria-label': `Rename ${row.title}`, onclick: () => apply({ type: 'rename', id: row.id }) }, icon('edit')),
        h('button', { type: 'button', class: 'icon-button', title: 'Move to trash', 'aria-label': `Delete ${row.title}`, onclick: () => apply({ type: 'confirm', id: row.id }) }, icon('trash')),
      ),
      origin !== undefined &&
        h(
          'button',
          { type: 'button', class: 'link-button history-fork', title: `Open ${origin.title}`, 'data-focus': `fork-origin:${row.id}`, onclick: () => post({ type: 'open-session', id: origin.id, workspace: row.workspace }) },
          icon('repo-forked'),
          h('span', {}, `Forked from ${origin.title}`),
        ),
    );
  }

  // On the document: a row that took the focus with it when it went leaves the focus on the body.
  document.addEventListener('keydown', (event) => {
    if (event.key !== 'Escape' || state.kind === 'closed') return;
    event.preventDefault();
    apply(state.kind === 'open' && state.row.kind !== 'browsing' ? { type: 'browse' } : { type: 'close' });
  });

  return {
    element,
    isOpen: () => state.kind === 'open',
    open: () => apply({ type: 'open' }),
    close: () => apply({ type: 'close' }),
    listed: (scope: HistoryScope, rows: readonly HistoryRow[]) => apply({ type: 'listed', scope, rows }),
    failed: (scope: HistoryScope, message: string) => apply({ type: 'failed', scope, message }),
    found: (scope: HistoryScope, query: string, hits: readonly HistoryHit[]) => apply({ type: 'hits', scope, query, hits }),
    searchFailed: (scope: HistoryScope, query: string, message: string) => apply({ type: 'hits-failed', scope, query, message }),
  };
}
