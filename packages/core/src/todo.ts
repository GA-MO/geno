import type { Tool } from '@anthropic-ai/sdk/resources/messages/messages';
import type { Parsed } from './ask-user.js';
import type { ToolResultEvent, TurnEvent } from './session.js';

/**
 * `todo`: the checklist the model keeps for a task, which the panel pins above the running turn. Each call sets the
 * whole list, and the call's result in the session log carries it, so a replay, a reload, a cut and a fork each
 * show the list as it stood. The webview bundles this file, so it imports only types.
 */
export const TODO_TOOL = 'todo';

export const TODO_STATUSES = ['pending', 'in_progress', 'done'] as const;
export type TodoStatus = (typeof TODO_STATUSES)[number];

export type TodoItem = { readonly id: string; readonly text: string; readonly status: TodoStatus };
export type TodoList = readonly TodoItem[];

export const TODO_LIMITS = { items: 30, text: 200, id: 40 } as const;

/** Key in a tool_call_update's `_meta`: the list a todo call set, as `{ items }`. */
export const TODO_META = 'gcode/todo';

/** A todo call's logged result: the event every reader of the list folds over. */
export type TodoEvent = ToolResultEvent & { readonly todo: TodoList };

export const isTodoEvent = (event: TurnEvent): event is TodoEvent => event.kind === 'tool-result' && event.todo !== undefined;

export const TODO_SPEC: Tool = {
  name: TODO_TOOL,
  description: `Keep a checklist of the task's steps, which the user sees pinned in the chat as you work. Each call replaces the whole list, so pass every item each time, with the same id for the same step. Use it proactively, as your first call, when the work takes three or more steps or the user lists several things to do, such as "rename it everywhere, make sure the tests pass, and add a changelog line"; skip it for a quick single change. Mark an item in_progress when you start it and done as soon as it is finished, before you start the next; at most one item is in_progress. At most ${TODO_LIMITS.items} items. An empty list clears it.`,
  input_schema: {
    type: 'object',
    properties: {
      items: {
        type: 'array',
        maxItems: TODO_LIMITS.items,
        items: {
          type: 'object',
          properties: {
            id: { type: 'string', description: 'A short id that stays the same for this step, such as "1" or "tests".' },
            text: { type: 'string', description: 'The step in a few words, such as "Write the parser tests".' },
            status: { type: 'string', enum: [...TODO_STATUSES] },
          },
          required: ['id', 'text', 'status'],
          additionalProperties: false,
        },
      },
    },
    required: ['items'],
    additionalProperties: false,
  },
};

const fail = (problem: string): Parsed<never> => ({ ok: false, problem });
const isRecord = (raw: unknown): raw is Record<string, unknown> => typeof raw === 'object' && raw !== null && !Array.isArray(raw);
const isStatus = (raw: unknown): raw is TodoStatus => (TODO_STATUSES as readonly unknown[]).includes(raw);

/** The model's input as a list, or what is wrong with it, in words the model can act on. */
export function parseTodo(raw: unknown): Parsed<TodoList> {
  if (!isRecord(raw) || !Array.isArray(raw['items'])) return fail('todo takes an object with an items array');
  const extra = Object.keys(raw).find((key) => key !== 'items');
  if (extra !== undefined) return fail(`todo has an unknown field "${extra}"`);
  const items: unknown[] = raw['items'];
  if (items.length > TODO_LIMITS.items) return fail(`the list has ${items.length} items; keep it to at most ${TODO_LIMITS.items} by merging small steps`);
  const list: TodoItem[] = [];
  for (const [i, item] of items.entries()) {
    const at = `item ${i + 1}`;
    if (!isRecord(item)) return fail(`${at} must be an object with id, text and status`);
    const { id, text, status } = item;
    if (typeof id !== 'string' || id.trim() === '') return fail(`${at} needs an id`);
    if (id.trim().length > TODO_LIMITS.id) return fail(`${at}'s id is longer than ${TODO_LIMITS.id} characters`);
    if (typeof text !== 'string' || text.trim() === '') return fail(`${at} needs its text`);
    if (text.trim().length > TODO_LIMITS.text) return fail(`${at}'s text is longer than ${TODO_LIMITS.text} characters`);
    if (!isStatus(status)) return fail(`${at}'s status must be pending, in_progress or done`);
    if (list.some((kept) => kept.id === id.trim())) return fail(`the id "${id.trim()}" is used twice`);
    list.push({ id: id.trim(), text: text.trim(), status });
  }
  const working = list.filter((item) => item.status === 'in_progress');
  if (working.length > 1) return fail(`${working.length} items are in_progress (${working.map((item) => item.id).join(', ')}); keep exactly one in_progress at a time`);
  return { ok: true, value: list };
}

/** The list after one more event: a todo call's result sets it whole, and every other event leaves it. */
export const reduceTodo = (list: TodoList, event: TurnEvent): TodoList => (isTodoEvent(event) ? event.todo : list);

/** The list as the events leave it. Pass a session as its cut view shows it, so a cut turn's calls are gone. */
export const todoOf = (events: readonly TurnEvent[]): TodoList => events.reduce(reduceTodo, []);

export type TodoProgress = { readonly done: number; readonly total: number; readonly current: TodoItem | undefined };

export const todoProgress = (list: TodoList): TodoProgress => ({
  done: list.filter((item) => item.status === 'done').length,
  total: list.length,
  current: list.find((item) => item.status === 'in_progress'),
});

/** "Write tests" reads as "write tests" after a dot; "README" keeps its capitals. */
const lowerFirst = (text: string): string => (/^\p{Lu}\p{Ll}/u.test(text) ? `${text.charAt(0).toLowerCase()}${text.slice(1)}` : text);

/** The list in one line, as its folded row shows it: "3 of 7 done · write tests". */
export function todoLine(list: TodoList): string {
  const { done, total, current } = todoProgress(list);
  return current === undefined ? `${done} of ${total} done` : `${done} of ${total} done · ${lowerFirst(current.text)}`;
}

export function todoResult(list: TodoList): string {
  if (list.length === 0) return 'Cleared the todo list.';
  const { done, total, current } = todoProgress(list);
  return `Updated the todo list: ${done} of ${total} done${current === undefined ? '' : `, "${current.text}" in progress`}.`;
}
