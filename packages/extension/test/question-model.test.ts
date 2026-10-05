import { describe, expect, it } from 'vitest';
import type { AskUserRequest } from '@g-code/core';
import { answersOf, cardStart, clickRow, isComplete, onKey, settledLine, type CardState, type Key, type Step } from '../src/chat/question-model.js';

const REQUEST: AskUserRequest = {
  questions: [
    {
      id: 'button',
      header: 'Button',
      question: 'Which button style?',
      multiSelect: false,
      options: [
        { label: 'Solid', description: 'Filled.', recommended: true },
        { label: 'Ghost', description: 'Text only.' },
      ],
    },
    {
      id: 'targets',
      header: 'Targets',
      question: 'Which platforms?',
      multiSelect: true,
      options: [
        { label: 'Web', description: 'Browser.' },
        { label: 'Desktop', description: 'Electron.' },
        { label: 'Mobile', description: 'React Native.' },
      ],
    },
  ],
};

const key = (name: string, extra: Partial<Key> = {}): Key => ({ key: name, shift: false, inField: false, caretAtStart: false, ...extra });

/** Presses keys in turn, returning the final state and every effect along the way. */
function press(state: CardState, ...keys: (string | Key)[]): { state: CardState; effects: Step['effect'][] } {
  const effects: Step['effect'][] = [];
  for (const k of keys) {
    const step = onKey(REQUEST, state, typeof k === 'string' ? key(k) : k);
    if (step === undefined) throw new Error(`${JSON.stringify(k)} was not handled`);
    state = step.state;
    effects.push(step.effect);
  }
  return { state, effects };
}

describe('the question card model', () => {
  it('opens on the first question with the first option active, nothing answered', () => {
    const start = cardStart(REQUEST);
    expect(start).toEqual({ tab: 0, rows: [0, 0], drafts: [{ picked: [], other: '', otherOn: false }, { picked: [], other: '', otherOn: false }] });
    expect(isComplete(REQUEST, start)).toBe(false);
  });

  it('moves with up and down, changes question with left, right and Tab, and stays inside the list', () => {
    const start = cardStart(REQUEST);
    expect(press(start, 'ArrowDown').state.rows[0]).toBe(1);
    expect(press(start, 'ArrowUp').state.rows[0], 'the first row is the top').toBe(0);
    expect(press(start, 'ArrowDown', 'ArrowDown')).toMatchObject({ state: { rows: [2, 0] }, effects: [{ focus: 'row' }, { focus: 'other' }] });
    expect(press(start, 'ArrowRight').state.tab).toBe(1);
    expect(press(start, 'Tab').state.tab).toBe(1);
    expect(press(start, 'Tab', key('Tab', { shift: true })).state.tab).toBe(0);
    expect(press(start, 'ArrowLeft').state.tab).toBe(0);
    expect(onKey(REQUEST, start, key('Tab', { shift: true })), 'Shift-Tab on the first question leaves the card').toBeUndefined();
    expect(press(start, 'Tab', 'Tab').effects.at(-1), 'Tab on the last question goes to the actions').toEqual({ focus: 'actions' });
  });

  it('picks with digits: a single-select answers and moves on, a multi-select toggles', () => {
    const { state, effects } = press(cardStart(REQUEST), '2', '1', '3', '3', '3');
    expect(state.tab).toBe(1);
    expect(state.drafts[0]!.picked).toEqual(['Ghost']);
    expect(state.drafts[1]!.picked, 'Web on, Mobile on, off, on').toEqual(['Web', 'Mobile']);
    expect(effects[0]).toEqual({ focus: 'row' });
    expect(isComplete(REQUEST, state)).toBe(true);
  });

  it('toggles with Space in a multi-select, and Space picks without moving in a single-select', () => {
    const one = press(cardStart(REQUEST), 'ArrowDown', ' ');
    expect(one.state).toMatchObject({ tab: 0, drafts: [{ picked: ['Ghost'] }, {}] });
    const two = press(one.state, 'Tab', ' ', 'ArrowDown', ' ', ' ');
    expect(two.state.drafts[1]!.picked).toEqual(['Web']);
  });

  it('submits on Enter on the last question only once every question has an answer, and goes back to an unanswered one otherwise', () => {
    const unanswered = press(cardStart(REQUEST), 'Tab', ' ', 'Enter');
    expect(unanswered.state.tab, 'the first question still waits').toBe(0);
    expect(unanswered.effects.at(-1)).toEqual({ focus: 'row' });
    const done = press(unanswered.state, 'Enter', 'Enter');
    expect(done.effects.at(-1)).toEqual({ submit: true });
    expect(answersOf(REQUEST, done.state)).toEqual({ button: { picked: ['Solid'] }, targets: { picked: ['Web'] } });
  });

  it('cancels on Esc, from a row or from the Other field', () => {
    expect(press(cardStart(REQUEST), 'Escape').effects).toEqual([{ cancel: true }]);
    expect(onKey(REQUEST, cardStart(REQUEST), key('Escape', { inField: true }))?.effect).toEqual({ cancel: true });
  });

  it('leaves typing in the Other field alone, but Enter, Tab and Up at its start still steer the card', () => {
    const inField = (name: string, extra: Partial<Key> = {}) => key(name, { inField: true, ...extra });
    const start = { ...cardStart(REQUEST), rows: [2, 0] };
    for (const typing of ['a', '1', ' ', 'ArrowLeft', 'ArrowRight']) expect(onKey(REQUEST, start, inField(typing)), typing).toBeUndefined();
    expect(onKey(REQUEST, start, inField('ArrowUp', { caretAtStart: true }))?.state.rows[0], 'up from the start of the field').toBe(1);
    expect(onKey(REQUEST, start, inField('ArrowUp', { caretAtStart: false })), 'up inside the text moves the caret').toBeUndefined();
    expect(onKey(REQUEST, start, inField('Tab'))?.state.tab).toBe(1);
    expect(onKey(REQUEST, start, inField('Enter', { shift: true })), 'Shift-Enter is a new line').toBeUndefined();
  });
});

