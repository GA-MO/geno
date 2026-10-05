/// <reference lib="dom" />
/// <reference lib="dom.iterable" />
/// <reference lib="dom.asynciterable" />
import type { OutgoingAttachment } from './attachment-model.js';
import { composerAttachments } from './composer-attachments.js';
import { composerView, NO_FACTS, type ComposerFacts } from './composer-model.js';
import { composerControls } from './composer-view.js';
import type { McpListing } from './mcp-model.js';
import { h, icon, reconcile, type Keyed } from './dom.js';
import { setRoots } from './images.js';
import { ATTACH_ROW, formatMention, insertMention, mentionAtCaret, mentionsIn, SELECTION, withoutMention, type MentionCompletion } from './mentions.js';
import { shownSteps } from './fold.js';
import type { ChatDetail, FromView, Header, Modes, ToView, Transcript, Turn } from './messages.js';
import { memoryPanel, rulesPanel } from './context-panes.js';
import { historyPanel } from './history.js';
import { mcpPanel } from './mcp-panel.js';
import { settingsPanel } from './settings-panel.js';
import { modePicker } from './modes.js';
import { isWaiting, nodeOf, type Step } from './rail.js';
import { callsStep, changesCard, errorBlock, filesRow, foldId, foldRow, permissionCard, startBuilding, textBlock, thinkingRow, turnFooter, turnHead, turnNotice, userMessage, type Ui } from './render.js';
import { motionGate } from './motion.js';
import { peek as peekOver } from './peek.js';
import type { PeekInput } from './peek-model.js';
import { slashPicker } from './slash-view.js';
import { startPage } from './start-page.js';
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

/**
 * The control the user just opened or closed something with, and where it stood in the transcript. The next render
 * puts it back there, so what opens or closes below it never moves what the user is reading.
 */
let anchor: { readonly focus: string; readonly top: number } | undefined;

function holdPlace(): void {
  const control = document.activeElement as HTMLElement | null;
  const focus = control?.dataset['focus'];
  anchor = focus === undefined || !log.contains(control) ? undefined : { focus, top: control!.getBoundingClientRect().top };
}

function keepPlace(): boolean {
  if (anchor === undefined) return false;
  const control = log.querySelector<HTMLElement>(`[data-focus="${CSS.escape(anchor.focus)}"]`);
  if (control !== null) log.scrollTop += control.getBoundingClientRect().top - anchor.top;
  anchor = undefined;
  return control !== null;
}

const detail = (): ChatDetail => (document.body.dataset['detail'] === 'full' ? 'full' : 'compact');

const ui: Ui = {
  post: (message) => host.postMessage(message),
  isOpen: (id) => state.open.includes(id),
  toggle: (id) => {
    holdPlace();
    save({ ...state, open: toggled(state.open, id) });
    schedule();
  },
  isUnfolded: (id) => state.unfolded.includes(id),
  unfold: (id) => {
    save({ ...state, unfolded: [...state.unfolded, id] });
    schedule();
  },
};

