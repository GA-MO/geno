import type * as acp from '@agentclientprotocol/sdk';
import { parseTodo, TODO_META, type TodoList } from '@g-code/core/todo';

/** The list a todo call's result carries, checked by core's rules, since it crossed the process boundary. */
export function todoOfUpdate(update: acp.SessionUpdate): TodoList | undefined {
  if (update.sessionUpdate !== 'tool_call_update' || update._meta?.[TODO_META] === undefined) return undefined;
  const parsed = parseTodo(update._meta[TODO_META]);
  return parsed.ok ? parsed.value : undefined;
}
