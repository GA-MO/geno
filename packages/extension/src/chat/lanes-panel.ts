/// <reference lib="dom" />
import type { Section, TaskRecord } from '@g-code/core';
import { SECTIONS } from '@g-code/core/attention';
import { h, icon, reconcile } from './dom.js';
import { DONE_SHOWN, laneRowOf, SECTION_HEADINGS, taskSections, type Badge, type LaneRow, type LanesFromView, type LanesListing, type SeenMarkers, type TaskRow } from './lanes-model.js';
import type { FromView } from './messages.js';
import type { SteerTarget, SteerResult } from './steer-model.js';
import { taskSteers } from './steer-view.js';

const badge = ({ label, tone }: Badge, extra = ''): HTMLElement =>
  h('span', { class: `mcp-state tone-${tone} ${extra}`.trim() }, tone === 'busy' ? icon('loading', 'codicon-modifier-spin') : undefined, label);

/** A pane that takes the transcript's place while open, with Back and Escape, as the MCP pane does. */
export function pane(label: string, heading: string, onToggle: (open: boolean) => void, shown: () => void) {
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

function taskItem(row: TaskRow, post: (message: LanesFromView) => void, done: () => void, message: () => void): HTMLElement {
  const open = () => (done(), post({ type: 'task-open', sessionId: row.id }));
  return h(
    'li',
    {
      class: `task-row${row.current ? ' current' : ''}${row.fresh ? ' fresh' : ''}`,
      'data-task': row.id,
      // The whole row opens the task; its buttons do their own thing.
      onclick: (event: Event) => void ((event.target as Element).closest('button') === null && open()),
    },
    h(
      'div',
      { class: 'lane-head' },
      h('span', { class: 'lane-name task-title', title: row.title }, row.title),
      h('span', { class: 'spacer' }),
      row.fresh && h('span', { class: 'task-new', title: 'Finished since you last opened it' }, 'New'),
      badge(row.state, 'task-state'),
    ),
    h(
      'p',
      { class: 'lane-meta' },
      row.backend !== undefined && h('span', { class: 'task-backend', title: `Runs on ${row.backend}` }, row.backend),
      h('span', { class: 'task-where' }, row.where),
      row.children !== undefined && h('span', { class: 'task-children' }, row.children),
      h('span', { class: 'task-time' }, row.time),
      row.cost !== undefined && h('span', { class: 'lane-cost' }, row.cost),
      row.forkedFrom !== undefined &&
        h(
          'button',
          { type: 'button', class: 'link-button task-fork', title: `Open ${row.forkedFrom.title}`, onclick: () => (done(), post({ type: 'task-origin', sessionId: row.forkedFrom!.id, workspace: row.forkedFrom!.workspace })) },
          icon('repo-forked'),
          h('span', {}, `Forked from ${row.forkedFrom.title}`),
        ),
    ),
    row.jobs.length > 0 &&
      h(
        'ul',
        { class: 'task-jobs', 'aria-label': 'Background commands' },
        ...row.jobs.map((job) => h('li', { class: 'task-job', 'data-job': job.id, title: job.label }, icon('circle-filled', 'job-icon'), h('span', { class: 'task-job-id' }, job.id), h('span', { class: 'task-job-label' }, job.label))),
      ),
    h(
      'div',
      { class: 'lane-actions' },
      row.current
        ? h('span', { class: 'task-here' }, 'Shown in the chat')
        : h('button', { type: 'button', class: 'button small secondary', 'data-action': 'open', 'data-focus': `task-open:${row.id}`, onclick: open }, 'Open'),
      row.stop && h('button', { type: 'button', class: 'button small ghost', 'data-action': 'stop', title: 'Stop the task', onclick: () => post({ type: 'task-stop', sessionId: row.id }) }, 'Stop'),
      row.stop && !row.current && h('button', { type: 'button', class: 'button small secondary', 'data-action': 'message', title: 'Send it a message that lands at its next tool round', onclick: message }, 'Message'),
    ),
  );
}

const TASKS_NOTE = 'No tasks yet. A chat or lane that runs a turn shows here, and goes on running when the panel closes or the window reloads.';

/** One section of the Tasks pane. Working folds to one line, and Done shows its newest few until asked for more. */
function taskSection(section: Section, toggle: () => void) {
  const list = h('ul', { class: 'lane-list', 'aria-label': SECTION_HEADINGS[section], id: `tasks-${section}` });
  const count = h('span', { class: 'tasks-count' });
  const summary = h('span', { class: 'tasks-summary' });
  const more = h('button', { type: 'button', class: 'link-button tasks-more', onclick: toggle });
  const heading =
    section === 'working'
      ? h(
          'h3',
          { class: 'tasks-heading' },
          h('button', { type: 'button', class: 'tasks-fold', 'aria-expanded': 'false', 'aria-controls': list.id, onclick: toggle }, icon('chevron-right', 'tasks-chevron'), h('span', {}, SECTION_HEADINGS[section]), count, summary),
        )
      : h('h3', { class: 'tasks-heading' }, h('span', {}, SECTION_HEADINGS[section]), count);
  const element = h('section', { class: 'tasks-section', 'data-section': section, hidden: true }, heading, list, section === 'done' && more);
  return { element, list, count, summary, more };
}

/** The Tasks pane: each top-level task, with its subagents or lanes rolled in, in Needs you, Ready, Working or Done. */
export function tasksPanel(post: (message: FromView) => void, onToggle: (open: boolean) => void) {
  let tasks: readonly TaskRecord[] = [];
  let shown: string | undefined;
  let seen: SeenMarkers = {};
  let ticking: ReturnType<typeof setInterval> | undefined;
  let workingOpen = false;
  let doneAll = false;
  const note = h('p', { class: 'history-note lanes-note', role: 'status' });
  const sections = Object.fromEntries(
    SECTIONS.map((section) => [
      section,
      taskSection(section, () => {
        if (section === 'working') workingOpen = !workingOpen;
        else doneAll = !doneAll;
        render();
      }),
    ]),
  ) as Record<Section, ReturnType<typeof taskSection>>;
  const frame = pane('Tasks', 'Tasks', (open) => {
    onToggle(open);
    if (!open) {
      clearInterval(ticking);
      ticking = undefined;
    }
  }, () => render());
  frame.body.append(note, h('div', { class: 'tasks' }, ...SECTIONS.map((section) => sections[section].element)));
  const steers = taskSteers(post, () => render());

  function render(): void {
    if (!frame.isOpen()) return;
    note.textContent = tasks.length === 0 ? TASKS_NOTE : '';
    note.hidden = tasks.length !== 0;
    const listed = new Map(taskSections(tasks, seen, shown, Date.now()).map((s) => [s.section, s.rows]));
    for (const section of SECTIONS) {
      const rows = listed.get(section) ?? [];
      const { element, list, count, summary, more } = sections[section];
      element.hidden = rows.length === 0;
      count.textContent = String(rows.length);
      // A task's message field follows its row, so Done's fold counts rows, not the items they make.
      const entries = rows.flatMap((row, at) =>
        [
          { key: row.id, deps: [JSON.stringify(row)], build: () => taskItem(row, post, () => frame.close(), () => steers.open(row.id, row.title)) },
          ...steers.items(row.id, row.stop && !row.current),
        ].map((entry) => ({ entry, at })),
      );
      const items = reconcile(list, entries.map(({ entry }) => entry));
      if (section === 'working') {
        summary.textContent = rows.map((row) => row.title).join(', ');
        list.hidden = !workingOpen;
        element.querySelector('.tasks-fold')!.setAttribute('aria-expanded', String(workingOpen));
      }
      if (section === 'done') {
        items.forEach((item, i) => (item.hidden = !doneAll && entries[i]!.at >= DONE_SHOWN));
        more.hidden = rows.length <= DONE_SHOWN;
        more.textContent = doneAll ? 'Show fewer' : `Show ${rows.length - DONE_SHOWN} more`;
      }
    }
    const live = [...listed.values()].some((rows) => rows.some((row) => row.live));
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
    /** Opens the pane scrolled to a section, or its top while that section is empty. */
    openAt(section: Section): void {
      frame.open();
      const target = sections[section].element;
      if (target.hidden) frame.element.scrollTop = 0;
      else target.scrollIntoView({ block: 'start' });
    },
    listed(next: readonly TaskRecord[], showing: string | undefined, markers: SeenMarkers): void {
      tasks = next;
      shown = showing;
      seen = markers;
      render();
    },
    steered: (target: SteerTarget, result: SteerResult) => steers.steered(target, result),
  };
}
