import { describe, expect, it } from 'vitest';
import { placeTask, TASK_NOTICES, type LaneInfo, type TaskRecord } from '@g-code/core';
import { socketPathOf } from '../src/chat/engine.js';
import { laneRowOf, markSeen, revealOf, taskRowOf, taskSections } from '../src/chat/lanes-model.js';
import { ATTENTION_NOTICES, attentionNotice, channelsOf, noticeText, osNotification } from '../src/chat/notices.js';

const lane = (patch: Partial<LaneInfo> = {}): LaneInfo => ({
  name: 'fix-login',
  path: '/repo/.geno/worktrees/fix-login',
  branch: 'geno/fix-login',
  status: 'changed',
  createdAt: '2026-10-06T00:00:00.000Z',
  diff: { files: 2, added: 12, removed: 3 },
  check: 'passed',
  session: { id: 's1', title: 'Fix the login button', turns: 1, costUsd: 0.0021 },
  task: 'done',
  ...patch,
});

const task = (patch: Partial<TaskRecord> = {}): TaskRecord => ({
  sessionId: 's1',
  title: 'Fix the login button',
  workspace: '/repo/.geno/worktrees/fix-login',
  lane: 'fix-login',
  status: 'running',
  startedAt: 1000,
  endedAt: null,
  ...patch,
});

describe('the lane view model', () => {
  it('shows a finished lane with changes as ready to open, apply, or discard after a confirm', () => {
    expect(laneRowOf(lane())).toEqual({
      name: 'fix-login',
      task: 'Fix the login button',
      state: { label: 'Done', tone: 'ok' },
      diff: '+12 −3 · 2 files',
      diffTitle: '12 lines added and 3 lines removed in 2 files',
      check: { label: 'Check passed', tone: 'ok' },
      cost: '$0.0021',
      actions: { open: true, apply: true, discard: 'confirm' },
    });
  });

  it('lets nothing touch a lane whose task still runs or waits, but still opens it', () => {
    for (const status of ['running', 'needs-input'] as const) {
      expect(laneRowOf(lane({ task: status })).actions).toEqual({ open: true, apply: false, discard: 'off' });
    }
    expect(laneRowOf(lane({ task: 'needs-input' })).state).toEqual({ label: 'Needs your answer', tone: 'wait' });
  });

  it('discards a lane with nothing to lose without asking, and has nothing to apply', () => {
    const clean = laneRowOf(lane({ status: 'clean', diff: { files: 0, added: 0, removed: 0 }, task: null, check: 'none' }));
    expect(clean).toMatchObject({ state: { label: 'No changes' }, diff: 'No changes', check: { label: 'No check' }, actions: { apply: false, discard: 'plain' } });
    expect(laneRowOf(lane({ status: 'missing', task: null })).actions.open).toBe(false);
    expect(laneRowOf(lane({ session: null, task: null })).task).toBe('No task yet');
  });
});

/** A row for a task with no children, never opened. */
const rowOf = (record: TaskRecord, shown: string | undefined, now: number, clock?: (ms: number) => string) =>
  taskRowOf({ task: record, children: [], ...placeTask({ task: record, children: [], seenAt: undefined }) }, shown, now, clock);

