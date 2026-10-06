/// <reference lib="dom" />
import type { TaskRecord } from '@g-code/core';
import { h, icon, reconcile } from './dom.js';
import { laneRowOf, taskOrder, taskRowOf, type Badge, type LaneRow, type LanesFromView, type LanesListing, type TaskRow } from './lanes-model.js';

const badge = ({ label, tone }: Badge, extra = ''): HTMLElement =>
  h('span', { class: `mcp-state tone-${tone} ${extra}`.trim() }, tone === 'busy' ? icon('loading', 'codicon-modifier-spin') : undefined, label);

/** A pane that takes the transcript's place while open, with Back and Escape, as the MCP pane does. */
function pane(label: string, heading: string, onToggle: (open: boolean) => void, shown: () => void) {
  let open = false;
  const body = h('div', { class: 'lanes-body' });
  const element = h(
    'section',
    { class: 'lanes', 'aria-label': label, hidden: true },
    h(
      'div',
      { class: 'history-bar' },
      h('button', { type: 'button', class: 'icon-button history-back', title: 'Back to the chat (Escape)', 'aria-label': 'Back to the chat', onclick: () => close() }, icon('arrow-left')),
      h('h2', { class: 'history-heading' }, heading),
    ),
    body,
  );
  function show(): void {
    if (open) return;
    open = true;
    element.hidden = false;
    onToggle(true);
    shown();
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
    event.preventDefault();
    close();
  });
  return { element, body, isOpen: () => open, open: show, close };
}

const LANES_NOTE =
  'A lane is a copy of the repository on its own branch, where a task runs without touching your files. Start one with Run in a new lane in the send menu, then apply what it made for review.';

function laneItem(row: LaneRow, confirming: boolean, post: (message: LanesFromView) => void, confirm: (name: string | undefined) => void, done: () => void): HTMLElement {
  const { name, actions } = row;
  const discard = () => (actions.discard === 'confirm' ? confirm(name) : post({ type: 'lane-discard', name, discardChanges: false }));
  return h(
    'li',
    { class: 'lane-row', 'data-lane': name },
    h('div', { class: 'lane-head' }, icon('repo-forked', 'kind'), h('span', { class: 'lane-name' }, name), h('span', { class: 'spacer' }), badge(row.state, 'lane-state')),
    h('p', { class: 'lane-task', title: row.task }, row.task),
    h(
      'p',
      { class: 'lane-meta' },
      h('span', { class: 'lane-diff', title: row.diffTitle, 'aria-label': row.diffTitle }, row.diff),
      badge(row.check, 'lane-check'),
      row.cost !== undefined && h('span', { class: 'lane-cost', title: 'What the lane’s task cost' }, row.cost),
    ),
    confirming
      ? h(
          'div',
          { class: 'lane-confirm', role: 'group', 'aria-label': `Discard lane ${name}` },
          h('p', { class: 'lane-confirm-text' }, `Discard lane ${name}? Its changes are not applied, and its folder and branch are deleted.`),
          h(
            'div',
            { class: 'lane-actions' },
            h('button', { type: 'button', class: 'button small danger', 'data-focus': `lane-discard-yes:${name}`, onclick: () => (confirm(undefined), post({ type: 'lane-discard', name, discardChanges: true })) }, 'Discard'),
            h('button', { type: 'button', class: 'button small secondary', 'data-focus': `lane-discard-no:${name}`, onclick: () => confirm(undefined) }, 'Cancel'),
          ),
        )
      : h(
          'div',
          { class: 'lane-actions' },
          h('button', { type: 'button', class: 'button small secondary', 'data-action': 'open', disabled: !actions.open, title: 'Show the lane’s chat', onclick: () => (done(), post({ type: 'lane-open', name })) }, 'Open'),
          h(
            'button',
            { type: 'button', class: 'button small', 'data-action': 'apply', disabled: !actions.apply, title: 'Apply the lane’s changes to your files, for review', onclick: () => (done(), post({ type: 'lane-apply', name })) },
            'Apply',
          ),
          h('button', { type: 'button', class: 'button small ghost', 'data-action': 'discard', 'data-focus': `lane-discard:${name}`, disabled: actions.discard === 'off', title: 'Delete the lane', onclick: discard }, 'Discard'),
        ),
  );
}

