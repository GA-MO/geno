import { describe, expect, it } from 'vitest';
import type { Spinoff, SpinoffId, SpinoffShown, SpinoffState } from '@g-code/core';
import { shownSteps, summaryOf } from '../src/chat/fold.js';
import type { Action, Transcript } from '../src/chat/messages.js';
import { railOf, type Step } from '../src/chat/rail.js';
import { openSpinoffs, spinoffCardOf, spinoffsIn } from '../src/chat/spinoff-model.js';
import { emptyTranscript, reduce } from '../src/chat/transcript.js';

const run = (actions: readonly Action[], start: Transcript = emptyTranscript('qwen3.8-flash')): Transcript => actions.reduce(reduce, start);
const start = (id: string): Action => ({ type: 'turn-start', id, at: 1000, prompt: 'p' });
const end: Action = { type: 'turn-end', at: 9000, status: 'done', usage: undefined };
const spinoff = (id: string, toolUseId: string, state: SpinoffState = { kind: 'offered' }): Spinoff => ({ id: id as SpinoffId, title: `Fix ${id}`, tldr: `Saw ${id}.`, prompt: `Fix ${id} in src/a.ts.`, toolUseId, state });
const call = (id: string, name: string, shown?: SpinoffShown, status: 'running' | 'completed' | 'failed' = 'completed'): Action => ({
  type: 'tool',
  id,
  at: 2000,
  name,
  target: '',
  toolKind: name === 'read' ? 'read' : name === 'grep' ? 'search' : 'other',
  status,
  ...(shown === undefined ? {} : { spinoff: shown }),
});
const offer = (id: string, toolUseId: string): Action => call(toolUseId, 'spawn_task', { kind: 'offer', spinoff: spinoff(id, toolUseId) });
const names = (steps: readonly Step[]) => steps.map((s) => (s.kind === 'spinoff' ? `spinoff:${s.tool.spinoff.id}:${s.tool.spinoff.state.kind}` : s.kind === 'calls' ? `calls:${s.name}` : s.kind));

describe('suggestions on the rail', () => {
  it('draws an offer as its card and not as a call, and keeps a running or refused spawn_task a call', () => {
    const t = run([start('t1'), offer('task_a', 'c1'), call('c2', 'spawn_task', undefined, 'failed'), call('c3', 'spawn_task', undefined, 'running')]);
    expect(names(railOf(t.turns[0]!))).toEqual(['spinoff:task_a:offered', 'calls:spawn_task', 'calls:spawn_task']);
  });

  it("moves the card in an earlier turn when a later dismiss_task withdraws it, and the withdrawn card is gone", () => {
    const t = run([start('t1'), offer('task_a', 'c1'), offer('task_b', 'c2'), end, start('t2'), call('d1', 'dismiss_task', { kind: 'move', id: 'task_a' as SpinoffId, state: { kind: 'withdrawn' } })]);
    expect(names(railOf(t.turns[0]!))).toEqual(['spinoff:task_b:offered']);
    expect(names(railOf(t.turns[1]!))).toEqual(['calls:dismiss_task', 'thinking']);
    expect(spinoffsIn(t).map((s) => `${s.id}:${s.state.kind}`)).toEqual(['task_a:withdrawn', 'task_b:offered']);
  });

  it("folds a started card to its row and hides a dismissed one, from the user's moves", () => {
    const started: Action = { type: 'spinoff', shown: { kind: 'move', id: 'task_a' as SpinoffId, state: { kind: 'started', sessionId: 's9', lane: 'fix-task-a' } } };
    const dismissed: Action = { type: 'spinoff', shown: { kind: 'move', id: 'task_b' as SpinoffId, state: { kind: 'dismissed' } } };
    const t = run([start('t1'), offer('task_a', 'c1'), offer('task_b', 'c2'), end, started, dismissed]);
    expect(names(railOf(t.turns[0]!))).toEqual(['spinoff:task_a:started']);
    expect(openSpinoffs(t)).toEqual([]);
  });

  it('a replayed offer carries where it ended, so a reload draws it there', () => {
    const t = run([start('t1'), call('c1', 'spawn_task', { kind: 'offer', spinoff: spinoff('task_a', 'c1', { kind: 'dismissed' }) }), end]);
    expect(names(railOf(t.turns[0]!))).toEqual([]);
  });

  it('a move for an id the transcript lacks changes nothing', () => {
    const t = run([start('t1'), offer('task_a', 'c1'), end]);
    expect(reduce(t, { type: 'spinoff', shown: { kind: 'move', id: 'task_z' as SpinoffId, state: { kind: 'dismissed' } } })).toBe(t);
  });

  it('keeps the card in view in a folded compact turn, and does not count spawn_task as work', () => {
    const t = run([start('t1'), call('r1', 'read'), call('g1', 'grep'), offer('task_a', 'c1'), { type: 'text', text: 'Fixed it.' }, end]);
    expect(names(shownSteps(t.turns[0]!, 'compact', false))).toEqual(['fold', 'spinoff:task_a:offered', 'text']);
    expect(summaryOf(t.turns[0]!).kinds.other).toBe(0);
  });
});

describe('the card', () => {
  it('offers Start and Dismiss while open, shows Starting while a Start waits, and the reason one failed', () => {
    const open = spinoff('task_a', 'c1');
    expect(spinoffCardOf(open, {})).toEqual({ kind: 'open', spinoff: open, starting: false, problem: undefined });
    expect(spinoffCardOf(open, { task_a: { kind: 'starting' } })).toMatchObject({ kind: 'open', starting: true });
    expect(spinoffCardOf(open, { task_a: { kind: 'failed', message: 'not a git repository' } })).toMatchObject({ kind: 'open', starting: false, problem: 'not a git repository' });
    expect(spinoffCardOf(spinoff('task_a', 'c1', { kind: 'started', sessionId: 's9', lane: 'fix-a' }), { task_a: { kind: 'starting' } })).toMatchObject({ kind: 'started', sessionId: 's9', lane: 'fix-a' });
    expect(spinoffCardOf(spinoff('task_a', 'c1', { kind: 'withdrawn' }), {})).toEqual({ kind: 'hidden' });
  });

  it('lists the open suggestions for the Tasks pane, newest first', () => {
    const t = run([start('t1'), offer('task_a', 'c1'), end, start('t2'), offer('task_b', 'c2'), offer('task_c', 'c3'), end, { type: 'spinoff', shown: { kind: 'move', id: 'task_c' as SpinoffId, state: { kind: 'dismissed' } } }]);
    expect(openSpinoffs(t).map((s) => s.id)).toEqual(['task_b', 'task_a']);
  });
});
