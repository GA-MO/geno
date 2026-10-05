/// <reference lib="dom" />
/// <reference lib="dom.iterable" />
/// <reference lib="dom.asynciterable" />
import { h, icon, reconcile, type Keyed } from './dom.js';
import { insertMention, mentionAtCaret, type MentionCompletion } from './mentions.js';
import type { Block, FromView, ToView, Transcript, Turn } from './messages.js';
import { emptyState, errorBlock, permissionCard, textBlock, toolRow, turnFooter, userMessage, type Ui } from './render.js';
import { emptyTranscript, isRunning, reduce } from './transcript.js';

/** What only this view knows, kept across the panel being hidden: the draft and which folds are open. */
type ViewState = { readonly draft: string; readonly open: readonly string[]; readonly unfolded: readonly string[] };

declare function acquireVsCodeApi(): { postMessage(message: FromView): void; getState(): ViewState | undefined; setState(state: ViewState): void };

const host = acquireVsCodeApi();
let state: ViewState = { draft: '', open: [], unfolded: [], ...host.getState() };
let transcript: Transcript = emptyTranscript('');

/** Composer height stops growing here and scrolls instead. */
const MAX_COMPOSER_PX = 240;

function save(next: ViewState): void {
  state = next;
  host.setState(state);
}

const toggled = (list: readonly string[], id: string): string[] => (list.includes(id) ? list.filter((x) => x !== id) : [...list, id]);

const ui: Ui = {
  post: (message) => host.postMessage(message),
  isOpen: (id) => state.open.includes(id),
  toggle: (id) => {
    save({ ...state, open: toggled(state.open, id) });
    schedule();
  },
  isUnfolded: (id) => state.unfolded.includes(id),
  unfold: (id) => {
    save({ ...state, unfolded: [...state.unfolded, id] });
    schedule();
  },
};

const log = h('div', { class: 'transcript', role: 'log', 'aria-label': 'g-code chat', 'aria-live': 'polite', tabindex: '-1' });
const status = h('div', { class: 'sr-only', role: 'status', 'aria-live': 'polite' });
const input = h('textarea', {
  rows: 1,
  placeholder: 'Ask for a change, @ to add context',
  'aria-label': 'Ask g-code for a change',
  'data-focus': 'composer',
  'aria-autocomplete': 'list',
  'aria-controls': 'mentions',
});
const send = h('button', { type: 'submit', class: 'icon-button send', title: 'Send (Enter)', 'aria-label': 'Send' }, icon('send'));
const stop = h('button', { type: 'button', class: 'icon-button stop', title: 'Stop (Escape)', 'aria-label': 'Stop' }, icon('stop-circle'));
const modelLabel = h('span', { class: 'composer-model' });
const menu = h('ul', { class: 'mentions', id: 'mentions', role: 'listbox', 'aria-label': 'Context to add', hidden: true });
const form = h(
  'form',
  { class: 'composer' },
  menu,
  h('div', { class: 'input-box' }, input, h('div', { class: 'input-toolbar' }, modelLabel, h('span', { class: 'spacer' }), stop, send)),
);
document.body.append(log, form, status);

/**
 * Streamed text appears a little at a time, each frame showing a sixth of what has arrived but is not yet
 * shown, so it keeps up within about a quarter second instead of landing in the bursts the network delivers.
 */
const revealed = new Map<string, number>();
let frame: number | undefined;

function shownLength(id: string, text: string, streaming: boolean): number {
  if (!streaming) return text.length;
  const shown = revealed.get(id) ?? 0;
  if (shown >= text.length) return text.length;
  const next = Math.min(text.length, shown + Math.max(2, Math.ceil((text.length - shown) / 6)));
  revealed.set(id, next);
  return next;
}

function blockItem(turn: Turn, block: Block, last: boolean): Keyed {
  if (block.kind === 'text') {
    const streaming = turn.status === 'streaming';
    const shown = shownLength(block.id, block.text, streaming);
    const caret = streaming && last;
    return { key: block.id, deps: [block.text, shown, caret], build: () => textBlock(block.text.slice(0, shown), caret, ui) };
  }
  if (block.kind === 'tool') return { key: block.id, deps: [block, ...state.open, '|', ...state.unfolded], build: () => toolRow(block, ui) };
  if (block.kind === 'permission') return { key: `permission:${block.id}`, deps: [block], build: () => permissionCard(block, ui) };
  return { key: block.id, deps: [block], build: () => errorBlock(block) };
}

