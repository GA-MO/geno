/// <reference lib="dom" />
import type { AppliedRule, MemoryEntry, MemoryScope, RuleTrigger } from '@g-code/core';
import { h, icon, reconcile } from './dom.js';
import type { ContextFromView, MemoryListing, RulesListing } from './messages.js';

/**
 * The rules and memory panes, which take the transcript's place while open, as the history and the MCP servers do.
 * `onToggle` hears when one opens or closes.
 */

type Post = (message: ContextFromView) => void;

/** A pane's frame: its bar with the back arrow, and opening, closing and Escape. `fill` draws its content. */
function pane(label: string, heading: string, className: string, onOpen: () => void, onToggle: (open: boolean) => void, ...bar: HTMLElement[]) {
  let open = false;
  const body = h('div', { class: 'context-pane-body' });
  const element = h(
    'section',
    { class: `context-pane ${className}`, 'aria-label': label, hidden: true },
    h(
      'div',
      { class: 'history-bar' },
      h('button', { type: 'button', class: 'icon-button history-back', title: 'Back to the chat (Escape)', 'aria-label': 'Back to the chat', onclick: () => close() }, icon('arrow-left')),
      h('h2', { class: 'history-heading' }, heading),
      h('span', { class: 'spacer' }),
      ...bar,
    ),
    body,
  );
  function show(): void {
    if (open) return;
    open = true;
    element.hidden = false;
    onToggle(true);
    onOpen();
    requestAnimationFrame(() => element.querySelector<HTMLElement>('.history-back')?.focus());
  }
  function close(): void {
    if (!open) return;
    open = false;
    element.hidden = true;
    onToggle(false);
  }
  document.addEventListener('keydown', (event) => {
    if (event.key !== 'Escape' || !open) return;
    // Escape inside a note being edited cancels the edit, not the pane.
    if ((event.target as HTMLElement | null)?.closest?.('.memory-editing') != null) return;
    event.preventDefault();
    close();
  });
  return { element, body, isOpen: () => open, open: show, close };
}

const TRIGGERS: { readonly [K in RuleTrigger['kind']]: (trigger: Extract<RuleTrigger, { kind: K }>) => string } = {
  always: () => 'Always on',
  globs: ({ globs }) => `When a file matches ${globs.join(', ')}`,
  requested: ({ description }) => `When relevant: ${description}`,
};

const triggerText = (trigger: RuleTrigger): string => (TRIGGERS[trigger.kind] as (t: RuleTrigger) => string)(trigger);

const SOURCES: Readonly<Record<AppliedRule['source'], string>> = { global: 'Your global rules', instructions: 'Instructions', 'cursor-rule': 'Cursor rule' };

const note = (text: string): HTMLElement => h('p', { class: 'history-note' }, text);

export function rulesPanel(post: Post, onToggle: (open: boolean) => void) {
  let listing: RulesListing = { kind: 'loading' };
  const edit = h('button', { type: 'button', class: 'button secondary rules-edit-global', 'data-focus': 'edit-global-rules', onclick: () => post({ type: 'edit-global-rules' }) }, icon('edit'), 'Edit global rules');
  const frame = pane('Rules', 'Rules', 'rules', () => post({ type: 'rules-list' }), onToggle, edit);
  const list = h('ol', { class: 'rules-list', 'aria-label': 'Rules in load order' });

  function render(): void {
    if (listing.kind !== 'loaded') {
      frame.body.replaceChildren(note(listing.kind === 'loading' ? 'Loading the rules…' : `Could not list the rules: ${listing.message}`));
      return;
    }
    const { rules } = listing;
    reconcile(
      list,
      rules.map((rule, i) => ({
        key: `${i}:${rule.file}`,
        deps: [rule],
        build: () =>
          h(
            'li',
            { class: 'rules-row', 'data-rule': rule.path, 'data-source': rule.source },
            h(
              'button',
              { type: 'button', class: 'rules-open', title: `Open ${rule.file}`, 'data-focus': `rule:${rule.file}`, onclick: () => post({ type: 'open-file', file: rule.file }) },
              icon(rule.source === 'global' ? 'account' : rule.source === 'cursor-rule' ? 'symbol-ruler' : 'book'),
              h('span', { class: 'rules-path' }, rule.path),
            ),
            h('span', { class: 'rules-meta' }, h('span', { class: 'rules-source' }, SOURCES[rule.source]), h('span', { class: `rules-trigger trigger-${rule.trigger.kind}` }, triggerText(rule.trigger))),
          ),
      })),
    );
    frame.body.replaceChildren(
      note(
        rules.length === 0
          ? 'No rules apply to this chat. Add an AGENTS.md to the project, or global rules for every project.'
          : 'What this chat loaded when it started, in load order. Changes apply to new chats.',
      ),
      list,
    );
  }

  return {
    ...frame,
    listed(next: RulesListing): void {
      listing = next;
      render();
    },
  };
}

