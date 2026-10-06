import { describe, expect, it } from 'vitest';
import { isWithUser, needsYouCount, placeTask, placeTasks, returnedAtOf, type Attention, type TaskRecord, type Waiting } from '../src/index.js';

const task = (patch: Partial<TaskRecord> = {}): TaskRecord => ({
  sessionId: 's1',
  title: 'Fix the header',
  workspace: '/repo',
  lane: null,
  status: 'running',
  startedAt: 100,
  endedAt: null,
  ...patch,
});

const held: Waiting = { kind: 'limited', since: 100, retryAt: null, resetAt: 9_000_000, message: '429' };
const resuming: Waiting = { kind: 'limited', since: 100, retryAt: 400, resetAt: 400, message: '429' };
const offline: Waiting = { kind: 'offline', since: 100, retryAt: 300, resetAt: null, message: 'fetch failed' };

describe('placeTask, one task alone', () => {
  const rows: readonly (readonly [string, Partial<TaskRecord>, number | undefined, Attention])[] = [
    ['a permission card', { status: 'needs-input', asking: 'permission', returnedAt: 200 }, undefined, { kind: 'needs-you', reason: 'permission', at: 's1' }],
    ['an ask_user question', { status: 'needs-input', asking: 'question', returnedAt: 200 }, undefined, { kind: 'needs-you', reason: 'question', at: 's1' }],
    ['a card the user already looked at', { status: 'needs-input', asking: 'permission', returnedAt: 200 }, 900, { kind: 'needs-you', reason: 'permission', at: 's1' }],
    ['a card from an engine before U43', { status: 'needs-input' }, undefined, { kind: 'needs-you', reason: 'permission', at: 's1' }],
    ['a failure not opened', { status: 'failed', endedAt: 200, returnedAt: 200 }, undefined, { kind: 'needs-you', reason: 'failed', at: 's1' }],
    ['a failure opened since', { status: 'failed', endedAt: 200, returnedAt: 200 }, 250, { kind: 'done' }],
    ['a failure opened before it failed', { status: 'failed', endedAt: 200, returnedAt: 200 }, 150, { kind: 'needs-you', reason: 'failed', at: 's1' }],
    ['a limit held for Retry now', { status: 'waiting', waiting: held, returnedAt: 200 }, undefined, { kind: 'needs-you', reason: 'limited', at: 's1' }],
    ['a limit that resumes by itself', { status: 'waiting', waiting: resuming }, undefined, { kind: 'working' }],
    ['an offline wait', { status: 'waiting', waiting: offline }, undefined, { kind: 'working' }],
    ['a running turn', { status: 'running' }, undefined, { kind: 'working' }],
    ['a finish not opened', { status: 'done', endedAt: 200, returnedAt: 200 }, undefined, { kind: 'ready' }],
    ['a finish opened before it finished', { status: 'done', endedAt: 200, returnedAt: 200 }, 199, { kind: 'ready' }],
    ['a finish opened since', { status: 'done', endedAt: 200, returnedAt: 200 }, 200, { kind: 'done' }],
    ['a stop, which the user made', { status: 'stopped', endedAt: 200, returnedAt: 200 }, undefined, { kind: 'done' }],
  ];
  it.each(rows)('%s', (_, patch, seenAt, attention) => {
    expect(placeTask({ task: task(patch), children: [], seenAt }).attention).toEqual(attention);
  });
});

describe('placeTask, rolling children up', () => {
  const parent = task({ sessionId: 'p', status: 'running' });
  const child = (patch: Partial<TaskRecord>) => task({ sessionId: 'c', parent: 'p', kind: 'subagent', ...patch });
  const rows: readonly (readonly [string, TaskRecord, readonly TaskRecord[], Attention])[] = [
    ['a subagent asking puts its parent in Needs you, answered on the parent', parent, [child({ status: 'needs-input', asking: 'permission' })], { kind: 'needs-you', reason: 'permission', at: 'p' }],
    ['an Arena lane asking is answered in the lane', task({ sessionId: 'arena-1', kind: 'arena' }), [child({ kind: 'session', status: 'needs-input', asking: 'question' })], { kind: 'needs-you', reason: 'question', at: 'c' }],
    ['a child held at a limit', parent, [child({ status: 'waiting', waiting: held })], { kind: 'needs-you', reason: 'limited', at: 'p' }],
    ['a child that failed leaves its running parent working', parent, [child({ status: 'failed', endedAt: 150 })], { kind: 'working' }],
    ['a running child keeps a finished parent working', task({ sessionId: 'p', status: 'done', endedAt: 150 }), [child({ status: 'running' })], { kind: 'working' }],
    ['a child question outranks the parent failing', task({ sessionId: 'p', status: 'failed', endedAt: 150 }), [child({ status: 'needs-input', asking: 'question' })], { kind: 'needs-you', reason: 'question', at: 'p' }],
    ['the parent asking outranks a child held at a limit', task({ sessionId: 'p', status: 'needs-input', asking: 'permission' }), [child({ status: 'waiting', waiting: held })], { kind: 'needs-you', reason: 'permission', at: 'p' }],
    ['finished children of a finished parent', task({ sessionId: 'p', status: 'done', endedAt: 300 }), [child({ status: 'done', endedAt: 200 })], { kind: 'ready' }],
  ];
  it.each(rows)('%s', (_, root, children, attention) => {
    expect(placeTask({ task: root, children, seenAt: undefined }).attention).toEqual(attention);
  });

  it('comes back when its latest child did', () => {
    const placed = placeTask({ task: task({ sessionId: 'p', status: 'needs-input', returnedAt: 200 }), children: [child({ status: 'done', endedAt: 500, returnedAt: 500 })], seenAt: undefined });
    expect(placed.returnedAt).toBe(500);
  });
});

