import type { TodoList, TodoStatus } from '@g-code/core/todo';

/** The todo fixture's workspace, prompts and lists, shared by the suite inside VS Code and the test that launches it. */
export const FILES = { 'a.ts': 'export const alpha = 1;\n' } as const;

/** The chat's first message carries it, so the fake model knows the call is the chat's own. */
export const MARKER = '[todo]';

export const PROMPT = `${MARKER} Plan how to add a beta export with tests`;

/** Files whose appearance in the workspace ends a waiting bash call of the building turn. */
export const RELEASES = { write: 'release-write' } as const;

export const waitFor = (file: string): string => `until [ -f ${file} ]; do sleep 0.2; done`;

const TEXTS = ['Read a.ts', 'Write the tests for beta', 'Add the beta export and run the tests'] as const;
const list = (...statuses: TodoStatus[]): TodoList => statuses.map((status, i) => ({ id: String(i + 1), text: TEXTS[i]!, status }));

export const LISTS = {
  planned: list('pending', 'pending', 'pending'),
  reading: list('in_progress', 'pending', 'pending'),
  writing: list('done', 'in_progress', 'pending'),
  finished: list('done', 'done', 'done'),
} as const;

export const ANSWERS = { plan: 'The plan is in the todo list.', built: 'All three steps are done.' } as const;

export const THEMES = { dark: 'Default Dark Modern', light: 'Default Light Modern', 'high-contrast': 'Default High Contrast' } as const;
