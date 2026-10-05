/// <reference lib="dom" />
/// <reference lib="dom.iterable" />
/// <reference lib="dom.asynciterable" />
import type { FromView, ToView } from './messages.js';

declare function acquireVsCodeApi(): { postMessage(message: FromView): void };

const host = acquireVsCodeApi();

document.head.insertAdjacentHTML(
  'beforeend',
  `<style>
  body { display: flex; flex-direction: column; height: 100vh; margin: 0; padding: 0 8px; box-sizing: border-box; font-family: var(--vscode-font-family); font-size: var(--vscode-font-size); }
  #log { flex: 1; overflow-y: auto; padding: 8px 0; }
  .user { margin: 12px 0 4px; padding: 6px 8px; border-radius: 4px; background: var(--vscode-input-background); white-space: pre-wrap; }
  .assistant { white-space: pre-wrap; margin: 4px 0; }
  .tool { font-family: var(--vscode-editor-font-family); font-size: 0.9em; opacity: 0.85; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .tool.failed { color: var(--vscode-errorForeground); }
  .permission { margin: 6px 0; padding: 6px 8px; border: 1px solid var(--vscode-focusBorder); border-radius: 4px; }
  .permission button { margin: 6px 6px 0 0; }
  .error { color: var(--vscode-errorForeground); margin: 4px 0; }
  .stopped { opacity: 0.7; font-style: italic; margin: 4px 0; }
  form { display: flex; gap: 6px; padding: 8px 0; }
  textarea { flex: 1; resize: vertical; min-height: 3em; color: var(--vscode-input-foreground); background: var(--vscode-input-background); border: 1px solid var(--vscode-input-border, transparent); font-family: inherit; }
  button { color: var(--vscode-button-foreground); background: var(--vscode-button-background); border: none; padding: 4px 10px; cursor: pointer; }
  button:disabled { opacity: 0.5; cursor: default; }
</style>`,
);
document.body.innerHTML = `<main id="log"></main>
<form><textarea placeholder="Ask for a change"></textarea><button type="submit">Send</button><button type="button" disabled>Stop</button></form>`;

const log = document.querySelector('#log')!;
const input = document.querySelector('textarea')!;
const [send, stop] = document.querySelectorAll('button');

const STATUS_MARKS: Readonly<Record<string, string>> = { pending: '○', in_progress: '…', completed: '✓', failed: '✗' };

let answer: HTMLElement | undefined;
const tools = new Map<string, { element: HTMLElement; title: string }>();
const permissions = new Map<string, HTMLElement>();

function append(className: string, text: string): HTMLElement {
  const element = document.createElement('div');
  element.className = className;
  element.textContent = text;
  log.append(element);
  log.scrollTop = log.scrollHeight;
  return element;
}

const RENDER: { readonly [K in ToView['type']]: (message: Extract<ToView, { type: K }>) => void } = {
  user({ text }) {
    append('user', text);
    answer = undefined;
  },
  text({ text }) {
    answer ??= append('assistant', '');
    answer.textContent += text;
    log.scrollTop = log.scrollHeight;
  },
  tool({ id, title, status }) {
    answer = undefined;
    const tool = tools.get(id) ?? { element: append('tool', ''), title: title ?? id };
    tool.title = title ?? tool.title;
    tools.set(id, tool);
    tool.element.textContent = `${STATUS_MARKS[status ?? ''] ?? '…'} ${tool.title}`;
    tool.element.classList.toggle('failed', status === 'failed');
  },
  permission({ id, title, options }) {
    const element = append('permission', '');
    element.append(Object.assign(document.createElement('div'), { textContent: title }));
    for (const option of options) {
      const button = document.createElement('button');
      button.textContent = option.name;
      button.addEventListener('click', () => host.postMessage({ type: 'permission', id, optionId: option.optionId }));
      element.append(button);
    }
    permissions.set(id, element);
  },
  'permission-done'({ id }) {
    permissions.get(id)?.querySelectorAll('button').forEach((button) => (button.disabled = true));
  },
  turn({ running, stopReason }) {
    send!.disabled = running;
    stop!.disabled = !running;
    if (!running && stopReason !== undefined && stopReason !== 'end_turn') append('stopped', `stopped: ${stopReason}`);
  },
  error({ message }) {
    append('error', message);
  },
};

window.addEventListener('message', (event: MessageEvent<ToView>) => {
  (RENDER[event.data.type] as (message: ToView) => void)(event.data);
});

document.querySelector('form')!.addEventListener('submit', (event) => {
  event.preventDefault();
  const text = input.value.trim();
  if (text === '' || send!.disabled) return;
  input.value = '';
  host.postMessage({ type: 'send', text });
});
input.addEventListener('keydown', (event) => {
  if (event.key === 'Enter' && !event.shiftKey) {
    event.preventDefault();
    document.querySelector('form')!.requestSubmit();
  }
});
stop!.addEventListener('click', () => host.postMessage({ type: 'stop' }));

host.postMessage({ type: 'ready' });