describe('placeTasks', () => {
  it('orders the sections, the reasons in Needs you, then the newest return first', () => {
    const tasks = [
      task({ sessionId: 'done-seen', status: 'done', endedAt: 900, returnedAt: 900 }),
      task({ sessionId: 'working-old', status: 'running', returnedAt: 100 }),
      task({ sessionId: 'limited', status: 'waiting', waiting: held, returnedAt: 950 }),
      task({ sessionId: 'ready', status: 'done', endedAt: 800, returnedAt: 800 }),
      task({ sessionId: 'failed', status: 'failed', endedAt: 700, returnedAt: 700 }),
      task({ sessionId: 'question-old', status: 'needs-input', asking: 'question', returnedAt: 300 }),
      task({ sessionId: 'working-new', status: 'waiting', waiting: offline, returnedAt: 600 }),
      task({ sessionId: 'permission-new', status: 'needs-input', asking: 'permission', returnedAt: 400 }),
      task({ sessionId: 'stopped', status: 'stopped', endedAt: 1000, returnedAt: 1000 }),
    ];
    const placed = placeTasks(tasks, { 'done-seen': 950 });
    expect(placed.map((p) => p.task.sessionId)).toEqual(['permission-new', 'question-old', 'failed', 'limited', 'ready', 'working-new', 'working-old', 'stopped', 'done-seen']);
    expect(needsYouCount(placed)).toBe(4);
  });

  it('lists children under their parent only, and an orphan on its own', () => {
    const tasks = [
      task({ sessionId: 'p', status: 'running' }),
      task({ sessionId: 'c', parent: 'p', kind: 'subagent', status: 'needs-input', asking: 'permission', returnedAt: 300 }),
      task({ sessionId: 'lane', parent: 'arena-gone', status: 'done', endedAt: 200, returnedAt: 200 }),
    ];
    const placed = placeTasks(tasks, {});
    expect(placed.map((p) => [p.task.sessionId, p.children.map((c) => c.sessionId), p.attention.kind])).toEqual([
      ['p', ['c'], 'needs-you'],
      ['lane', [], 'ready'],
    ]);
  });
});

describe('returnedAtOf', () => {
  it('stamps the moment a task becomes the user’s turn, and keeps it while it stays so', () => {
    const running = task({ returnedAt: 50 });
    const asking = task({ status: 'needs-input', returnedAt: 50 });
    expect(returnedAtOf(running, asking, 200)).toBe(200);
    expect(returnedAtOf({ ...asking, returnedAt: 200 }, { ...asking, title: 'Renamed' }, 250)).toBe(200);
    expect(returnedAtOf({ ...asking, returnedAt: 200 }, task({ status: 'failed', endedAt: 300 }), 300)).toBe(300);
    expect(returnedAtOf({ ...asking, returnedAt: 200 }, running, 400)).toBe(200);
    expect(returnedAtOf(undefined, running, 100)).toBeNull();
    expect(returnedAtOf(running, task({ status: 'waiting', waiting: offline }), 200)).toBe(50);
    expect(returnedAtOf(running, task({ status: 'waiting', waiting: held }), 200)).toBe(200);
  });

  it('counts a held limit as the user’s turn, and a wait that resumes by itself as work', () => {
    expect(isWithUser(task({ status: 'waiting', waiting: held }))).toBe(true);
    expect(isWithUser(task({ status: 'waiting', waiting: resuming }))).toBe(false);
    expect(isWithUser(task({ status: 'stopped' }))).toBe(true);
  });
});