describe('typing an Other answer', () => {
  it('replaces the pick in a single-select, and joins the picks in a multi-select', async () => {
    const { typeOther } = await import('../src/chat/question-model.js');
    const picked = press(cardStart(REQUEST), ' ').state;
    const single = typeOther(REQUEST, picked, 'Pill shaped');
    expect(single.drafts[0]).toEqual({ picked: [], other: 'Pill shaped', otherOn: true });
    const multi = typeOther(REQUEST, press(single, 'Tab', ' ').state, 'a CLI');
    expect(multi.drafts[1]).toEqual({ picked: ['Web'], other: 'a CLI', otherOn: true });
    expect(answersOf(REQUEST, multi)).toEqual({ button: { picked: [], other: 'Pill shaped' }, targets: { picked: ['Web'], other: 'a CLI' } });
    expect(isComplete(REQUEST, typeOther(REQUEST, multi, '   ')), 'blank words answer nothing').toBe(true);
    expect(isComplete(REQUEST, typeOther(REQUEST, single, '  ')), 'a single-select with blank Other is unanswered').toBe(false);
    const back = press(single, '2').state;
    expect(back.drafts[0], 'picking an option turns Other off in a single-select').toEqual({ picked: ['Ghost'], other: 'Pill shaped', otherOn: false });
    expect(answersOf(REQUEST, back)['button']).toEqual({ picked: ['Ghost'] });
  });
});

describe('clicks', () => {
  it('answers a one-question single-select with one click, as U13 did, and only picks on a card of several', () => {
    const one: AskUserRequest = { questions: [REQUEST.questions[0]!] };
    expect(clickRow(one, cardStart(one), 1)).toMatchObject({ state: { drafts: [{ picked: ['Ghost'] }] }, effect: { submit: true } });
    expect(clickRow(REQUEST, cardStart(REQUEST), 1)).toMatchObject({ state: { tab: 0, drafts: [{ picked: ['Ghost'] }, {}] }, effect: { focus: 'row' } });
    const other = clickRow(REQUEST, cardStart(REQUEST), 2);
    expect(other).toMatchObject({ state: { rows: [2, 0], drafts: [{ otherOn: true }, {}] }, effect: { focus: 'other' } });
  });
});

describe('the settled line', () => {
  it('says the answer of one question, and counts and names the questions of several', () => {
    const one: AskUserRequest = { questions: [REQUEST.questions[0]!] };
    expect(settledLine(one, { button: { picked: ['Ghost'] } })).toBe('Answered: Ghost');
    expect(settledLine(one, { button: { picked: [], other: 'Pill shaped' } })).toBe('Answered: Pill shaped');
    expect(settledLine(REQUEST, { button: { picked: ['Solid'] }, targets: { picked: ['Web', 'Mobile'], other: 'a CLI' } })).toBe('Answered 2 questions: Button, Targets');
  });
});