const log = h('div', { class: 'transcript', role: 'log', 'aria-label': 'Geno chat', 'aria-live': 'polite', tabindex: '-1' });
const status = h('div', { class: 'sr-only', role: 'status', 'aria-live': 'polite' });
const input = h('textarea', {
  rows: 1,
  placeholder: 'Ask for a change, @ to add context, / for commands',
  'aria-label': 'Ask Geno for a change',
  'data-focus': 'composer',
  'aria-autocomplete': 'list',
  'aria-controls': 'mentions',
});
const send = h('button', { type: 'submit', class: 'round-button send', title: 'Send (Enter)', 'aria-label': 'Send' }, icon('arrow-up'));
const stop = h('button', { type: 'button', class: 'round-button stop', title: 'Stop (Escape)', 'aria-label': 'Stop' }, icon('debug-stop'));
/** What the extension host knows for the composer, the shown session's MCP servers, and a follow-up waiting on the turn. */
let facts: ComposerFacts = NO_FACTS;
let mcpListing: McpListing = { kind: 'loading' };
type Queued = { readonly text: string; readonly attachments: readonly OutgoingAttachment[] };
let queued: Queued | undefined;
const controls = composerControls((message) => host.postMessage(message), {
  addContext: () => addContext(),
  openCommands: () => openCommands(),
  unqueue: () => {
    queued = undefined;
    schedule();
  },
});
let mode = '';
const picker = modePicker((modeId) => host.postMessage({ type: 'set-mode', modeId }), (modes: Modes) => {
  // Auto marks the whole composer, so it shows wherever the user looks to type.
  inputBox.dataset['mode'] = modes.current;
  mode = modes.current;
  schedule();
});
const chips = h('div', { class: 'context-chips', role: 'list', 'aria-label': 'Context for the next message' });
const menu = h('ul', { class: 'mentions', id: 'mentions', role: 'listbox', 'aria-label': 'Context to add', hidden: true });
/** Attachments and connections above the text, in one row that scrolls sideways. */
const tray = h('div', { class: 'tray', hidden: true }, ...controls.tray, chips);
// The composer always wears the running rainbow edge; the ring is its own element so the edge can turn on the compositor.
const inputBox = h(
  'div',
  { class: 'input-box rainbow' },
  h('span', { class: 'ring', 'aria-hidden': 'true' }),
  tray,
  input,
  h(
    'div',
    { class: 'input-toolbar' },
    h('span', { class: 'toolbar-left' }, ...controls.left, picker.element),
    h('span', { class: 'toolbar-right' }, ...controls.right, stop, send),
  ),
);
const slash = slashPicker(input, {
  edited: () => {
    save({ ...state, draft: input.value });
    redraft();
  },
  wanted: () => host.postMessage({ type: 'want-commands' }),
  submit,
});
const peek = peekOver();
const form = h('form', { class: 'composer' }, menu, slash.element, picker.menu, controls.menu, peek.element, inputBox);
const start = startPage((message) => host.postMessage(message));
const peekInput = (): PeekInput => ({
  turns: transcript.turns.length,
  running: isRunning(transcript),
  composerFocused: document.activeElement === input,
  draft: input.value,
});
const gate = motionGate((motion) => {
  start.setMotion(motion);
  peek.setTracking(motion !== 'still', peekInput());
});

const projectLabel = h('span', { class: 'header-project' });
const titleLabel = h('span', { class: 'header-title' });
const header = h(
  'header',
  { class: 'chat-header' },
  icon('folder'),
  projectLabel,
  h('span', { class: 'header-sep', 'aria-hidden': 'true' }, '/'),
  h('button', { type: 'button', class: 'header-session', title: 'Show the chat history', onclick: () => history.open() }, titleLabel, icon('chevron-down')),
);

function showHeader(next: Header): void {
  const { project, title } = next;
  projectLabel.textContent = project;
  titleLabel.textContent = title ?? 'New chat';
  start.header(next);
  header.title = `${project} / ${title ?? 'New chat'}`;
}

type Pane = { isOpen(): boolean; close(): void };

// The history, the MCP servers, the rules, the memory and the settings each take the transcript's and the composer's place while open, one at a time.
const showPane = (name: string, open: boolean): void => {
  if (open) for (const [other, pane] of Object.entries(panes)) if (other !== name) pane.close();
  const shown = Object.entries(panes).find(([, pane]) => pane.isOpen())?.[0] ?? 'chat';
  document.body.dataset['view'] = shown;
  log.hidden = shown !== 'chat';
  form.hidden = shown !== 'chat';
  if (shown === 'chat') input.focus();
  schedule();
};
const post = (message: FromView) => host.postMessage(message);
const history = historyPanel(post, (open) => showPane('history', open));
const mcp = mcpPanel(post, (open) => showPane('mcp', open));
const rules = rulesPanel(post, (open) => showPane('rules', open));
const memory = memoryPanel(post, (open) => showPane('memory', open));
const settings = settingsPanel(post, (open) => showPane('settings', open));
const panes: Readonly<Record<string, Pane>> = { history, mcp, rules, memory, settings };
const anyPaneOpen = (): boolean => Object.values(panes).some((pane) => pane.isOpen());
document.body.dataset['view'] = 'chat';
document.body.append(header, mcp.notice, history.element, mcp.element, rules.element, memory.element, settings.element, log, form, status);
const attachments = composerAttachments(form, (message) => host.postMessage(message), () => showTray());
tray.insertBefore(attachments.element, chips);
inputBox.insertBefore(attachments.note, input);

/** The tray shows while any chip is in it. */
function showTray(): void {
  tray.hidden = !(chips.childElementCount > 0 || !attachments.element.hidden || controls.tray.some((chip) => !chip.hidden));
}

// The glass style floats the composer over the transcript, which keeps this much room below its last line.
new ResizeObserver(() => document.body.style.setProperty('--composer-height', `${form.offsetHeight}px`)).observe(form);

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

