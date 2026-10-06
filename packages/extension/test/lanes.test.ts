import { describe, expect, it } from 'vitest';
import { NEEDS_ATTENTION, TASK_NOTICES, type LaneInfo, type TaskRecord } from '@g-code/core';
import { socketPathOf } from '../src/chat/engine.js';
import { laneRowOf, taskOrder, taskRowOf } from '../src/chat/lanes-model.js';
import { channelsOf, noticeText, osNotification } from '../src/chat/notices.js';

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

describe('the task rows', () => {
  it('say where a task runs, how long it ran and what it cost, and mark the shown one', () => {
    expect(taskRowOf(task(), 's1', 61_000)).toEqual({
      id: 's1',
      title: 'Fix the login button',
      where: 'Lane fix-login',
      state: { label: 'Running', tone: 'busy' },
      time: '1m 0s',
      cost: undefined,
      live: true,
      current: true,
      jobs: [],
    });
    const ended = taskRowOf(task({ lane: null, status: 'failed', endedAt: 4000, usage: { model: 'm', inputTokens: 1, outputTokens: 1, costUsd: 0.5 } }), 'other', 99_000);
    expect(ended).toMatchObject({ where: 'Main checkout', time: '3.0s', cost: '$0.50', live: false, current: false, state: { tone: 'failed' } });
  });

  it('list the background commands a session runs, in its own words where it gave them', () => {
    const jobs = [
      { id: 'bg-1' as const, command: 'pnpm dev', description: 'Start the dev server', startedAt: 1000 },
      { id: 'bg-2' as const, command: 'pnpm test --watch', startedAt: 2000 },
    ];
    expect(taskRowOf(task({ status: 'done', endedAt: 3000, jobs }), undefined, 9000).jobs).toEqual([
      { id: 'bg-1', label: 'Start the dev server' },
      { id: 'bg-2', label: 'pnpm test --watch' },
    ]);
  });

  it('say what a waiting task waits for, as a live task that wants attention', () => {
    const clock = (ms: number) => new Date(ms).toISOString().slice(11, 16);
    const offline = taskRowOf(task({ status: 'waiting', waiting: { kind: 'offline', since: 1000, retryAt: 13_000, resetAt: null, message: 'fetch failed' } }), undefined, 1000, clock);
    expect(offline).toMatchObject({ state: { label: 'Offline, retrying in 12s', tone: 'wait' }, live: true });
    const resetAt = Date.parse('2026-10-06T14:05:00Z');
    const limited = taskRowOf(task({ status: 'waiting', waiting: { kind: 'limited', since: 1000, retryAt: resetAt, resetAt, message: '429' } }), undefined, 1000, clock);
    expect(limited.state).toEqual({ label: 'Limited until 14:05', tone: 'wait' });
    expect(NEEDS_ATTENTION.waiting).toBe(true);
    expect(laneRowOf(lane({ task: 'waiting' })).actions).toMatchObject({ apply: false, discard: 'off' });
  });

  it('lists running tasks first, then the rest, newest first', () => {
    const order = taskOrder([task({ sessionId: 'old-done', status: 'done', startedAt: 1 }), task({ sessionId: 'running', startedAt: 2 }), task({ sessionId: 'new-done', status: 'done', startedAt: 3 })]);
    expect(order.map((t) => t.sessionId)).toEqual(['running', 'new-done', 'old-done']);
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
