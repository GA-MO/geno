import { SUBAGENT_META } from '@g-code/core';
import { describe, expect, it } from 'vitest';
import { composerView, NO_FACTS } from '../src/chat/composer-model.js';
import type { Action, Transcript } from '../src/chat/messages.js';
import { nodeOf, railOf } from '../src/chat/rail.js';
import { isChildAction, subagentAction } from '../src/chat/subagent-host.js';
import { childOf, emptyTranscript, reduce, runningChildren } from '../src/chat/transcript.js';

const run = (actions: readonly Action[], start: Transcript = emptyTranscript('qwen3.8-flash')): Transcript => actions.reduce(reduce, start);

const T0 = 1_000_000;
const parent: Action[] = [
  { type: 'turn-start', id: 't1', at: T0, prompt: 'Where are alpha and beta?' },
  { type: 'tool', id: 'tu_a', at: T0 + 10, name: 'agent', target: 'explore: where is alpha', toolKind: 'other', status: 'running' },
  { type: 'tool', id: 'tu_b', at: T0 + 10, name: 'agent', target: 'explore: where is beta', toolKind: 'other', status: 'running' },
];
const startChild = (id: string, toolId: string, at = T0 + 20): Action => ({ type: 'child-start', id, toolId, role: 'explore', task: `find ${id}`, model: 'qwen3.8-flash', at });

describe('children in the transcript', () => {
  it('nests each child under the agent call that started it, and builds its own turn from its stream', () => {
    const t = run([
      ...parent,
      startChild('c_a', 'tu_a'),
      startChild('c_b', 'tu_b'),
      { type: 'child', id: 'c_a', action: { type: 'tool', id: 'g1', at: T0 + 30, name: 'grep', target: 'alpha', toolKind: 'search', status: 'running' } },
      { type: 'child', id: 'c_a', action: { type: 'text', text: 'a.ts:1' } },
    ]);
    const steps = railOf(t.turns[0]!);
    expect(steps.map((s) => (s.kind === 'agent' ? [s.kind, s.tool.id, s.children.map((c) => c.id)] : [s.kind]))).toEqual([
      ['agent', 'tu_a', ['c_a']],
      ['agent', 'tu_b', ['c_b']],
    ]);
    const a = childOf(t, 'c_a')!;
    expect(a.turn.prompt).toBe('find c_a');
    expect(a.turn.blocks.map((b) => b.kind)).toEqual(['tool', 'text']);
    expect(t.turns[0]!.blocks.map((b) => b.kind), "a child's work stays out of the parent's blocks").toEqual(['tool', 'tool']);
    expect(runningChildren(t).map((c) => c.id)).toEqual(['c_a', 'c_b']);
  });

  it('keeps an agent step live while its child runs, after the call itself reported back', () => {
    const t = run([...parent.slice(0, 2), startChild('c_a', 'tu_a'), { type: 'tool', id: 'tu_a', at: T0 + 40, status: 'completed' }]);
    expect(nodeOf(railOf(t.turns[0]!)[0]!)).toBe('live');
    const ended = run([{ type: 'child-end', id: 'c_a', at: T0 + 50, end: { kind: 'done' }, turns: 2, costUsd: 0.001 }], t);
    expect(nodeOf(railOf(ended.turns[0]!)[0]!)).toBe('done');
  });

  it("ends a child once, with its turns, cost and its own turn's status", () => {
    const t = run([
      ...parent,
      startChild('c_a', 'tu_a'),
      { type: 'child-end', id: 'c_a', at: T0 + 500, end: { kind: 'cancelled' }, turns: 1, costUsd: 0.0004 },
      { type: 'child-end', id: 'c_a', at: T0 + 900, end: { kind: 'done' }, turns: 3, costUsd: 0.002 },
    ]);
    const a = childOf(t, 'c_a')!;
    expect(a).toMatchObject({ status: { kind: 'cancelled' }, endedAt: T0 + 500, turns: 1, costUsd: 0.0004 });
    expect(a.turn).toMatchObject({ status: 'stopped', endedAt: T0 + 500 });
    expect(runningChildren(t)).toEqual([]);
  });

  it('cancels a child still running when its parent turn ends', () => {
    const t = run([...parent, startChild('c_a', 'tu_a'), { type: 'turn-end', at: T0 + 700, status: 'stopped', usage: undefined }]);
    expect(childOf(t, 'c_a')).toMatchObject({ status: { kind: 'cancelled' }, endedAt: T0 + 700 });
  });

  it('starts a child once, however often it is announced', () => {
    const once = run([...parent, startChild('c_a', 'tu_a')]);
    expect(run([startChild('c_a', 'tu_a', T0 + 999)], once)).toBe(once);
  });
});

