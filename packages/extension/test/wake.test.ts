import { describe, expect, it } from 'vitest';
import { placeTasks } from '@g-code/core/attention';
import type { TaskRecord } from '@g-code/core';
import { composerView, NO_FACTS } from '../src/chat/composer-model.js';
import type { Background } from '../src/chat/activity-model.js';
import { taskRowOf, taskSections } from '../src/chat/lanes-model.js';
import { attentionNotice } from '../src/chat/notices.js';
import { emptyTranscript, reduce } from '../src/chat/transcript.js';
import { wakeEnvOf } from '../src/runtime.js';

const T0 = Date.parse('2026-10-07T12:00:00.000Z');
const clock = (ms: number) => new Date(ms).toISOString().slice(11, 16);
const task = (patch: Partial<TaskRecord> = {}): TaskRecord => ({
  sessionId: 's',
  title: 'Run the build',
  workspace: '/repo',
  lane: null,
  status: 'done',
  startedAt: T0,
  endedAt: T0 + 4000,
  returnedAt: T0 + 4000,
  ...patch,
});
const waking = task({ wake: { waitsFor: [{ kind: 'children', child: 'c1', agent: 'explore' }, { kind: 'jobs', job: 'bg-1' }, { kind: 'schedule', id: 'wake-1', dueAt: T0 + 8 * 60_000 }] } });
const rowOf = (record: TaskRecord, shown?: string) => taskRowOf(placeTasks([record], {})[0]!, shown, T0 + 5000, clock);

describe('a session waiting to be woken in the Tasks list', () => {
  it('is Working, says what it waits for, and offers Cancel', () => {
    const row = rowOf(waking);
    expect(row.state).toEqual({ label: 'Waiting to wake', tone: 'busy' });
    expect(row.wakes).toBe('Wakes on explore, bg-1 and a wake-up at 12:08');
    expect(row.stop, 'its turn ended, so there is nothing to stop').toBe(false);
    expect(taskSections([waking], {}, undefined, T0 + 5000, clock).map((s) => s.section)).toEqual(['working']);
  });

  it('needs the user once the cap paused its wake-ups, and says so', () => {
    const capped = task({ wake: { waitsFor: [{ kind: 'jobs', job: 'bg-1' }], paused: 'cap' } });
    expect(taskSections([capped], { s: T0 + 9000 }, undefined, T0 + 9000, clock).map((s) => s.section)).toEqual(['needs-you']);
    expect(rowOf(capped)).toMatchObject({ state: { label: 'Wake-ups paused', tone: 'wait' }, wakes: 'Paused after 12 wake-ups in an hour' });
  });

  it('says nothing of wakes for a turn that runs or waits on nothing', () => {
    expect(rowOf(task()).wakes).toBeUndefined();
    expect(rowOf(task({ status: 'running', endedAt: null, wake: waking.wake })).wakes).toBeUndefined();
    expect(rowOf(task({ wake: { waitsFor: [], paused: 'stopped' } })).wakes).toBeUndefined();
  });

  it('tells the user when the cap pauses it, and never that it finished while it waits', () => {
    const before = placeTasks([task({ status: 'running', endedAt: null })], {})[0]!.attention;
    expect(attentionNotice(before, placeTasks([waking], {})[0]!.attention)).toBeUndefined();
    const capped = placeTasks([task({ wake: { waitsFor: [], paused: 'cap' } })], {})[0]!.attention;
    expect(attentionNotice(before, capped)).toMatchObject({ kind: 'needs-input', verb: 'paused its wake-ups after 12 in an hour', os: true });
  });
});

describe('the composer pill', () => {
  const view = (background: Background) => composerView({ transcript: emptyTranscript('qwen3.8-flash'), facts: NO_FACTS, mcp: { kind: 'loading' }, queued: undefined, now: T0 + 5000, background }).activity;

  it('counts a session waiting to be woken as running, the shown chat included', () => {
    expect(view({ tasks: [{ ...waking, sessionId: 'other', lane: 'fix-build' }], seen: {}, shown: 'here' })).toMatchObject({ running: 1, text: '1 running', label: undefined });
    const here = task({ sessionId: 'here', wake: { waitsFor: [{ kind: 'jobs', job: 'bg-1' }] } });
    expect(view({ tasks: [here], seen: {}, shown: 'here' })).toMatchObject({ running: 1, text: '1 running', label: { text: 'Wakes on bg-1', tone: 'working' } });
    expect(view({ tasks: [task({ sessionId: 'here' })], seen: { here: T0 + 4500 }, shown: 'here' })).toBeUndefined();
  });
});

describe('a woken turn in the transcript', () => {
  it('carries why it woke, and no message of the user', () => {
    const transcript = reduce(emptyTranscript('qwen3.8-flash'), { type: 'turn-start', id: 't1', at: T0, prompt: '', wake: 'woke: 2 tasks finished' });
    expect(transcript.turns[0]).toMatchObject({ prompt: '', wake: 'woke: 2 tasks finished', status: 'streaming' });
    expect(transcript.turns[0]!.seq).toBeUndefined();
  });
});

describe('the auto-wake setting', () => {
  it('reaches the engine only when off', () => {
    const settings = (value: unknown) => ({ get: <T>(_key: string, fallback: T) => (value === undefined ? fallback : (value as T)) });
    expect(wakeEnvOf(settings(undefined) as never)).toEqual({});
    expect(wakeEnvOf(settings(true) as never)).toEqual({});
    expect(wakeEnvOf(settings(false) as never)).toEqual({ GCODE_AUTO_WAKE: 'off' });
  });
});