/** The Lanes pane: every lane of the folder with its task, status, diff, check and cost, and Open, Apply and Discard. */
export function lanesPanel(post: (message: LanesFromView) => void, onToggle: (open: boolean) => void) {
  let listing: LanesListing = { kind: 'loading' };
  let confirming: string | undefined;
  const list = h('ul', { class: 'lane-list', 'aria-label': 'Lanes' });
  const note = h('p', { class: 'history-note lanes-note', role: 'status' });
  const frame = pane('Lanes', 'Lanes', onToggle, () => {
    post({ type: 'lanes-list' });
    render();
  });
  frame.body.append(note, list);

  function render(): void {
    if (!frame.isOpen()) return;
    const lanes = listing.kind === 'loaded' ? listing.lanes : [];
    note.textContent = listing.kind === 'loading' ? 'Loading the lanes…' : listing.kind === 'failed' ? `Could not list the lanes: ${listing.message}` : lanes.length === 0 ? LANES_NOTE : '';
    note.hidden = note.textContent === '';
    if (confirming !== undefined && !lanes.some((lane) => lane.name === confirming)) confirming = undefined;
    const rows = lanes.map(laneRowOf);
    reconcile(
      list,
      rows.map((row) => ({
        key: row.name,
        deps: [JSON.stringify(row), confirming === row.name],
        build: () =>
          laneItem(
            row,
            confirming === row.name,
            post,
            (name) => {
              confirming = name;
              render();
              list.querySelector<HTMLElement>(`[data-focus="${CSS.escape(name === undefined ? `lane-discard:${row.name}` : `lane-discard-no:${row.name}`)}"]`)?.focus();
            },
            () => frame.close(),
          ),
      })),
    );
  }

  return {
    element: frame.element,
    isOpen: frame.isOpen,
    open: frame.open,
    close: frame.close,
    listed(next: LanesListing): void {
      listing = next;
      render();
    },
  };
}

function taskItem(row: TaskRow, post: (message: LanesFromView) => void, done: () => void): HTMLElement {
  return h(
    'li',
    { class: `task-row${row.current ? ' current' : ''}`, 'data-task': row.id },
    h('div', { class: 'lane-head' }, h('span', { class: 'lane-name task-title', title: row.title }, row.title), h('span', { class: 'spacer' }), badge(row.state, 'task-state')),
    h('p', { class: 'lane-meta' }, h('span', {}, row.where), h('span', { class: 'task-time' }, row.time), row.cost !== undefined && h('span', { class: 'lane-cost' }, row.cost)),
    h(
      'div',
      { class: 'lane-actions' },
      row.current
        ? h('span', { class: 'task-here' }, 'Shown in the chat')
        : h('button', { type: 'button', class: 'button small secondary', 'data-action': 'open', onclick: () => (done(), post({ type: 'task-open', sessionId: row.id })) }, 'Open'),
      row.live && h('button', { type: 'button', class: 'button small ghost', 'data-action': 'stop', title: 'Stop the task', onclick: () => post({ type: 'task-stop', sessionId: row.id }) }, 'Stop'),
    ),
  );
}

const TASKS_NOTE = 'No tasks yet. A chat or lane that runs a turn shows here, and goes on running when the panel closes or the window reloads.';

/** The Tasks pane: the engine's running and finished sessions, running first. */
export function tasksPanel(post: (message: LanesFromView) => void, onToggle: (open: boolean) => void) {
  let tasks: readonly TaskRecord[] = [];
  let shown: string | undefined;
  let ticking: ReturnType<typeof setInterval> | undefined;
  const list = h('ul', { class: 'lane-list', 'aria-label': 'Tasks' });
  const note = h('p', { class: 'history-note lanes-note', role: 'status' });
  const frame = pane('Tasks', 'Tasks', (open) => {
    onToggle(open);
    if (!open) {
      clearInterval(ticking);
      ticking = undefined;
    }
  }, () => render());
  frame.body.append(note, list);

  function render(): void {
    if (!frame.isOpen()) return;
    note.textContent = tasks.length === 0 ? TASKS_NOTE : '';
    note.hidden = tasks.length !== 0;
    const rows = taskOrder(tasks).map((task) => taskRowOf(task, shown, Date.now()));
    reconcile(list, rows.map((row) => ({ key: row.id, deps: [JSON.stringify(row)], build: () => taskItem(row, post, () => frame.close()) })));
    const live = rows.some((row) => row.live);
    if (live && ticking === undefined) ticking = setInterval(render, 1000);
    if (!live && ticking !== undefined) {
      clearInterval(ticking);
      ticking = undefined;
    }
  }

  return {
    element: frame.element,
    isOpen: frame.isOpen,
    open: frame.open,
    close: frame.close,
    listed(next: readonly TaskRecord[], showing: string | undefined): void {
      tasks = next;
      shown = showing;
      render();
    },
  };
}
