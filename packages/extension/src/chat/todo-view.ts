import { todoLine, todoProgress, type TodoItem, type TodoStatus } from '@g-code/core/todo';
import { h, icon } from './dom.js';
import type { Step } from './rail.js';
import type { Ui } from './render.js';

type TodoStep = Extract<Step, { readonly kind: 'todo' }>;

type Mark = { readonly icon: string; readonly label: string };

const MARKS: Readonly<Record<TodoStatus, Mark>> = {
  pending: { icon: 'circle-large-outline', label: 'To do' },
  in_progress: { icon: 'loading codicon-modifier-spin', label: 'In progress' },
  done: { icon: 'pass-filled', label: 'Done' },
};

// A carried list is not this turn's progress, so nothing on it spins.
const CARRIED_MARKS: Readonly<Record<TodoStatus, Mark>> = { ...MARKS, in_progress: { icon: 'circle-large-filled', label: 'Was in progress' } };

/**
 * Live, the list opens by default, since it is the turn's progress; carried or kept, it folds to its one line. Each
 * place keeps its own id in the open list, so a choice made on one never flips another.
 */
export const todoFoldId = (step: TodoStep): string => `todo:${step.place}:${step.turn}`;

export const todoOpen = (step: TodoStep, ui: Ui): boolean => ui.isOpen(todoFoldId(step)) !== (step.place === 'live');

const itemRow =
  (marks: Readonly<Record<TodoStatus, Mark>>) =>
  (item: TodoItem): HTMLElement => {
    const mark = marks[item.status];
    return h(
      'li',
      { class: 'todo-item', 'data-status': item.status, 'data-id': item.id },
      h('span', { class: `codicon codicon-${mark.icon} todo-mark`, role: 'img', 'aria-label': mark.label }),
      h('span', { class: 'todo-text', title: item.text }, item.text),
    );
  };

export function todoStep(step: TodoStep, ui: Ui): HTMLElement {
  const open = todoOpen(step, ui);
  const carried = step.place === 'carried';
  const { done, total } = todoProgress(step.list);
  const line = carried ? `${done} of ${total} done · from an earlier turn` : todoLine(step.list);
  const body = `todo-items-${step.turn}-${step.place}`;
  return h(
    'section',
    { class: 'todo', 'data-place': step.place, 'data-open': String(open), 'aria-label': `Todo list${carried ? ' from an earlier turn' : ''}, ${done} of ${total} done` },
    h(
      'button',
      { type: 'button', class: 'todo-head', 'aria-expanded': String(open), 'aria-controls': body, 'data-focus': todoFoldId(step), title: line, onclick: () => ui.toggle(todoFoldId(step)) },
      icon('checklist', 'todo-icon'),
      h('span', { class: 'todo-line' }, line),
      icon(open ? 'chevron-down' : 'chevron-right', 'chevron'),
    ),
    h('ol', { class: 'todo-items', id: body, ...(open ? {} : { hidden: true }) }, ...step.list.map(itemRow(carried ? CARRIED_MARKS : MARKS))),
  );
}
