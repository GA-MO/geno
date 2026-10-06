import { todoLine, todoProgress, type TodoItem, type TodoStatus } from '@g-code/core/todo';
import { h, icon } from './dom.js';
import type { Step } from './rail.js';
import type { Ui } from './render.js';

type TodoStep = Extract<Step, { readonly kind: 'todo' }>;

const MARKS: Readonly<Record<TodoStatus, { readonly icon: string; readonly label: string }>> = {
  pending: { icon: 'circle-large-outline', label: 'To do' },
  in_progress: { icon: 'loading codicon-modifier-spin', label: 'In progress' },
  done: { icon: 'pass-filled', label: 'Done' },
};

/**
 * Pinned, the list opens by default, since it is the turn's progress; once the turn ends it folds to its one line.
 * Each keeps its own id in the open list, so a choice made on one never flips the other.
 */
export const todoFoldId = (step: TodoStep): string => `todo:${step.pinned ? 'pinned' : 'kept'}:${step.turn}`;

export const todoOpen = (step: TodoStep, ui: Ui): boolean => ui.isOpen(todoFoldId(step)) !== step.pinned;

const itemRow = (item: TodoItem): HTMLElement => {
  const mark = MARKS[item.status];
  return h(
    'li',
    { class: 'todo-item', 'data-status': item.status, 'data-id': item.id },
    h('span', { class: `codicon codicon-${mark.icon} todo-mark`, role: 'img', 'aria-label': mark.label }),
    h('span', { class: 'todo-text', title: item.text }, item.text),
  );
};

export function todoStep(step: TodoStep, ui: Ui): HTMLElement {
  const open = todoOpen(step, ui);
  const { done, total } = todoProgress(step.list);
  const line = todoLine(step.list);
  const body = `todo-items-${step.turn}-${step.pinned ? 'pinned' : 'kept'}`;
  return h(
    'section',
    { class: 'todo', 'data-pinned': String(step.pinned), 'data-open': String(open), 'aria-label': `Todo list, ${done} of ${total} done` },
    h(
      'button',
      { type: 'button', class: 'todo-head', 'aria-expanded': String(open), 'aria-controls': body, 'data-focus': todoFoldId(step), title: line, onclick: () => ui.toggle(todoFoldId(step)) },
      icon('checklist', 'todo-icon'),
      h('span', { class: 'todo-line' }, line),
      icon(open ? 'chevron-down' : 'chevron-right', 'chevron'),
    ),
    h('ol', { class: 'todo-items', id: body, ...(open ? {} : { hidden: true }) }, ...step.list.map(itemRow)),
  );
}
