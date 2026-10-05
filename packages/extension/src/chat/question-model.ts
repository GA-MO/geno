import type { AskUserAnswers, AskUserQuestion, AskUserRequest, QuestionAnswer } from '@g-code/core';

/**
 * A question card while it waits: which question's tab shows, the active row of each question, and each question's
 * draft answer. Rows are the options, then Other, whose row is its text field. Pure, so the keyboard map is tested
 * without a webview.
 */
export type Draft = { readonly picked: readonly string[]; readonly other: string; readonly otherOn: boolean };
export type CardState = { readonly tab: number; readonly rows: readonly number[]; readonly drafts: readonly Draft[] };

/** What the view does after a step: move the focus, send the answers, or decline. */
export type Effect = { readonly focus: 'row' | 'other' | 'actions' } | { readonly submit: true } | { readonly cancel: true };
export type Step = { readonly state: CardState; readonly effect: Effect };

/** A key as the card sees it: inside the Other field, typing keys belong to the text. */
export type Key = { readonly key: string; readonly shift: boolean; readonly inField: boolean; readonly caretAtStart: boolean };

export const cardStart = ({ questions }: AskUserRequest): CardState => ({
  tab: 0,
  rows: questions.map(() => 0),
  drafts: questions.map(() => ({ picked: [], other: '', otherOn: false })),
});

const clamp = (n: number, max: number): number => Math.max(0, Math.min(max, n));
const replaced = <T>(list: readonly T[], i: number, value: T): T[] => list.map((x, j) => (j === i ? value : x));

const answerOf = (q: AskUserQuestion, draft: Draft): QuestionAnswer => ({
  picked: q.options.map((o) => o.label).filter((label) => draft.picked.includes(label)),
  ...(draft.otherOn && draft.other.trim() !== '' ? { other: draft.other.trim() } : {}),
});

const answered = (q: AskUserQuestion, draft: Draft): boolean => {
  const answer = answerOf(q, draft);
  return answer.picked.length > 0 || answer.other !== undefined;
};

export const isAnsweredAt = (request: AskUserRequest, state: CardState, i: number): boolean => answered(request.questions[i]!, state.drafts[i]!);
export const isComplete = (request: AskUserRequest, state: CardState): boolean => request.questions.every((_, i) => isAnsweredAt(request, state, i));

/** The answered questions' answers, keyed by question id. */
export function answersOf(request: AskUserRequest, state: CardState): AskUserAnswers {
  return Object.fromEntries(request.questions.flatMap((q, i) => (answered(q, state.drafts[i]!) ? [[q.id, answerOf(q, state.drafts[i]!)]] : [])));
}

const otherRow = (q: AskUserQuestion): number => q.options.length;
const focusOf = (q: AskUserQuestion, row: number): Effect => ({ focus: row === otherRow(q) ? 'other' : 'row' });

/** Picks a row of the shown question: one option of a single-select, or toggles one of a multi-select. Other turns on. */
function pick(request: AskUserRequest, state: CardState, row: number): CardState {
  const q = request.questions[state.tab]!;
  const draft = state.drafts[state.tab]!;
  const label = q.options[row]?.label;
  const next: Draft =
    label === undefined
      ? { picked: q.multiSelect ? draft.picked : [], other: draft.other, otherOn: true }
      : q.multiSelect
        ? { ...draft, picked: draft.picked.includes(label) ? draft.picked.filter((l) => l !== label) : [...draft.picked, label] }
        : { ...draft, picked: [label], otherOn: false };
  return { ...state, rows: replaced(state.rows, state.tab, row), drafts: replaced(state.drafts, state.tab, next) };
}

/** The user's own words under Other, which in a single-select replace the option picked. */
export function typeOther(request: AskUserRequest, state: CardState, text: string): CardState {
  const q = request.questions[state.tab]!;
  const draft = state.drafts[state.tab]!;
  return { ...state, rows: replaced(state.rows, state.tab, otherRow(q)), drafts: replaced(state.drafts, state.tab, { picked: q.multiSelect ? draft.picked : [], other: text, otherOn: true }) };
}

const toTab = (request: AskUserRequest, state: CardState, tab: number): Step => {
  const next = { ...state, tab };
  return { state: next, effect: focusOf(request.questions[tab]!, next.rows[tab]!) };
};