describe('the agents pill', () => {
  const view = (t: Transcript, now: number) => composerView({ transcript: t, facts: NO_FACTS, mcp: { kind: 'loading' }, queued: undefined, now });

  it('shows only while a child runs, with the count of running children', () => {
    expect(view(run(parent), T0 + 1000).running?.agents).toBeUndefined();
    const one = run([...parent, startChild('c_a', 'tu_a')]);
    expect(view(one, T0 + 5020).running?.agents).toEqual({
      count: 1,
      noun: 'agent',
      title: '1 agent running: explore',
      children: [{ id: 'c_a', role: 'explore', model: 'qwen3.8-flash', elapsed: '0:05' }],
    });
    const two = run([startChild('c_b', 'tu_b')], one);
    expect(view(two, T0 + 5020).running?.agents).toMatchObject({ count: 2, noun: 'agents', title: '2 agents running: explore, explore' });
    const back = run([{ type: 'child-end', id: 'c_a', at: T0 + 3000, end: { kind: 'done' }, turns: 1, costUsd: 0 }], two);
    expect(view(back, T0 + 5020).running?.agents?.children.map((c) => c.id)).toEqual(['c_b']);
    const none = run([{ type: 'child-end', id: 'c_b', at: T0 + 3000, end: { kind: 'capped', cap: 'turns' }, turns: 4, costUsd: 0.01 }], back);
    expect(view(none, T0 + 5020).running?.agents).toBeUndefined();
  });
});

describe('subagent_update', () => {
  const notice = { sessionId: 'p1', child: 'c_a', toolUseId: 'tu_a', role: 'explore', task: 'where is alpha', model: 'qwen3.8-flash', effort: 'low', caps: { maxTurns: 4, maxCostUsd: 0.02 }, turns: 0, costUsd: 0 };
  const update = (status: unknown, more = {}) => ({ sessionUpdate: 'subagent_update' as const, sessionId: 'c_a', _meta: { [SUBAGENT_META]: { ...notice, status, ...more } } });

  it('starts a child on running and ends it on any other status, from the notice under _meta', () => {
    expect(subagentAction(update({ kind: 'running' }), 5)).toEqual({ type: 'child-start', id: 'c_a', toolId: 'tu_a', role: 'explore', task: 'where is alpha', model: 'qwen3.8-flash', at: 5 });
    expect(subagentAction(update({ kind: 'capped', cap: 'cost' }, { turns: 2, costUsd: null }), 9)).toEqual({ type: 'child-end', id: 'c_a', at: 9, end: { kind: 'capped', cap: 'cost' }, turns: 2, costUsd: null });
  });

  it('drops an update whose notice it cannot read', () => {
    expect(subagentAction({ sessionUpdate: 'subagent_update', sessionId: 'c_a' }, 1)).toBeUndefined();
    expect(subagentAction(update({ kind: 'exploded' }), 1)).toBeUndefined();
  });

  it("lets a child's stream add text, notices, calls and diffs, and nothing else", () => {
    expect(isChildAction({ type: 'text', text: 'x' })).toBe(true);
    expect(isChildAction({ type: 'turn-end', at: 0, status: 'done', usage: undefined })).toBe(false);
    expect(isChildAction(undefined)).toBe(false);
  });
});