describe('the task rows', () => {
  it('say where a task runs, how long it ran and what it cost, and mark the shown one', () => {
    expect(rowOf(task(), 's1', 61_000)).toEqual({
      id: 's1',
      title: 'Fix the login button',
      where: 'Lane fix-login',
      state: { label: 'Running', tone: 'busy' },
      fresh: false,
      children: undefined,
      backend: undefined,
      time: '1m 0s',
      cost: undefined,
      live: true,
      stop: true,
      current: true,
      jobs: [],
    });
    const ended = rowOf(task({ lane: null, status: 'failed', endedAt: 4000, usage: { model: 'm', inputTokens: 1, outputTokens: 1, costUsd: 0.5 } }), 'other', 99_000);
    expect(ended).toMatchObject({ where: 'Main checkout', time: '3.0s', cost: '$0.50', live: false, current: false, state: { tone: 'failed' } });
  });

  it('list the background commands a session runs, in its own words where it gave them', () => {
    const jobs = [
      { id: 'bg-1' as const, command: 'pnpm dev', description: 'Start the dev server', startedAt: 1000 },
      { id: 'bg-2' as const, command: 'pnpm test --watch', startedAt: 2000 },
    ];
    expect(rowOf(task({ status: 'done', endedAt: 3000, jobs }), undefined, 9000).jobs).toEqual([
      { id: 'bg-1', label: 'Start the dev server' },
      { id: 'bg-2', label: 'pnpm test --watch' },
    ]);
  });

  it('say what a waiting task waits for, as a live task that wants attention', () => {
    const clock = (ms: number) => new Date(ms).toISOString().slice(11, 16);
    const offline = rowOf(task({ status: 'waiting', waiting: { kind: 'offline', since: 1000, retryAt: 13_000, resetAt: null, message: 'fetch failed' } }), undefined, 1000, clock);
    expect(offline).toMatchObject({ state: { label: 'Offline, retrying in 12s', tone: 'wait' }, live: true });
    const resetAt = Date.parse('2026-10-06T14:05:00Z');
    const limited = rowOf(task({ status: 'waiting', waiting: { kind: 'limited', since: 1000, retryAt: resetAt, resetAt, message: '429' } }), undefined, 1000, clock);
    expect(limited.state).toEqual({ label: 'Limited until 14:05', tone: 'wait' });
    expect(laneRowOf(lane({ task: 'waiting' })).actions).toMatchObject({ apply: false, discard: 'off' });
  });

  it('name the external agent a task runs on, and its lane once the first turn made one', () => {
    expect(rowOf(task({ backend: 'cursor', lane: null }), undefined, 1000)).toMatchObject({ backend: 'Cursor', where: 'New lane' });
    expect(rowOf(task({ backend: 'cursor', lane: 'please-read-a-ts' }), undefined, 1000)).toMatchObject({ backend: 'Cursor', where: 'Lane please-read-a-ts' });
    expect(rowOf(task({ lane: null }), undefined, 1000)).toMatchObject({ backend: undefined, where: 'Main checkout' });
  });

  it('sorts into Needs you, Ready, Working and Done, and leaves an empty section out', () => {
    const sections = taskSections(
      [
        task({ sessionId: 'run', status: 'running' }),
        task({ sessionId: 'ask', status: 'needs-input', asking: 'permission', returnedAt: 2000 }),
        task({ sessionId: 'new', status: 'done', endedAt: 3000, returnedAt: 3000 }),
        task({ sessionId: 'old', status: 'done', endedAt: 1500, returnedAt: 1500 }),
      ],
      { old: 1600 },
      undefined,
      5000,
    );
    expect(sections.map((s) => [s.heading, s.rows.map((r) => r.id)])).toEqual([
      ['Needs you', ['ask']],
      ['Ready', ['new']],
      ['Working', ['run']],
      ['Done', ['old']],
    ]);
    expect(sections[0]!.rows[0]!.state).toEqual({ label: 'Needs permission', tone: 'wait' });
    expect(sections[1]!.rows[0]).toMatchObject({ fresh: true, state: { label: 'Done' } });
    expect(taskSections([task({ status: 'running' })], {}, undefined, 5000).map((s) => s.heading)).toEqual(['Working']);
  });

  it('rolls subagents and lanes into their parent’s row, which says what the child asks', () => {
    const [needs] = taskSections(
      [task({ sessionId: 'p', lane: null }), task({ sessionId: 'c', parent: 'p', kind: 'subagent', status: 'needs-input', asking: 'question', returnedAt: 2000 })],
      {},
      undefined,
      5000,
    );
    expect(needs!.rows).toHaveLength(1);
    expect(needs!.rows[0]).toMatchObject({ id: 'p', state: { label: 'Needs your answer' }, children: '1 agent running', stop: true });
    const [ready] = taskSections(
      [task({ sessionId: 'arena-1', kind: 'arena', lane: null, status: 'done', endedAt: 3000, returnedAt: 3000 }), task({ sessionId: 'a', parent: 'arena-1', status: 'done', endedAt: 2000 }), task({ sessionId: 'b', parent: 'arena-1', status: 'failed', endedAt: 2500 })],
      {},
      undefined,
      5000,
    );
    expect(ready!.rows).toEqual([expect.objectContaining({ id: 'arena-1', children: '2 lanes', fresh: true })]);
    expect(taskRowOf({ task: task({ kind: 'arena' }), children: [], ...placeTask({ task: task({ kind: 'arena' }), children: [], seenAt: undefined }) }, undefined, 0).stop).toBe(false);
  });

  it('opens a task at the card, at Retry now, or at the end', () => {
    expect(revealOf({ kind: 'needs-you', reason: 'permission', at: 'p' })).toBe('card');
    expect(revealOf({ kind: 'needs-you', reason: 'question', at: 'p' })).toBe('card');
    expect(revealOf({ kind: 'needs-you', reason: 'limited', at: 'p' })).toBe('retry');
    expect(revealOf({ kind: 'needs-you', reason: 'failed', at: 'p' })).toBe('end');
    expect(revealOf({ kind: 'ready' })).toBe('end');
  });
});