const firstUnanswered = (request: AskUserRequest, state: CardState): number => request.questions.findIndex((_, i) => !isAnsweredAt(request, state, i));

/** After a pick: the next question, or on the last one the actions, or the first question still unanswered. */
function advance(request: AskUserRequest, state: CardState): Step {
  if (state.tab < request.questions.length - 1) return toTab(request, state, state.tab + 1);
  return isComplete(request, state) ? { state, effect: { focus: 'actions' } } : toTab(request, state, firstUnanswered(request, state));
}

/** Enter: the next question, or on the last one the answers, once every question has one. */
function commit(request: AskUserRequest, state: CardState): Step {
  if (state.tab < request.questions.length - 1) return toTab(request, state, state.tab + 1);
  return isComplete(request, state) ? { state, effect: { submit: true } } : toTab(request, state, firstUnanswered(request, state));
}

function move(request: AskUserRequest, state: CardState, by: number): Step {
  const q = request.questions[state.tab]!;
  const row = clamp(state.rows[state.tab]! + by, otherRow(q));
  return { state: { ...state, rows: replaced(state.rows, state.tab, row) }, effect: focusOf(q, row) };
}

/** Tab and Shift-Tab change question; past the last one the focus goes on to the actions, before the first it leaves. */
function tabKey(request: AskUserRequest, state: CardState, shift: boolean): Step | undefined {
  if (shift) return state.tab === 0 ? undefined : toTab(request, state, state.tab - 1);
  return state.tab === request.questions.length - 1 ? { state, effect: { focus: 'actions' } } : toTab(request, state, state.tab + 1);
}

/** The card's keyboard map. Undefined leaves the key to the browser, such as typing in the Other field. */
export function onKey(request: AskUserRequest, state: CardState, { key, shift, inField, caretAtStart }: Key): Step | undefined {
  const q = request.questions[state.tab]!;
  if (key === 'Escape') return { state, effect: { cancel: true } };
  if (key === 'Tab') return tabKey(request, state, shift);
  if (inField) {
    if (key === 'Enter' && !shift) return commit(request, state);
    if (key === 'ArrowUp' && caretAtStart) return move(request, state, -1);
    return undefined;
  }
  const row = state.rows[state.tab]!;
  switch (key) {
    case 'ArrowDown':
      return move(request, state, 1);
    case 'ArrowUp':
      return move(request, state, -1);
    case 'ArrowRight':
      return state.tab === request.questions.length - 1 ? { state, effect: focusOf(q, row) } : toTab(request, state, state.tab + 1);
    case 'ArrowLeft':
      return toTab(request, state, Math.max(0, state.tab - 1));
    case ' ':
      return { state: pick(request, state, row), effect: focusOf(q, row) };
    case 'Enter':
      return commit(request, q.multiSelect ? state : pick(request, state, row));
  }
  const digit = /^[1-9]$/.test(key) ? Number(key) - 1 : -1;
  if (digit < 0 || digit > otherRow(q)) return undefined;
  const picked = pick(request, state, digit);
  if (digit === otherRow(q)) return { state: picked, effect: { focus: 'other' } };
  return q.multiSelect ? { state: picked, effect: { focus: 'row' } } : advance(request, picked);
}

/** A click picks a row. A card of one single-select question is answered by that click, as U13's card was. */
export function clickRow(request: AskUserRequest, state: CardState, row: number): Step {
  const q = request.questions[state.tab]!;
  const next = pick(request, state, row);
  if (row !== otherRow(q) && request.questions.length === 1 && !q.multiSelect) return { state: next, effect: { submit: true } };
  return { state: next, effect: focusOf(q, row) };
}

const words = (answer: QuestionAnswer | undefined): string => [...(answer?.picked ?? []), ...(answer?.other === undefined ? [] : [answer.other])].join(', ');

/** The one line an answered card folds into. */
export function settledLine({ questions }: AskUserRequest, answers: AskUserAnswers): string {
  if (questions.length === 1) return `Answered: ${words(answers[questions[0]!.id])}`;
  const named = questions.filter((q) => answers[q.id] !== undefined);
  return `Answered ${named.length} question${named.length === 1 ? '' : 's'}: ${named.map((q) => q.header).join(', ')}`;
}

/** One answer as the opened card lists it. */
export const answerWords = (answer: QuestionAnswer | undefined): string => (answer === undefined ? 'No answer' : words(answer));