/** A step's content, rebuilt only when what it shows changes. A `quiet` step is one of a compact turn's recent steps. */
function stepContent(turn: Turn, step: Step, last: boolean, quiet: boolean): { readonly deps: readonly unknown[]; readonly build: () => HTMLElement } {
  switch (step.kind) {
    case 'text': {
      const streaming = turn.status === 'streaming';
      const shown = shownLength(step.block.id, step.block.text, streaming);
      const caret = streaming && last;
      return { deps: [step.block.text, shown, caret], build: () => textBlock(step.block.text.slice(0, shown), caret, ui) };
    }
    case 'calls':
      return { deps: [quiet, ...step.tools, '|', ...state.open, '|', ...state.unfolded], build: () => callsStep(step.key, step.name, step.tools, ui, quiet) };
    case 'permission':
      return { deps: [step.block, quiet], build: () => permissionCard(step.block, ui, quiet) };
    case 'error':
      return { deps: [step.block], build: () => errorBlock(step.block) };
    case 'notice':
      return { deps: [step.text], build: () => turnNotice(step.text) };
    case 'thinking':
      return { deps: [], build: thinkingRow };
    case 'changes':
      return { deps: [...step.edits, '|', ...state.unfolded], build: () => changesCard(step.edits, ui) };
    case 'fold':
      return { deps: [step.label, step.open], build: () => foldRow(step, ui) };
    case 'files':
      return { deps: [JSON.stringify(step.files)], build: () => filesRow(step.files, ui) };
  }
}

/** One node on the rail, its dot styled by the step's state. */
function stepItem(turn: Turn, step: Step, last: boolean, quiet: boolean): Keyed {
  const node = nodeOf(step);
  const content = stepContent(turn, step, last, quiet);
  return {
    key: step.key,
    deps: [node, ...content.deps],
    build: () => h('li', { class: `step step-${step.kind} node-${node}` }, h('span', { class: 'node', 'aria-hidden': 'true' }), content.build()),
  };
}

function turnShell(turn: Turn): HTMLElement {
  return h(
    'article',
    { class: 'turn', 'data-turn': turn.id },
    userMessage(turn.prompt, turn.attachments, ui, turn.command),
    h('div', { class: 'head-slot' }),
    h('ol', { class: 'rail' }),
    h('div', { class: 'footer-slot' }),
  );
}

const pendingText = (turn: Turn): boolean =>
  turn.blocks.some((b) => b.kind === 'text' && (revealed.get(b.id) ?? b.text.length) < b.text.length);

let wasEmpty = false;

function render(): void {
  frame = undefined;
  const atBottom = log.scrollHeight - log.scrollTop - log.clientHeight < 24;
  const focused = (document.activeElement as HTMLElement | null)?.dataset['focus'];

  const empty = transcript.turns.length === 0;
  const shells = reconcile(
    log,
    empty
      ? [{ key: 'empty', deps: [], build: () => start.element }]
      : transcript.turns.map((turn) => ({ key: turn.id, deps: [turn.id], build: () => turnShell(turn) })),
  );
  let animating = false;
  if (!empty) {
    transcript.turns.forEach((turn, i) => {
      const shell = shells[i]!;
      shell.setAttribute('aria-busy', String(turn.status === 'streaming'));
      reconcile(shell.querySelector<HTMLElement>(':scope > .head-slot')!, [{ key: 'head', deps: [turn.status, turn.endedAt, isWaiting(turn), turn.mode, turn.usage], build: () => turnHead(turn) }]);
      // Compact detail folds the turn's work until the user opens it; full detail, or an opened turn, draws every step.
      const open = ui.isOpen(foldId(turn.id));
      const whole = detail() === 'full' || open;
      const steps = shownSteps(turn, detail(), open);
      const lastText = turn.blocks.at(-1)?.kind === 'text' ? turn.blocks.at(-1)!.id : undefined;
      reconcile(shell.querySelector<HTMLElement>(':scope > .rail')!, steps.map((step) => stepItem(turn, step, step.kind === 'text' && step.block.id === lastText, !whole)));
      const building = turn.status === 'done' && turn.mode === 'plan' && mode === 'plan' && i === transcript.turns.length - 1;
      reconcile(shell.querySelector<HTMLElement>(':scope > .footer-slot')!, [
        ...(turn.status === 'streaming' ? [] : [{ key: 'footer', deps: [turn.usage, turn.status, whole], build: () => turnFooter(turn, whole) }]),
        ...(building ? [{ key: 'build', deps: [], build: () => startBuilding(ui) }] : []),
      ]);
      animating ||= turn.status === 'streaming' && pendingText(turn);
    });
  }

  const running = isRunning(transcript);
  if (empty && !wasEmpty) start.refresh();
  wasEmpty = empty;
  gate.set('shown', empty && document.body.dataset['view'] === 'chat');
  peek.update(peekInput());
  const view = composerView({ transcript, facts, mcp: mcpListing, queued: queued === undefined ? undefined : queued.text || `${queued.attachments.length} attachments`, now: Date.now() });
  controls.show(view);
  showTray();
  send.hidden = view.action !== 'send';
  stop.hidden = view.action !== 'stop';
  input.placeholder = view.placeholder;
  tick(running);
  if (focused !== undefined && !document.activeElement?.isConnected) document.querySelector<HTMLElement>(`[data-focus="${CSS.escape(focused)}"]`)?.focus();
  focusNewPermission();
  if (!keepPlace() && atBottom) log.scrollTop = log.scrollHeight;
  if (animating) schedule();
}