describe('the seen markers', () => {
  it('move only forward, and keep the newest 200', () => {
    const one = markSeen({}, 'a', 10);
    expect(markSeen(one, 'a', 5)).toBe(one);
    expect(markSeen(one, 'a', 20)).toEqual({ a: 20 });
    let many = {};
    for (let i = 0; i < 205; i++) many = markSeen(many, `s${i}`, i);
    expect(Object.keys(many)).toHaveLength(200);
    expect(many).not.toHaveProperty('s4');
    expect(many).toHaveProperty('s204', 204);
  });
});

describe('which moves notify', () => {
  it('tells of a move into Needs you, with the macOS notification, and of a finish in VS Code only', () => {
    const working = { kind: 'working' } as const;
    expect(attentionNotice(working, { kind: 'needs-you', reason: 'permission', at: 'p' })).toBe(ATTENTION_NOTICES.permission);
    expect(attentionNotice(undefined, { kind: 'needs-you', reason: 'failed', at: 'p' })).toMatchObject({ severity: 'error', os: true });
    expect(attentionNotice({ kind: 'needs-you', reason: 'permission', at: 'p' }, { kind: 'needs-you', reason: 'question', at: 'p' })).toBeUndefined();
    expect(attentionNotice(working, { kind: 'ready' })).toMatchObject({ verb: 'finished', os: false });
    expect(attentionNotice({ kind: 'done' }, working)).toBeUndefined();
    expect(attentionNotice(undefined, working)).toBeUndefined();
    expect(attentionNotice({ kind: 'needs-you', reason: 'permission', at: 'p' }, working)).toBeUndefined();
    expect(Object.values(ATTENTION_NOTICES).filter((n) => n.os).map((n) => n.kind)).not.toContain('done');
  });
});

describe('how a notice reaches the user', () => {
  it('says nothing while the user looks at the session, and adds the macOS notification when the window is not in front', () => {
    expect(channelsOf({ shown: true, focused: true, panelVisible: true })).toEqual({ toast: false, os: false });
    expect(channelsOf({ shown: false, focused: true, panelVisible: true })).toEqual({ toast: true, os: false });
    expect(channelsOf({ shown: true, focused: true, panelVisible: false })).toEqual({ toast: true, os: false });
    expect(channelsOf({ shown: true, focused: false, panelVisible: true })).toEqual({ toast: true, os: true });
  });

  it('passes the text to osascript as arguments, so a title cannot become script', () => {
    const title = 'Done" & (do shell script "touch /tmp/pwned") & "';
    const text = noticeText(TASK_NOTICES.done!, task({ title, status: 'done' }));
    expect(text).toBe(`Geno finished: ${title} (lane fix-login)`);
    const [file, args] = osNotification('Geno', text);
    expect(file).toBe('/usr/bin/osascript');
    expect(args.slice(0, 6).join('\n')).not.toContain(title);
    expect(args.slice(6)).toEqual(['Geno', text]);
  });
});

describe('the engine socket', () => {
  const settings = { cliPath: '/ext/dist/engine/cli.js', cwd: '/repo', env: { GCODE_PROVIDER: 'modelstudio', DASHSCOPE_API_KEY: 'sk-one' } };

  it('is the same for a window that reloads, and another for another key, without the key in it', () => {
    const before = socketPathOf(settings, { GCODE_HOME: '/h', VSCODE_PID: '1' }, '/tmp/x');
    expect(socketPathOf(settings, { VSCODE_PID: '2', GCODE_HOME: '/h' }, '/tmp/x')).toBe(before);
    expect(socketPathOf({ ...settings, env: { ...settings.env, DASHSCOPE_API_KEY: 'sk-two' } }, { GCODE_HOME: '/h' }, '/tmp/x')).not.toBe(before);
    expect(socketPathOf(settings, { GCODE_HOME: '/other' }, '/tmp/x')).not.toBe(before);
    expect(before).toMatch(/^\/tmp\/x\/gcode-[0-9a-f]{16}\.sock$/);
    expect(before).not.toContain('sk-one');
  });

  it('falls back to /tmp when the temp folder would make the path longer than macOS allows', () => {
    expect(socketPathOf(settings, {}, `/${'d'.repeat(100)}`)).toMatch(/^\/tmp\/gcode-[0-9a-f]{16}\.sock$/);
  });
});
