import type * as acp from '@agentclientprotocol/sdk';
import { describe, expect, it } from 'vitest';
import { TODO_META, type TodoList, type TodoStatus } from '@g-code/core';
import { activityOf, NO_BACKGROUND, type Background } from '../src/chat/activity-model.js';
import { shownSteps, summaryLine, summaryOf } from '../src/chat/fold.js';
import type { Action, Transcript } from '../src/chat/messages.js';
import { railOf, type Step } from '../src/chat/rail.js';
import { todoOfUpdate } from '../src/chat/todo-model.js';
import { emptyTranscript, reduce } from '../src/chat/transcript.js';

const list = (...statuses: TodoStatus[]): TodoList => statuses.map((status, i) => ({ id: String(i + 1), text: ['Read the code', 'Write tests', 'Run them'][i]!, status }));
const run = (actions: readonly Action[], start: Transcript = emptyTranscript('qwen3.8-flash')): Transcript => actions.reduce(reduce, start);
const start = (id: string): Action => ({ type: 'turn-start', id, at: 1000, prompt: 'p' });
const end: Action = { type: 'turn-end', at: 9000, status: 'done', usage: undefined };
const todoCall = (id: string, todo: TodoList | undefined, status: 'running' | 'completed' | 'failed' = 'completed'): Action => ({
  type: 'tool',
  id,
  at: 2000,
  name: 'todo',
  target: '',
  toolKind: 'other',
  status,
  ...(todo === undefined ? {} : { todo }),
});
const call = (id: string, name: string, status: 'running' | 'completed' = 'completed'): Action => ({ type: 'tool', id, at: 2000, name, target: 'a.ts', toolKind: name === 'read' ? 'read' : 'search', status });
const names = (steps: readonly Step[]) => steps.map((s) => (s.kind === 'todo' ? `todo:${s.pinned ? 'pinned' : 'kept'}` : s.kind === 'calls' ? `calls:${s.name}` : s.kind));

describe('where the list stands on the rail', () => {
  it('pins the running turn\'s list just above its latest step, and no todo call shows as a call', () => {
    const t = run([start('t1'), todoCall('d1', list('in_progress', 'pending', 'pending')), call('g1', 'grep'), { type: 'text', text: 'Found it.' }, todoCall('d2', list('done', 'in_progress', 'pending')), call('r1', 'read', 'running')]);
    const rail = railOf(t.turns[0]!);
    expect(names(rail)).toEqual(['calls:grep', 'text', 'todo:pinned', 'calls:read']);
    expect(rail.find((s) => s.kind === 'todo')).toMatchObject({ list: list('done', 'in_progress', 'pending') });
  });

  it('moves down as steps arrive, staying above the thinking step', () => {
    const t = run([start('t1'), todoCall('d1', list('in_progress', 'pending', 'pending')), call('g1', 'grep')]);
    expect(names(railOf(t.turns[0]!))).toEqual(['calls:grep', 'todo:pinned', 'thinking']);
  });

  it('keeps the list where it last changed once the turn ends, not where it was first set', () => {
    const t = run([start('t1'), todoCall('d1', list('in_progress', 'pending', 'pending')), call('g1', 'grep'), todoCall('d2', list('done', 'done', 'done')), { type: 'text', text: 'All done.' }, end]);
    const rail = railOf(t.turns[0]!);
    expect(names(rail)).toEqual(['calls:grep', 'todo:kept', 'text']);
    expect(rail[1]).toMatchObject({ list: list('done', 'done', 'done') });
  });

  it("pins the plan's list in the next turn before any call, as Start building runs it", () => {
    const t = run([start('t2'), call('r1', 'read', 'running')]);
    expect(names(railOf(t.turns[0]!, list('pending', 'pending', 'pending')))).toEqual(['todo:pinned', 'calls:read']);
    expect(names(railOf(t.turns[0]!, list('done', 'done', 'done'))), 'a finished list from an earlier turn is not pinned').toEqual(['calls:read']);
  });

  it('shows a refused call as a failed call, and a cleared list as nothing', () => {
    const refused = run([start('t1'), todoCall('d1', undefined, 'failed'), end]);
    expect(names(railOf(refused.turns[0]!))).toEqual(['calls:todo']);
    const cleared = run([start('t1'), todoCall('d1', list('done')), todoCall('d2', []), call('g1', 'grep', 'running')]);
    expect(names(railOf(cleared.turns[0]!))).toEqual(['calls:grep']);
  });

  it('keeps the list in view in compact detail, and leaves its calls out of the summary', () => {
    const t = run([start('t1'), todoCall('d1', list('in_progress', 'pending')), call('g1', 'grep'), call('g2', 'grep'), todoCall('d2', list('done', 'done')), { type: 'text', text: 'Done.' }, end]);
    expect(summaryLine(summaryOf(t.turns[0]!))).toBe('Searched 2 times');
    expect(names(shownSteps(t.turns[0]!, 'compact', false))).toEqual(['fold', 'todo:kept', 'text']);
  });
});

describe('the list from the engine', () => {
  const update = (meta: unknown): acp.SessionUpdate => ({ sessionUpdate: 'tool_call_update', toolCallId: 'd1', status: 'completed', _meta: { [TODO_META]: meta } });
  it('reads the list a result carries and refuses one that breaks the rules', () => {
    expect(todoOfUpdate(update({ items: list('done', 'in_progress') }))).toEqual(list('done', 'in_progress'));
    expect(todoOfUpdate(update({ items: list('in_progress', 'in_progress') }))).toBeUndefined();
    expect(todoOfUpdate({ sessionUpdate: 'tool_call_update', toolCallId: 'r1' })).toBeUndefined();
  });
});

describe("the composer's label", () => {
  const busy: Background = { ...NO_BACKGROUND, shown: 'here', tasks: [{ sessionId: 'lane', title: 'Fix the header', workspace: '/repo', lane: 'fix-header', status: 'running', startedAt: 1, endedAt: null }] };
  it('names the item in progress while the chat runs and nothing needs the user', () => {
    const t = run([start('t1'), todoCall('d1', list('done', 'in_progress', 'pending')), call('g1', 'grep', 'running')]);
    expect(activityOf(t, busy)?.label).toEqual({ text: 'Write tests', tone: 'working' });
    const none = run([start('t1'), call('g1', 'grep', 'running')]);
    expect(activityOf(none, busy)?.label?.text, 'with no list it names the latest step').toMatch(/^Searching for/);
  });
});
