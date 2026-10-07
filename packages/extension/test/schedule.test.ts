import { describe, expect, it } from 'vitest';
import type { ScheduleRun, ScheduleView } from '@g-code/core';
import { scheduleRowOf } from '../src/chat/schedule-model.js';
import { schedulesUpdate } from '../src/chat/schedule-wire.js';

const BANGKOK = 'Asia/Bangkok';
const z = (iso: string) => Date.parse(iso);
// Wednesday 7 October 2026, 10:00 in Bangkok.
const NOW = z('2026-10-07T03:00:00Z');

const task = (patch: Partial<ScheduleView> = {}): ScheduleView =>
  ({
    id: 'sch_1a2b3c',
    title: 'Review main',
    prompt: '/review main',
    when: { kind: 'cron', expr: '0 9 * * 1-5' },
    edits: false,
    budget: { maxCostUsd: 0.05, maxTurns: 20 },
    paused: false,
    createdAt: z('2026-10-01T00:00:00Z'),
    createdBy: { kind: 'user' },
    since: z('2026-10-07T02:00:00Z'),
    runs: [],
    nextAt: z('2026-10-08T02:00:00Z'),
    ...patch,
  }) as ScheduleView;

const ran = (patch: Partial<Extract<ScheduleRun, { kind: 'ran' }>> = {}): ScheduleRun => ({
  kind: 'ran',
  dueAt: z('2026-10-07T02:00:00Z'),
  trigger: 'schedule',
  startedAt: z('2026-10-07T02:00:00Z'),
  sessionId: 's-run',
  workspace: '/ws',
  lane: null,
  by: 1,
  end: { kind: 'done', at: z('2026-10-07T02:01:00Z'), costUsd: 0.0123 },
  ...patch,
});

describe('scheduleRowOf', () => {
  it('shows the schedule, the next run, how it runs and its budget', () => {
    expect(scheduleRowOf(task(), BANGKOK, NOW)).toEqual({
      id: 'sch_1a2b3c',
      title: 'Review main',
      state: { label: 'Scheduled', tone: 'ok' },
      when: 'Weekdays at 09:00',
      next: 'Next Thu 8 Oct 09:00',
      how: 'Read-only · up to $0.05 and 20 model calls a run',
      last: undefined,
      running: false,
      paused: false,
    });
  });

  it.each([
    ['a run that ended', ran(), { text: 'Last run Wed 7 Oct 09:00: Done · $0.01', tone: 'ok', open: { sessionId: 's-run', workspace: '/ws' } }],
    ['a run stopped at its budget', ran({ end: { kind: 'budget', at: 1, costUsd: 0.06 } }), { text: 'Last run Wed 7 Oct 09:00: Stopped at its budget · $0.06', tone: 'wait' }],
    ['a catch-up', ran({ trigger: 'catch-up', startedAt: z('2026-10-07T02:20:00Z') }), { text: 'Last run Wed 7 Oct 09:20 (late, for Wed 7 Oct 09:00): Done · $0.01' }],
    ['a run still going', ran({ end: null }), { text: 'Running since Wed 7 Oct 09:00', tone: 'busy' }],
    ['a Run now', ran({ trigger: 'now' }), { text: 'Last run Wed 7 Oct 09:00 (Run now): Done · $0.01' }],
    ['a missed run', { kind: 'missed', at: NOW, from: z('2026-10-06T02:00:00Z'), to: z('2026-10-06T02:00:00Z'), count: 1, why: 'off' }, { text: 'Missed Tue 6 Oct 09:00: Geno was not running', tone: 'wait', open: undefined }],
    ['a run that did not start', { kind: 'not-started', dueAt: NOW, trigger: 'schedule', at: NOW, message: 'not a git repository' }, { text: 'Did not start at Wed 7 Oct 10:00: not a git repository', tone: 'failed' }],
  ] satisfies [string, ScheduleRun, object][])('shows %s as the last run', (_name, run, last) => {
    expect(scheduleRowOf(task({ runs: [run] }), BANGKOK, NOW).last).toMatchObject(last);
  });

  it('marks a running task, which Run now cannot start again, and a paused one', () => {
    expect(scheduleRowOf(task({ runs: [ran({ end: null })] }), BANGKOK, NOW)).toMatchObject({ state: { label: 'Running', tone: 'busy' }, running: true });
    expect(scheduleRowOf(task({ paused: true, nextAt: null }), BANGKOK, NOW)).toMatchObject({ state: { label: 'Paused' }, next: 'Paused', paused: true });
    expect(scheduleRowOf(task({ when: { kind: 'at', at: z('2026-10-07T02:00:00Z') }, nextAt: null, edits: true }), BANGKOK, NOW)).toMatchObject({
      when: 'Once, Wed 7 Oct 09:00',
      next: 'No run left',
      how: 'Edits in its own lane · up to $0.05 and 20 model calls a run',
    });
  });
});

describe('the schedules update', () => {
  it('takes a whole update and refuses a torn one', () => {
    expect(schedulesUpdate.safeParse({ workspace: '/ws', tasks: [task({ runs: [ran()] })] }).success).toBe(true);
    expect(schedulesUpdate.safeParse({ workspace: '/ws', tasks: [{ id: 'sch_1a2b3c', title: 'Review main' }] }).success).toBe(false);
  });
});
