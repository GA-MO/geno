/// <reference lib="dom" />
import { h, icon, MAC, type Keyed } from './dom.js';
import type { Child, FromView, SteerBlock } from './messages.js';
import { fieldStatus, steerLook, targetKey, type SendNow, type SteerResult, type SteerTarget } from './steer-model.js';

export const SEND_NOW_KEY = MAC ? '⌘Enter' : 'Ctrl+Enter';

/** Cmd+Enter on macOS, Ctrl+Enter elsewhere: send now rather than queue. */
export const isSendNowKey = (event: KeyboardEvent): boolean => event.key === 'Enter' && !event.shiftKey && !event.altKey && (MAC ? event.metaKey && !event.ctrlKey : event.ctrlKey && !event.metaKey);

const READY_TITLE = `Send now (${SEND_NOW_KEY}): it lands at the next tool round`;

/** The composer's Send now control beside Stop, in the DOM only while a turn runs and something could go. */
export function sendNowButton(onSend: () => void) {
  const element = h('button', { type: 'button', class: 'round-button send-now', 'aria-label': 'Send now', hidden: true, onclick: () => onSend() }, icon('arrow-up'));
  return {
    element,
    show(state: SendNow): void {
      element.hidden = state.kind === 'hidden';
      // aria-disabled rather than disabled, so the reason still shows on hover and the keyboard can reach it.
      element.setAttribute('aria-disabled', String(state.kind === 'blocked'));
      element.title = state.kind === 'blocked' ? state.reason : READY_TITLE;
    },
  };
}

/** A steer on the rail where it landed. */
export function steerStep(block: SteerBlock): HTMLElement {
  const look = steerLook(block.shown);
  if (look.kind === 'note') return h('div', { class: 'steer-note', 'data-from': block.shown.from }, icon('reply'), h('span', {}, look.label));
  return h(
    'div',
    { class: `steer steer-${look.kind}`, 'data-from': block.shown.from },
    h('span', { class: 'steer-label' }, icon(look.kind === 'bubble' ? 'arrow-up' : 'comment'), look.label),
    h('div', { class: 'steer-text' }, look.text ?? ''),
  );
}

/**
 * A one-line message field for a running session that is not the chat's: a subagent in its side view, or a task.
 * It shows how the last message went until the next one is typed.
 */
function steerField(target: SteerTarget, who: string, post: (message: FromView) => void, label: string) {
  const input = h('input', { type: 'text', class: 'steer-input', placeholder: `Message ${who}…`, 'aria-label': label, 'data-focus': `steer:${targetKey(target)}` });
  const status = h('p', { class: 'steer-status', role: 'status', hidden: true });
  const send = h('button', { type: 'submit', class: 'button small steer-send', title: 'It lands at the next tool round' }, 'Send');
  const row = h('div', { class: 'steer-row' }, input, send);
  const element = h('form', { class: 'steer-field', 'data-steer': targetKey(target) }, row, status);
  const tell = (result: SteerResult | 'sending') => {
    const { tone, text } = fieldStatus(result, who);
    status.hidden = false;
    status.dataset['tone'] = tone;
    status.textContent = text;
  };
  element.addEventListener('submit', (event) => {
    event.preventDefault();
    const text = input.value.trim();
    if (text === '') return;
    post({ type: 'steer', target, text });
    input.value = '';
    tell('sending');
  });
  // The panel's Escape goes back or stops the turn; inside a field it only leaves the field.
  input.addEventListener('keydown', (event) => event.key === 'Escape' && event.stopPropagation());
  return { element, input, row, tell, told: () => !status.hidden };
}

type Field = ReturnType<typeof steerField>;

/** The side view's field: it messages the open subagent while that one runs, and keeps its last word after. */
export function childSteer(post: (message: FromView) => void) {
  const slot = h('div', { class: 'child-steer' });
  let shown: { readonly id: string; readonly field: Field } | undefined;
  return {
    element: slot,
    show(child: Child): void {
      if (shown?.id !== child.id) {
        shown = { id: child.id, field: steerField({ kind: 'child', id: child.id }, child.role, post, `Message ${child.role} while it runs`) };
        slot.replaceChildren(shown.field.element);
      }
      shown.field.row.hidden = child.status.kind !== 'running';
      slot.hidden = shown.field.row.hidden && !shown.field.told();
    },
    steered(target: SteerTarget, result: SteerResult): void {
      if (target.kind === 'child' && target.id === shown?.id) shown.field.tell(result);
    },
  };
}

/** The Tasks pane's fields, one per task whose Message the user opened, each its own list item under the task's row. */
export function taskSteers(post: (message: FromView) => void, opened: () => void) {
  const fields = new Map<string, Field>();
  return {
    open(sessionId: string, title: string): void {
      if (!fields.has(sessionId)) fields.set(sessionId, steerField({ kind: 'task', sessionId }, 'the task', post, `Message ${title}`));
      opened();
      fields.get(sessionId)!.input.focus();
    },
    /** The field's item for a task row, kept while the task runs; it is built once, so a tick of the list never takes its focus. */
    items(sessionId: string, live: boolean): Keyed[] {
      const field = fields.get(sessionId);
      if (field === undefined) return [];
      if (!live && !field.told()) {
        fields.delete(sessionId);
        return [];
      }
      field.row.hidden = !live;
      return [{ key: `steer:${sessionId}`, deps: [field], build: () => h('li', { class: 'task-steer' }, field.element) }];
    },
    steered(target: SteerTarget, result: SteerResult): void {
      if (target.kind === 'task') fields.get(target.sessionId)?.tell(result);
    },
  };
}