function schedule(): void {
  frame ??= requestAnimationFrame(render);
}

/** The running turn's clock, redrawn each second while it runs. */
let ticking: ReturnType<typeof setInterval> | undefined;
function tick(running: boolean): void {
  if (running && ticking === undefined) ticking = setInterval(schedule, 1000);
  if (!running && ticking !== undefined) {
    clearInterval(ticking);
    ticking = undefined;
  }
}

/** A waiting card's control that takes the keyboard: the one it marks, such as a question's first option, or else its first field or button. */
const answerControl = (card: Element): HTMLElement | null => card.querySelector<HTMLElement>('[data-keyboard]') ?? card.querySelector<HTMLElement>('textarea, button');

/** A question from the engine takes the keyboard once, on its default button. */
const asked = new Set<string>();
function focusNewPermission(): void {
  for (const card of document.querySelectorAll<HTMLElement>('.permission-open[data-permission]')) {
    const id = card.dataset['permission']!;
    if (asked.has(id)) continue;
    asked.add(id);
    answerControl(card)?.focus();
  }
}

const ENDED = { done: 'Geno finished', stopped: 'Stopped', failed: 'The turn failed' } as const;

/** What a screen reader hears besides the transcript itself. */
const ANNOUNCEMENTS: { readonly [K in ToView['type']]?: (message: Extract<ToView, { type: K }>) => string } = {
  'turn-start': () => 'Geno is working',
  permission: ({ command, ask }) => (ask === undefined ? `Geno asks to run ${command}` : ask.kind === 'memory' ? `Geno asks to remember: ${command}` : `Geno asks: ${command}`),
  'turn-end': ({ status }) => ENDED[status],
};
const announcement = (message: ToView): string | undefined => (ANNOUNCEMENTS[message.type] as ((m: ToView) => string) | undefined)?.(message);

window.addEventListener('message', (event: MessageEvent<ToView>) => {
  const message = event.data;
  if (message.type === 'completions') {
    showCompletions(message.id, message.items);
    return;
  }
  if (message.type === 'look') {
    document.body.dataset['style'] = message.look.style;
    document.body.dataset['detail'] = message.look.detail;
    schedule();
    return;
  }
  if (message.type === 'picked') {
    attachments.picked(message.files, message.refused);
    return;
  }
  if (message.type === 'roots') {
    setRoots(message.roots);
    return;
  }
  if (message.type === 'header') return showHeader(message.header);
  if (message.type === 'modes') return picker.show(message.modes);
  if (message.type === 'commands') return slash.setCommands(message.commands);
  if (message.type === 'show-history') return history.open();
  if (message.type === 'hide-history') return history.close();
  if (message.type === 'window-focus') return gate.set('focused', message.focused);
  if (message.type === 'history') {
    if (message.scope === 'project') start.listed(message.rows);
    return history.listed(message.scope, message.rows);
  }
  if (message.type === 'history-failed') return history.failed(message.scope, message.message);
  if (message.type === 'mcp') {
    mcpListing = message.listing;
    schedule();
    return mcp.listed(message.listing);
  }
  if (message.type === 'composer') {
    facts = message.facts;
    schedule();
    return;
  }
  if (message.type === 'show-mcp') return mcp.open();
  if (message.type === 'settings') return settings.listed(message.listing);
  if (message.type === 'show-settings') return settings.open();
  if (message.type === 'settings-tested') return settings.tested(message.provider, message.state);
  if (message.type === 'settings-models') return settings.modelsListed(message.provider, message.state);
  if (message.type === 'rules') return rules.listed(message.listing);
  if (message.type === 'show-rules') return rules.open();
  if (message.type === 'memory') return memory.listed(message.listing);
  if (message.type === 'show-memory') return memory.open();
  transcript = reduce(transcript, message);
  // A reset rebuilds a view that missed the stream, so its text shows in full rather than replaying.
  if (message.type === 'reset') for (const turn of transcript.turns) for (const b of turn.blocks) if (b.kind === 'text') revealed.set(b.id, b.text.length);
  const said = announcement(message);
  if (said !== undefined) status.textContent = said;
  if (message.type === 'turn-end') sendQueued(message.status);
  schedule();
});

