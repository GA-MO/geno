/// <reference lib="dom" />
import type { AskUserQuestion, AskUserRequest } from '@g-code/core';
import { h, icon } from './dom.js';
import type { FromView } from './messages.js';
import { answersOf, cardStart, clickRow, isAnsweredAt, isComplete, onKey, typeOther, type CardState, type Effect, type Step } from './question-model.js';

/** What the card needs from the panel: a way to answer, and the safe markdown renderer for previews. */
export type CardUi = { readonly post: (message: FromView) => void; readonly markdown: (text: string) => HTMLElement };

/** Each waiting card's state, kept across a rebuild of the step that holds it. */
const states = new Map<string, CardState>();

/**
 * A waiting `ask_user` card: a tab per question, the options as radio or checkbox rows with Other last, the active
 * option's preview, and one Submit answers. The keyboard map is `onKey` in question-model.ts.
 */
export function questionCard(id: string, request: AskUserRequest, ui: CardUi): HTMLElement {
  let state = states.get(id) ?? cardStart(request);
  const root = h('div', { class: 'question-card' });
  /** The Other fields, one per question, kept across repaints so the caret and an IME composition survive. */
  const fields = request.questions.map((q, i) => otherField(q, i));

  function otherField(q: AskUserQuestion, i: number): HTMLTextAreaElement {
    const field = h('textarea', {
      class: 'question-input',
      rows: 1,
      placeholder: 'Other: type your own answer',
      'aria-label': `Other answer to ${q.question}`,
      'data-focus': `other:${id}:${q.id}`,
    });
    field.addEventListener('input', (event) => {
      state = typeOther(request, { ...state, tab: i }, field.value);
      if (!(event as InputEvent).isComposing) paint(undefined);
    });
    field.addEventListener('focus', () => {
      if (state.rows[i] === q.options.length && state.tab === i) return;
      state = { ...state, tab: i, rows: state.rows.map((row, j) => (j === i ? q.options.length : row)) };
      paint(undefined);
    });
    return field;
  }

  const answer = (message: FromView) => {
    states.delete(id);
    ui.post(message);
  };

  function apply(step: Step | undefined, event?: Event): void {
    if (step === undefined) return;
    event?.preventDefault();
    event?.stopPropagation();
    state = step.state;
    if ('submit' in step.effect) return answer({ type: 'answer', id, answer: { kind: 'answered', answers: answersOf(request, state) } });
    if ('cancel' in step.effect) return answer({ type: 'answer', id, answer: { kind: 'declined' } });
    paint(step.effect);
  }

  root.addEventListener('keydown', (event) => {
    if (event.isComposing) return;
    const field = event.target instanceof HTMLTextAreaElement ? event.target : undefined;
    // The actions are ordinary buttons, so only Esc belongs to the card there.
    if ((event.target as HTMLElement).closest('.question-actions') !== null) {
      if (event.key === 'Escape') apply({ state, effect: { cancel: true } }, event);
      return;
    }
    apply(onKey(request, state, { key: event.key, shift: event.shiftKey, inField: field !== undefined, caretAtStart: field !== undefined && field.selectionStart === 0 && field.selectionEnd === 0 }), event);
  });

  function row(q: AskUserQuestion, i: number, active: number): HTMLElement {
    const option = q.options[i]!;
    const draft = state.drafts[state.tab]!;
    const on = draft.picked.includes(option.label);
    return h(
      'div',
      {
        class: `question-row${on ? ' question-row-on' : ''}`,
        role: q.multiSelect ? 'checkbox' : 'radio',
        'aria-checked': String(on),
        tabindex: i === active ? 0 : -1,
        'data-row': i,
        'data-focus': `row:${id}:${q.id}:${i}`,
        ...(i === active ? { 'data-keyboard': true } : {}),
        onclick: () => apply(clickRow(request, state, i)),
        onfocus: () => {
          if (state.rows[state.tab] === i) return;
          state = { ...state, rows: state.rows.map((r, j) => (j === state.tab ? i : r)) };
          paint(undefined);
        },
      },
      mark(q.multiSelect, on),
      h('span', { class: 'question-key', 'aria-hidden': 'true' }, String(i + 1)),
      h(
        'span',
        { class: 'question-option-text' },
        h('span', { class: 'question-option-head' }, h('span', { class: 'question-option' }, option.label), option.recommended && h('span', { class: 'question-tag' }, 'Recommended')),
        option.description !== undefined && h('span', { class: 'question-desc' }, option.description),
      ),
    );
  }

  function otherRow(q: AskUserQuestion, active: number): HTMLElement {
    const draft = state.drafts[state.tab]!;
    const field = fields[state.tab]!;
    if (field.value !== draft.other) field.value = draft.other;
    const n = q.options.length;
    field.tabIndex = n === active ? 0 : -1;
    if (n === active) field.dataset['keyboard'] = '';
    else delete field.dataset['keyboard'];
    return h(
      'div',
      {
        class: `question-row question-other${draft.otherOn ? ' question-row-on' : ''}`,
        role: 'presentation',
        'data-row': n,
        onclick: (event: Event) => {
          if (event.target !== field) apply(clickRow(request, state, n));
        },
      },
      mark(q.multiSelect, draft.otherOn),
      h('span', { class: 'question-key', 'aria-hidden': 'true' }, String(n + 1)),
      field,
    );
  }

  function preview(q: AskUserQuestion, active: number): HTMLElement | undefined {
    if (!q.options.some((o) => o.preview !== undefined)) return undefined;
    const text = q.options[active]?.preview;
    return h(
      'div',
      { class: 'question-preview', 'aria-label': 'Preview', role: 'region' },
      text === undefined ? h('p', { class: 'question-preview-empty' }, 'No preview for this option.') : ui.markdown(text),
    );
  }

  function paint(effect: Effect | undefined): void {
    states.set(id, state);
    const had = (document.activeElement as HTMLElement | null)?.dataset['focus'];
    const q = request.questions[state.tab]!;
    const active = state.rows[state.tab]!;
    const several = request.questions.length > 1;
    const complete = isComplete(request, state);
    const side = preview(q, active);
    root.replaceChildren(
      several
        ? h(
            'div',
            { class: 'question-tabs', role: 'tablist', 'aria-label': 'Questions' },
            ...request.questions.map((each, i) =>
              h(
                'button',
                {
                  type: 'button',
                  class: `question-tab${i === state.tab ? ' question-tab-on' : ''}`,
                  role: 'tab',
                  tabindex: -1,
                  'aria-selected': String(i === state.tab),
                  'data-tab': i,
                  onclick: () => apply({ state: { ...state, tab: i }, effect: { focus: state.rows[i] === each.options.length ? 'other' : 'row' } }),
                },
                h('span', {}, each.header),
                isAnsweredAt(request, state, i) ? h('span', { class: 'question-dot', role: 'img', 'aria-label': 'answered' }) : undefined,
              ),
            ),
          )
        : '',
      h(
        'div',
        { class: 'question-panel', role: several ? 'tabpanel' : 'group', 'aria-label': q.header },
        h('p', { class: 'question-text' }, q.question),
        h(
          'div',
          { class: `question-body${side === undefined ? '' : ' question-body-preview'}` },
          h(
            'div',
            { class: 'question-list', role: q.multiSelect ? 'group' : 'radiogroup', 'aria-label': q.question },
            ...q.options.map((_, i) => row(q, i, active)),
            otherRow(q, active),
          ),
          side,
        ),
      ),
      h(
        'div',
        { class: 'question-actions' },
        h('button', { type: 'button', class: 'button question-submit', disabled: !complete, 'data-focus': `submit:${id}`, onclick: () => apply({ state, effect: { submit: true } }) }, 'Submit answers'),
        h('button', { type: 'button', class: 'button ghost question-skip', 'data-focus': `skip:${id}`, onclick: () => apply({ state, effect: { cancel: true } }) }, 'Skip'),
        h('span', { class: 'question-hint' }, `↑↓ move · 1–${q.options.length + 1} pick${q.multiSelect ? ' · Space toggle' : ''}${several ? ' · Tab next' : ''} · Enter ${state.tab === request.questions.length - 1 ? 'submit' : 'next'} · Esc skip`),
      ),
    );
    const target =
      effect === undefined
        ? had === undefined
          ? null
          : root.querySelector<HTMLElement>(`[data-focus="${CSS.escape(had)}"]`)
        : effect && 'focus' in effect
          ? effect.focus === 'actions'
            ? root.querySelector<HTMLElement>('.question-submit:not(:disabled), .question-skip')
            : root.querySelector<HTMLElement>('[data-keyboard]')
          : null;
    if (target !== null && target !== document.activeElement) target.focus();
  }

  paint(undefined);
  return root;
}

const mark = (multi: boolean, on: boolean): HTMLElement =>
  h('span', { class: `question-mark ${multi ? 'question-mark-box' : 'question-mark-radio'}`, 'aria-hidden': 'true' }, multi && on ? icon('check') : '');