function turnShell(turn: Turn): HTMLElement {
  return h('article', { class: 'turn', 'data-turn': turn.id }, userMessage(turn.prompt), h('div', { class: 'response' }), h('div', { class: 'footer-slot' }));
}

const pendingText = (turn: Turn): boolean =>
  turn.blocks.some((b) => b.kind === 'text' && (revealed.get(b.id) ?? b.text.length) < b.text.length);

function render(): void {
  frame = undefined;
  const atBottom = log.scrollHeight - log.scrollTop - log.clientHeight < 24;
  const focused = (document.activeElement as HTMLElement | null)?.dataset['focus'];

  const empty = transcript.turns.length === 0;
  const shells = reconcile(
    log,
    empty
      ? [{ key: 'empty', deps: [transcript.model], build: () => emptyState(transcript.model, fill) }]
      : transcript.turns.map((turn) => ({ key: turn.id, deps: [turn.id], build: () => turnShell(turn) })),
  );
  let animating = false;
  if (!empty) {
    transcript.turns.forEach((turn, i) => {
      const shell = shells[i]!;
      shell.setAttribute('aria-busy', String(turn.status === 'streaming'));
      reconcile(shell.querySelector<HTMLElement>(':scope > .response')!, turn.blocks.map((block, j) => blockItem(turn, block, j === turn.blocks.length - 1)));
      reconcile(shell.querySelector<HTMLElement>(':scope > .footer-slot')!, turn.status === 'streaming' ? [] : [{ key: 'footer', deps: [turn.usage, turn.status], build: () => turnFooter(turn) }]);
      animating ||= turn.status === 'streaming' && pendingText(turn);
    });
  }

  const running = isRunning(transcript);
  send.hidden = running;
  stop.hidden = !running;
  modelLabel.textContent = transcript.model;
  if (focused !== undefined && !document.activeElement?.isConnected) document.querySelector<HTMLElement>(`[data-focus="${CSS.escape(focused)}"]`)?.focus();
  focusNewPermission();
  if (atBottom) log.scrollTop = log.scrollHeight;
  if (animating) schedule();
}

function schedule(): void {
  frame ??= requestAnimationFrame(render);
}

/** A question from the engine takes the keyboard once, on its default button. */
const asked = new Set<string>();
function focusNewPermission(): void {
  for (const card of document.querySelectorAll<HTMLElement>('.permission-open[data-permission]')) {
    const id = card.dataset['permission']!;
    if (asked.has(id)) continue;
    asked.add(id);
    card.querySelector('button')?.focus();
  }
}

const ENDED = { done: 'g-code finished', stopped: 'Stopped', failed: 'The turn failed' } as const;

/** What a screen reader hears besides the transcript itself. */
const ANNOUNCEMENTS: { readonly [K in ToView['type']]?: (message: Extract<ToView, { type: K }>) => string } = {
  'turn-start': () => 'g-code is working',
  permission: ({ command }) => `g-code asks to run ${command}`,
  'turn-end': ({ status }) => ENDED[status],
};
const announcement = (message: ToView): string | undefined => (ANNOUNCEMENTS[message.type] as ((m: ToView) => string) | undefined)?.(message);

window.addEventListener('message', (event: MessageEvent<ToView>) => {
  const message = event.data;
  if (message.type === 'completions') {
    showCompletions(message.id, message.items);
    return;
  }
  transcript = reduce(transcript, message);
  // A reset rebuilds a view that missed the stream, so its text shows in full rather than replaying.
  if (message.type === 'reset') for (const turn of transcript.turns) for (const b of turn.blocks) if (b.kind === 'text') revealed.set(b.id, b.text.length);
  const said = announcement(message);
  if (said !== undefined) status.textContent = said;
  schedule();
});

function resize(): void {
  input.style.height = 'auto';
  input.style.height = `${Math.min(input.scrollHeight, MAX_COMPOSER_PX)}px`;
  input.style.overflowY = input.scrollHeight > MAX_COMPOSER_PX ? 'auto' : 'hidden';
}

function fill(text: string): void {
  input.value = text;
  save({ ...state, draft: text });
  resize();
  input.focus();
  input.setSelectionRange(text.length, text.length);
}

/**
 * The `@` completion list. Each keystroke in a mention asks the extension again; only the answer to the newest
 * question is shown, so a slow answer never replaces a newer one.
 */