const SCOPES: readonly { readonly scope: MemoryScope; readonly heading: string }[] = [
  { scope: 'global', heading: 'Every project' },
  { scope: 'project', heading: 'This project' },
];

const formatDate = (iso: string): string => new Date(iso).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });

export function memoryPanel(post: Post, onToggle: (open: boolean) => void) {
  let listing: MemoryListing = { kind: 'loading' };
  /** The note being edited, which keeps its draft across redraws. */
  let editing: { readonly id: string; draft: string } | undefined;
  const frame = pane('Memory', 'Memory', 'memory', () => post({ type: 'memory-list' }), (open) => {
    if (!open) editing = undefined;
    onToggle(open);
  });

  function entryRow(entry: MemoryEntry): HTMLElement {
    if (editing?.id === entry.id) {
      const field = h('textarea', { class: 'memory-input', rows: 3, 'aria-label': 'Note text', 'data-focus': `memory-input:${entry.id}` });
      field.value = editing.draft;
      field.addEventListener('input', () => editing !== undefined && (editing.draft = field.value));
      const cancel = () => {
        editing = undefined;
        render();
      };
      const save = () => {
        post({ type: 'memory-edit', id: entry.id, text: field.value });
        editing = undefined;
      };
      field.addEventListener('keydown', (event) => {
        if (event.key === 'Escape') {
          event.preventDefault();
          cancel();
        } else if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
          event.preventDefault();
          save();
        }
      });
      requestAnimationFrame(() => field.focus());
      return h(
        'li',
        { class: 'memory-row memory-editing', 'data-memory': entry.id },
        field,
        h(
          'div',
          { class: 'memory-actions' },
          h('button', { type: 'button', class: 'button', 'data-focus': `memory-save:${entry.id}`, onclick: save }, 'Save'),
          h('button', { type: 'button', class: 'button secondary', onclick: cancel }, 'Cancel'),
        ),
      );
    }
    return h(
      'li',
      { class: 'memory-row', 'data-memory': entry.id },
      h('p', { class: 'memory-entry-text' }, entry.text),
      h(
        'div',
        { class: 'memory-foot' },
        h('span', { class: 'memory-date' }, `Saved ${formatDate(entry.createdAt)}`),
        h('span', { class: 'spacer' }),
        h(
          'button',
          {
            type: 'button',
            class: 'icon-button memory-edit',
            title: 'Edit',
            'aria-label': 'Edit this note',
            'data-focus': `memory-edit:${entry.id}`,
            onclick: () => {
              editing = { id: entry.id, draft: entry.text };
              render();
            },
          },
          icon('edit'),
        ),
        h(
          'button',
          { type: 'button', class: 'icon-button memory-delete', title: 'Delete (moves it to the trash)', 'aria-label': 'Delete this note', 'data-focus': `memory-delete:${entry.id}`, onclick: () => post({ type: 'memory-delete', id: entry.id }) },
          icon('trash'),
        ),
      ),
    );
  }

  function render(): void {
    if (listing.kind !== 'loaded') {
      frame.body.replaceChildren(note(listing.kind === 'loading' ? 'Loading memory…' : `Could not read memory: ${listing.message}`));
      return;
    }
    const { entries } = listing;
    if (entries.length === 0) {
      frame.body.replaceChildren(note('Geno remembers nothing yet. When it proposes a note, it shows you the exact text and saves it only if you agree.'));
      return;
    }
    frame.body.replaceChildren(
      ...SCOPES.flatMap(({ scope, heading }) => {
        const mine = entries.filter((entry) => entry.scope === scope);
        if (mine.length === 0) return [];
        return [h('h3', { class: 'memory-heading' }, heading), h('ul', { class: 'memory-list', 'data-scope': scope, 'aria-label': heading }, ...mine.map(entryRow))];
      }),
    );
  }

  return {
    ...frame,
    listed(next: MemoryListing): void {
      listing = next;
      render();
    },
  };
}