/** A follow-up queued during the turn goes once it finishes; after a stop or a failure it comes back to the composer instead. */
function sendQueued(ended: 'done' | 'stopped' | 'failed'): void {
  const next = queued;
  queued = undefined;
  if (next === undefined) return;
  if (ended === 'done') {
    host.postMessage({ type: 'send', text: next.text, ...(next.attachments.length === 0 ? {} : { attachments: next.attachments }) });
    return;
  }
  if (input.value.trim() === '') edit(next.text, undefined);
  attachments.restore(next.attachments);
}

/** The composer after its text changed: its height, and a chip for each `@` mention in it. */
function redraft(): void {
  peek.update(peekInput());
  input.style.height = 'auto';
  input.style.height = `${Math.min(input.scrollHeight, MAX_COMPOSER_PX)}px`;
  input.style.overflowY = input.scrollHeight > MAX_COMPOSER_PX ? 'auto' : 'hidden';
  // The mention still being typed gets its chip once it is chosen or finished.
  const typing = mentionAtCaret(input.value, input.selectionStart);
  const settled = typing === undefined ? input.value : input.value.slice(0, typing.start) + input.value.slice(input.selectionStart);
  chips.replaceChildren(
    ...mentionsIn(settled).map((label) =>
      h(
        'span',
        { class: 'context-chip', role: 'listitem', 'data-mention': label, title: formatMention(label) },
        icon(label === SELECTION ? 'selection' : 'file-code'),
        h('span', { class: 'chip-name' }, label.slice(label.lastIndexOf('/') + 1)),
        h(
          'button',
          { type: 'button', class: 'chip-remove', 'aria-label': `Remove ${label}`, title: 'Remove', onclick: () => edit(withoutMention(input.value, label), undefined) },
          icon('close'),
        ),
      ),
    ),
  );
  showTray();
}

/** Replaces the draft, putting the caret at `caret` or the end, and keeps the focus in the composer. */
function edit(text: string, caret: number | undefined): void {
  input.value = text;
  save({ ...state, draft: text });
  input.focus();
  const at = caret ?? text.length;
  input.setSelectionRange(at, at);
  redraft();
}

/** The add button types an `@` at the caret, which opens the completion list as typing one would. */
function addContext(): void {
  const caret = input.selectionStart;
  const before = input.value.slice(0, caret);
  const mention = before === '' || /\s$/.test(before) ? '@' : ' @';
  edit(before + mention + input.value.slice(input.selectionEnd), caret + mention.length);
  askCompletions();
}

/** The `/` button: a `/` at the start of the draft, with the caret after it, which opens the command picker. */
function openCommands(): void {
  const text = input.value.startsWith('/') ? input.value : input.value === '' ? '/' : `/ ${input.value}`;
  edit(text, 1);
  slash.refresh();
}

function fill(text: string): void {
  closeMenu();
  slash.close();
  edit(text, undefined);
}

/**
 * The `@` completion list. Each keystroke in a mention asks the extension again; only the answer to the newest
 * question is shown, so a slow answer never replaces a newer one.
 */
let lastQuestion = 0;
let pending: { readonly id: number; readonly start: number; readonly query: string } | undefined;
let completing: { readonly start: number; readonly items: readonly MentionCompletion[]; readonly active: number } | undefined;

function askCompletions(): void {
  const at = mentionAtCaret(input.value, input.selectionStart);
  if (at === undefined || input.selectionStart !== input.selectionEnd) {
    closeMenu();
    return;
  }
  pending = { id: ++lastQuestion, start: at.start, query: at.query };
  host.postMessage({ type: 'complete', id: pending.id, query: at.query });
}