let lastQuestion = 0;
let pending: { readonly id: number; readonly start: number } | undefined;
let completing: { readonly start: number; readonly items: readonly MentionCompletion[]; readonly active: number } | undefined;

function askCompletions(): void {
  const at = mentionAtCaret(input.value, input.selectionStart);
  if (at === undefined || input.selectionStart !== input.selectionEnd) {
    closeMenu();
    return;
  }
  pending = { id: ++lastQuestion, start: at.start };
  host.postMessage({ type: 'complete', id: pending.id, query: at.query });
}

function showCompletions(id: number, items: readonly MentionCompletion[]): void {
  if (pending?.id !== id) return;
  completing = { start: pending.start, items, active: 0 };
  renderMenu();
}

function closeMenu(): void {
  pending = undefined;
  completing = undefined;
  renderMenu();
}

function accept(index: number): void {
  const item = completing?.items[index];
  if (completing === undefined || item === undefined) return;
  const next = insertMention(input.value, completing.start, input.selectionStart, item.label);
  closeMenu();
  input.value = next.text;
  input.setSelectionRange(next.caret, next.caret);
  save({ ...state, draft: input.value });
  resize();
}

const moveActive = (by: number) => () => {
  if (completing === undefined) return;
  const count = completing.items.length;
  completing = { ...completing, active: (completing.active + by + count) % count };
  renderMenu();
};

const MENU_KEYS: Readonly<Record<string, () => void>> = {
  ArrowDown: moveActive(1),
  ArrowUp: moveActive(-1),
  Enter: () => accept(completing?.active ?? 0),
  Tab: () => accept(completing?.active ?? 0),
  Escape: closeMenu,
};

function renderMenu(): void {
  const items = completing?.items ?? [];
  menu.hidden = items.length === 0;
  menu.replaceChildren(
    ...items.map((item, i) =>
      h(
        'li',
        {
          id: `mention-${i}`,
          class: i === completing!.active ? 'mention active' : 'mention',
          role: 'option',
          'aria-selected': String(i === completing!.active),
          'data-mention': item.label,
          // Keeps the focus in the composer, so the click does not close the list before it lands.
          onmousedown: (event) => event.preventDefault(),
          onclick: () => accept(i),
        },
        icon(item.kind === 'selection' ? 'selection' : 'file'),
        h('span', { class: 'mention-label' }, item.kind === 'selection' ? item.label : item.label.slice(item.label.lastIndexOf('/') + 1)),
        h('span', { class: 'mention-detail' }, item.detail),
      ),
    ),
  );
  if (items.length === 0) input.removeAttribute('aria-activedescendant');
  else {
    input.setAttribute('aria-activedescendant', `mention-${completing!.active}`);
    menu.querySelector('.active')?.scrollIntoView({ block: 'nearest' });
  }
  input.setAttribute('aria-expanded', String(items.length > 0));
}

function submit(): void {
  const text = input.value.trim();
  if (text === '' || isRunning(transcript)) return;
  host.postMessage({ type: 'send', text });
  fill('');
}

form.addEventListener('submit', (event) => {
  event.preventDefault();
  submit();
});
input.addEventListener('input', () => {
  save({ ...state, draft: input.value });
  resize();
  askCompletions();
});
input.addEventListener('click', askCompletions);
input.addEventListener('blur', closeMenu);
input.addEventListener('keydown', (event) => {
  if (completing !== undefined && completing.items.length > 0 && !event.isComposing) {
    const move = MENU_KEYS[event.key];
    if (move !== undefined) {
      event.preventDefault();
      event.stopPropagation();
      move();
      return;
    }
  }
  if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) {
    event.preventDefault();
    submit();
  }
});
stop.addEventListener('click', () => host.postMessage({ type: 'stop' }));
document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape' && isRunning(transcript)) {
    event.preventDefault();
    host.postMessage({ type: 'stop' });
  }
});
// The view's focus command focuses the webview itself; the composer is what the user means to type into.
// A webview created by that command can receive the focus before this script runs, hence the check at start.
const focusComposer = () => {
  if (document.activeElement === document.body || document.activeElement === null) input.focus();
};
window.addEventListener('focus', () => requestAnimationFrame(focusComposer));

input.value = state.draft;
resize();
render();
if (document.hasFocus()) focusComposer();
host.postMessage({ type: 'ready' });
