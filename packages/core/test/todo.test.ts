import { describe, expect, it } from 'vitest';
import {
  AGENT_PROMPTS,
  MODE_NOTICES,
  AGENT_MODE_TOOLS,
  asSessionId,
  CHILD_TOOL_NAMES,
  cutView,
  forkEvents,
  parseTodo,
  TODO_LIMITS,
  todoLine,
  todoOf,
  todoResult,
  type Session,
  type TodoList,
  type TodoStatus,
  type TurnEvent,
} from '../src/index.js';

const at = '2026-10-07T00:00:01.000Z';
const session: Session = { id: asSessionId('s1'), createdAt: at, workspace: '/tmp/ws', provider: 'modelstudio', model: 'qwen3.8-flash', effort: 'medium' };
const item = (id: string, status: TodoStatus, text = `step ${id}`) => ({ id, text, status });
const many = (n: number) => Array.from({ length: n }, (_, i) => item(String(i + 1), 'pending'));

describe('parseTodo', () => {
  const refusals: readonly [string, unknown, RegExp][] = [
    ['no items', {}, /items array/],
    ['items not an array', { items: 'a' }, /items array/],
    ['an unknown field', { items: [], note: 'x' }, /unknown field "note"/],
    ['one item over the cap', { items: many(TODO_LIMITS.items + 1) }, /31 items; keep it to at most 30/],
    ['two items in progress', { items: [item('a', 'in_progress'), item('b', 'done'), item('c', 'in_progress')] }, /2 items are in_progress \(a, c\)/],
    ['an id used twice', { items: [item('a', 'pending'), item('a', 'done')] }, /"a" is used twice/],
    ['an empty id', { items: [item(' ', 'pending')] }, /item 1 needs an id/],
    ['empty text', { items: [item('a', 'pending', '  ')] }, /item 1 needs its text/],
    ['text too long', { items: [item('a', 'pending', 'x'.repeat(TODO_LIMITS.text + 1))] }, /longer than 200/],
    ['an unknown status', { items: [item('a', 'pending'), { id: 'b', text: 'b', status: 'blocked' }] }, /item 2's status/],
    ['an item that is not an object', { items: ['write tests'] }, /item 1 must be an object/],
  ];
  it.each(refusals)('refuses %s', (_name, raw, problem) => {
    const parsed = parseTodo(raw);
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(parsed.problem).toMatch(problem);
  });

  const accepted: readonly [string, unknown, TodoList][] = [
    ['an empty list, which clears it', { items: [] }, []],
    ['exactly the cap', { items: many(TODO_LIMITS.items) }, many(TODO_LIMITS.items)],
    ['one item in progress', { items: [item('a', 'done'), item('b', 'in_progress'), item('c', 'pending')] }, [item('a', 'done'), item('b', 'in_progress'), item('c', 'pending')]],
    ['none in progress', { items: [item('a', 'done'), item('b', 'pending')] }, [item('a', 'done'), item('b', 'pending')]],
    ['padded ids and text, trimmed', { items: [{ id: ' a ', text: ' Write tests ', status: 'pending' }] }, [item('a', 'pending', 'Write tests')]],
  ];
  it.each(accepted)('keeps %s', (_name, raw, list) => {
    expect(parseTodo(raw)).toEqual({ ok: true, value: list });
  });
});

describe('the list in words', () => {
  const lines: readonly [string, TodoList, string, string][] = [
    ['nothing started', [item('a', 'pending'), item('b', 'pending')], '0 of 2 done', 'Updated the todo list: 0 of 2 done.'],
    ['one in progress', [item('a', 'done'), item('b', 'in_progress', 'Write tests'), item('c', 'pending')], '1 of 3 done · write tests', 'Updated the todo list: 1 of 3 done, "Write tests" in progress.'],
    ['an acronym keeps its capitals', [item('a', 'in_progress', 'README update')], '0 of 1 done · README update', 'Updated the todo list: 0 of 1 done, "README update" in progress.'],
    ['all done', [item('a', 'done'), item('b', 'done')], '2 of 2 done', 'Updated the todo list: 2 of 2 done.'],
    ['cleared', [], '0 of 0 done', 'Cleared the todo list.'],
  ];
  it.each(lines)('%s', (_name, list, line, result) => {
    expect(todoLine(list)).toBe(line);
    expect(todoResult(list)).toBe(result);
  });
});

const start: TurnEvent = { kind: 'session-start', session };
const user = (seq: number, content: string): TurnEvent => ({ kind: 'user', seq, at, content });
const call = (seq: number, id: string, name = 'todo'): TurnEvent => ({
  kind: 'assistant',
  seq,
  at,
  content: [{ type: 'tool_use', id, name, input: {}, caller: { type: 'direct' } }],
  stopReason: 'tool_use',
  usage: { input: 1, cacheRead: 0, cacheWrite: 0, output: 1 },
  costUsd: 0.01,
  latencyMs: 1,
  model: 'qwen3.8-flash',
});
const set = (seq: number, toolUseId: string, todo: TodoList): TurnEvent => ({ kind: 'tool-result', seq, at, toolUseId, name: 'todo', status: 'ok', output: todoResult(todo), todo });
const refused = (seq: number, toolUseId: string): TurnEvent => ({ kind: 'tool-result', seq, at, toolUseId, name: 'todo', status: 'error', output: '2 items are in_progress' });
const ran = (seq: number, toolUseId: string): TurnEvent => ({ kind: 'tool-result', seq, at, toolUseId, name: 'bash', status: 'ok', output: 'ok' });
const cut = (seq: number, turnSeq: number): TurnEvent => ({ kind: 'cut', seq, at, turnSeq });

const planned = [item('1', 'pending'), item('2', 'pending'), item('3', 'pending')];
const started = [item('1', 'in_progress'), item('2', 'pending'), item('3', 'pending')];
const halfway = [item('1', 'done'), item('2', 'in_progress'), item('3', 'pending')];

/** Turn 1 (seq 1) plans the list. Turn 2 (seq 4) starts it, runs a command, and gets one call refused. Turn 3 (seq 11) moves on. */
const log: readonly TurnEvent[] = [
  start,
  user(1, 'plan it'),
  call(2, 't1'),
  set(3, 't1', planned),
  user(4, 'start building'),
  call(5, 't2'),
  set(6, 't2', started),
  call(7, 'b1', 'bash'),
  ran(8, 'b1'),
  call(9, 't3'),
  refused(10, 't3'),
  user(11, 'go on'),
  call(12, 't4'),
  set(13, 't4', halfway),
];

describe('todoOf, replaying the log', () => {
  const replays: readonly [string, readonly TurnEvent[], TodoList][] = [
    ['a session with no calls', [start, user(1, 'hi')], []],
    ['the whole log, the last call winning', log, halfway],
    ['up to turn 1', log.slice(0, 4), planned],
    ['a refused call, which leaves the list as it was', log.slice(0, 11), started],
    ['a later call that clears it', [...log, call(14, 't5'), set(15, 't5', [])], []],
  ];
  it.each(replays)('%s', (_name, events, list) => {
    expect(todoOf(events)).toEqual(list);
  });

  it('a cut takes the list back to before the cut turn, and a call after it starts from there', () => {
    expect(todoOf(cutView([...log, cut(14, 11)]))).toEqual(started);
    expect(todoOf(cutView([...log, cut(14, 4)]))).toEqual(planned);
    expect(todoOf(cutView([...log, cut(14, 1)]))).toEqual([]);
    const after = [...log, cut(14, 11), user(15, 'again'), call(16, 't6'), set(17, 't6', halfway)];
    expect(todoOf(cutView(after))).toEqual(halfway);
  });

  it('a fork copies the list as it stood after the turn it forks at', () => {
    const fork = { id: asSessionId('s2'), createdAt: at, title: 'plan it' };
    expect(todoOf(forkEvents(log, 4, fork) ?? [])).toEqual(started);
    expect(todoOf(forkEvents(log, 1, fork) ?? [])).toEqual(planned);
    expect(todoOf(forkEvents(log, 11, fork) ?? [])).toEqual(halfway);
  });
});

describe('where todo is offered', () => {
  it('Plan offers it, so the plan is the first list, and a subagent does not', () => {
    for (const mode of ['plan', 'ask', 'auto', 'non-interactive'] as const) expect(AGENT_MODE_TOOLS[mode]).toContain('todo');
    expect(CHILD_TOOL_NAMES).not.toContain('todo');
  });

  it("Plan's notice asks for the plan as a todo list, and the system prompts and the other modes' notices do not mention it", () => {
    expect(MODE_NOTICES.plan).toMatch(/todo tool/);
    for (const text of [...Object.values(AGENT_PROMPTS), MODE_NOTICES.ask, MODE_NOTICES.auto]) expect(text).not.toMatch(/todo tool/);
  });
});