function showCompletions(id: number, items: readonly MentionCompletion[]): void {
  if (pending?.id !== id) return;
  completing = { start: pending.start, items: pending.query === '' ? [ATTACH_ROW, ...items] : items, active: 0 };
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
  if (item.kind === 'attach') {
    const text = input.value.slice(0, completing.start) + input.value.slice(input.selectionStart);
    const caret = completing.start;
    closeMenu();
    edit(text, caret);
    host.postMessage({ type: 'pick-files' });
    return;
  }
  const next = insertMention(input.value, completing.start, input.selectionStart, item.label);
  closeMenu();
  input.value = next.text;
  input.setSelectionRange(next.caret, next.caret);
  save({ ...state, draft: input.value });
  redraft();
}

const moveActive = (by: number) => () => {
  if (completing === undefined) return;
  const count = completing.items.length;
  completing = { ...completing, active: (completing.active + by + count) % count };
  renderMenu();
};

/** Keys that move the caret without typing, into or out of a mention. */
const CARET_KEYS = new Set(['ArrowLeft', 'ArrowRight', 'Home', 'End']);

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
          ...(item.kind === 'attach' ? { 'data-action': 'attach' } : { 'data-mention': item.label }),
          // Keeps the focus in the composer, so the click does not close the list before it lands.
          onmousedown: (event) => event.preventDefault(),
          onclick: () => accept(i),
        },
        icon(item.kind === 'attach' ? 'attach' : item.kind === 'selection' ? 'selection' : 'file'),
        h('span', { class: 'mention-label' }, item.kind === 'file' ? item.label.slice(item.label.lastIndexOf('/') + 1) : item.label),
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

/** Sends the draft, or while a turn runs queues it to send when the turn finishes; one follow-up waits at a time. */
function submit(): void {
  const text = input.value.trim();
  const attached = attachments.ready();
  if ((text === '' && attached.length === 0) || attachments.busy()) return;
  if (isRunning(transcript)) {
    if (queued !== undefined) return;
    queued = { text, attachments: attached };
    schedule();
  } else host.postMessage({ type: 'send', text, ...(attached.length === 0 ? {} : { attachments: attached }) });
  attachments.clear();
  fill('');
}

/**
 * An IME such as Thai's is composing: its Enter commits the composition and must not send. Chromium marks such keys
 * `isComposing` and gives them keyCode 229; the composition events cover an IME that does neither.
 */
let composing = false;
input.addEventListener('compositionstart', () => (composing = true));
input.addEventListener('compositionend', () => (composing = false));
const imeKey = (event: KeyboardEvent): boolean => event.isComposing || composing || event.keyCode === 229;

form.addEventListener('submit', (event) => {
  event.preventDefault();
  submit();
});
input.addEventListener('input', () => {
  save({ ...state, draft: input.value });
  redraft();
  askCompletions();
  slash.refresh();
});
for (const type of ['focus', 'blur'] as const) input.addEventListener(type, () => peek.update(peekInput()));
input.addEventListener('click', () => {
  askCompletions();
  slash.refresh();
});
input.addEventListener('keyup', (event) => {
  if (!CARET_KEYS.has(event.key)) return;
  askCompletions();
  slash.refresh();
});
input.addEventListener('keydown', (event) => {
  if (slash.keydown(event)) return;
  if (completing !== undefined && completing.items.length > 0 && !imeKey(event)) {
    const move = MENU_KEYS[event.key];
    if (move !== undefined) {
      event.preventDefault();
      event.stopPropagation();
      move();
      return;
    }
  }
  if (event.key === 'Enter' && !event.shiftKey && !imeKey(event)) {
    event.preventDefault();
    submit();
  }
});
stop.addEventListener('click', () => host.postMessage({ type: 'stop' }));
document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape' && isRunning(transcript) && !anyPaneOpen()) {
    event.preventDefault();
    host.postMessage({ type: 'stop' });
  }
});
// The view's focus command focuses the webview itself; what the user means to type into is a question waiting for
// them, or else the composer. The host runs that command as a question arrives, so it can land after the card took
// the keyboard. A webview created by that command can receive the focus before this script runs, hence the check at start.
const focusView = () => {
  if (document.activeElement !== document.body && document.activeElement !== null) return;
  const waiting = document.querySelector('.permission-open[data-permission]');
  ((waiting && answerControl(waiting)) ?? input).focus();
};
window.addEventListener('focus', () => requestAnimationFrame(focusView));

input.value = state.draft;
redraft();
render();
if (document.hasFocus()) focusView();
host.postMessage({ type: 'ready' });
