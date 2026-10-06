import { describe, expect, it } from 'vitest';
import { AUTO_START, CLASSIFIER_OUTCOMES, nextAutoState, type AutoEvent, type AutoState } from '../src/auto.js';

const classifying = (row: number, total: number): AutoState => ({ phase: 'classifying', row, total });
const paused = (total: number): AutoState => ({ phase: 'paused', total });

const TRANSITIONS: readonly [name: string, from: AutoState, event: AutoEvent, to: AutoState][] = [
  ['a first block counts in the row and the total', AUTO_START, 'block', classifying(1, 1)],
  ['a second block in a row still classifies', classifying(1, 1), 'block', classifying(2, 2)],
  ['the third block in a row pauses Auto and keeps the total', classifying(2, 7), 'block', paused(8)],
  ['the twentieth block pauses Auto and starts the total over', classifying(0, 19), 'block', paused(0)],
  ['the twentieth block starts the total over even when it is also third in a row', classifying(2, 19), 'block', paused(0)],
  ['a classifier allow ends the row but keeps the total', classifying(2, 5), 'run', classifying(0, 5)],
  ['a classifier refusal neither counts nor ends the row', classifying(2, 5), 'refuse', classifying(2, 5)],
  ['a user approval ends the row but keeps the total', classifying(2, 5), 'user-allow', classifying(0, 5)],
  ['a user rejection changes nothing', classifying(2, 5), 'user-reject', classifying(2, 5)],
  ['a user approval resumes a paused Auto', paused(8), 'user-allow', classifying(0, 8)],
  ['a user rejection keeps Auto paused', paused(8), 'user-reject', paused(8)],
  ['a classifier allow keeps Auto paused until the user allows something', paused(8), 'run', paused(8)],
  ['a classifier refusal keeps Auto paused', paused(8), 'refuse', paused(8)],
];

describe('nextAutoState', () => {
  it.each(TRANSITIONS)('%s', (_name, from, event, to) => {
    expect(nextAutoState(from, event)).toEqual(to);
  });

  it('blocks three in a row silently, asks on the fourth, and blocks silently again after the user allows one', () => {
    let state = AUTO_START;
    const outcomes: string[] = [];
    const flagged = (verdict: 'allow' | 'ask', answer: AutoEvent = 'user-allow') => {
      const outcome = CLASSIFIER_OUTCOMES[state.phase][verdict];
      outcomes.push(outcome);
      state = nextAutoState(state, outcome === 'ask-user' ? answer : outcome);
    };
    for (const verdict of ['allow', 'allow', 'ask', 'ask', 'ask', 'ask', 'ask'] as const) flagged(verdict);
    expect(outcomes).toEqual(['run', 'run', 'block', 'block', 'block', 'ask-user', 'block']);
  });

  it('reaches the user after 20 blocks that never come three in a row', () => {
    let state = AUTO_START;
    let asked = 0;
    for (let i = 0; i < 42; i++) {
      const verdict = i % 2 === 0 ? 'ask' : 'allow';
      const outcome = CLASSIFIER_OUTCOMES[state.phase][verdict];
      if (outcome === 'ask-user') asked++;
      state = nextAutoState(state, outcome === 'ask-user' ? 'user-allow' : outcome);
    }
    expect(asked).toBe(1);
  });
});
