/// <reference lib="dom" />
import type { ScheduleView } from '@g-code/core';
import { localZone } from '@g-code/core/cron';
import { h, icon, reconcile } from './dom.js';
import type { LanesFromView } from './lanes-model.js';
import { SCHEDULE_HINT, scheduleRowOf, type ScheduleRow } from './schedule-model.js';

function scheduleItem(row: ScheduleRow, post: (message: LanesFromView) => void, confirming: boolean, confirm: (id: string | undefined) => void, done: () => void): HTMLElement {
  const { id } = row;
  const act = (action: 'run' | 'pause' | 'resume' | 'delete') => post({ type: 'schedule-act', id, action });
  const { last } = row;
  return h(
    'li',
    { class: 'lane-row schedule-row', 'data-schedule': id },
    h('div', { class: 'lane-head' }, icon('calendar', 'kind'), h('span', { class: 'lane-name schedule-title', title: row.title }, row.title), h('span', { class: 'spacer' }), h('span', { class: `mcp-state tone-${row.state.tone} schedule-state` }, row.state.tone === 'busy' ? icon('loading', 'codicon-modifier-spin') : undefined, row.state.label)),
    h('p', { class: 'lane-meta' }, h('span', { class: 'schedule-when' }, row.when), h('span', { class: 'schedule-next' }, row.next)),
    h('p', { class: 'lane-meta schedule-how' }, row.how),
    last !== undefined &&
      h(
        'p',
        { class: `schedule-last tone-${last.tone}` },
        h('span', { class: 'schedule-last-text' }, last.text),
        last.open !== undefined &&
          h('button', { type: 'button', class: 'link-button schedule-open', title: 'Show the run’s session', onclick: () => (done(), post({ type: 'task-origin', sessionId: last.open!.sessionId, workspace: last.open!.workspace })) }, 'Open'),
      ),
    confirming
      ? h(
          'div',
          { class: 'lane-confirm', role: 'group', 'aria-label': `Delete ${row.title}` },
          h('p', { class: 'lane-confirm-text' }, `Delete the scheduled task "${row.title}"? It stops running; its past runs stay in History.`),
          h(
            'div',
            { class: 'lane-actions' },
            h('button', { type: 'button', class: 'button small danger', 'data-focus': `schedule-delete-yes:${id}`, onclick: () => (confirm(undefined), act('delete')) }, 'Delete'),
            h('button', { type: 'button', class: 'button small secondary', 'data-focus': `schedule-delete-no:${id}`, onclick: () => confirm(undefined) }, 'Cancel'),
          ),
        )
      : h(
          'div',
          { class: 'lane-actions' },
          h('button', { type: 'button', class: 'button small secondary', 'data-action': 'run', disabled: row.running, title: 'Run it once now; the schedule stays as it is', onclick: () => act('run') }, 'Run now'),
          h(
            'button',
            { type: 'button', class: 'button small secondary', 'data-action': row.paused ? 'resume' : 'pause', title: row.paused ? 'Run it on its schedule again' : 'Stop it running until you resume it', onclick: () => act(row.paused ? 'resume' : 'pause') },
            row.paused ? 'Resume' : 'Pause',
          ),
          h('button', { type: 'button', class: 'button small ghost', 'data-action': 'delete', 'data-focus': `schedule-delete:${id}`, title: 'Delete the scheduled task', onclick: () => confirm(id) }, 'Delete'),
        ),
  );
}

/** The Tasks pane's Scheduled section: each scheduled task with its next run and last run, and Run now, Pause and Delete. */
export function scheduleSection(post: (message: LanesFromView) => void, done: () => void) {
  let tasks: readonly ScheduleView[] = [];
  let confirming: string | undefined;
  const list = h('ul', { class: 'lane-list schedule-list', 'aria-label': 'Scheduled' });
  const count = h('span', { class: 'tasks-count' });
  const element = h('section', { class: 'tasks-section', 'data-section': 'scheduled', hidden: true }, h('h3', { class: 'tasks-heading' }, h('span', {}, 'Scheduled'), count), list, h('p', { class: 'schedule-hint' }, SCHEDULE_HINT));

  function render(): void {
    element.hidden = tasks.length === 0;
    count.textContent = String(tasks.length);
    if (confirming !== undefined && !tasks.some((task) => task.id === confirming)) confirming = undefined;
    const now = Date.now();
    const zone = localZone();
    reconcile(
      list,
      tasks.map((task) => {
        const row = scheduleRowOf(task, zone, now);
        return {
          key: row.id,
          deps: [JSON.stringify(row), confirming === row.id],
          build: () =>
            scheduleItem(
              row,
              post,
              confirming === row.id,
              (id) => {
                confirming = id;
                render();
                list.querySelector<HTMLElement>(`[data-focus="${CSS.escape(id === undefined ? `schedule-delete:${row.id}` : `schedule-delete-no:${row.id}`)}"]`)?.focus();
              },
              done,
            ),
        };
      }),
    );
  }

  return {
    element,
    render,
    listed(next: readonly ScheduleView[]): void {
      tasks = next;
      render();
    },
    isEmpty: () => tasks.length === 0,
  };
}
