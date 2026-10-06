import { describe, expect, it } from 'vitest';
import { asSessionId, changesCourse, openWaitOf, planWait, WAIT_POLICY, waitLabel, type TurnEvent, type WaitClock, type Waiting } from '../src/index.js';

const t0 = Date.parse('2026-10-06T14:00:00Z');
const MIN = 60_000;

/** The probe times an offline wait plans when every probe fails at once. */
function offlineSchedule(until: number): number[] {
  const at: number[] = [];
  let now = t0;
  for (let tries = 0; ; tries++) {
    const plan = planWait(WAIT_POLICY, { kind: 'offline', since: t0, tries, resetAt: null }, now, 'short', 0);
    if (plan.kind !== 'at' || now >= until) return at;
    at.push(plan.at - now);
    now = plan.at;
  }
}

describe('planWait offline', () => {
  it('probes after 5s, doubling to every 60s', () => {
    expect(offlineSchedule(t0 + 10 * MIN).slice(0, 7)).toEqual([5000, 10_000, 20_000, 40_000, 60_000, 60_000, 60_000]);
  });

  it('gives up 30 minutes after the wait began, with a probe at the limit and not past it', () => {
    const last = planWait(WAIT_POLICY, { kind: 'offline', since: t0, tries: 40, resetAt: null }, t0 + 29.5 * MIN, 'short', 0);
    expect(last).toEqual({ kind: 'at', at: t0 + 30 * MIN });
    expect(planWait(WAIT_POLICY, { kind: 'offline', since: t0, tries: 41, resetAt: null }, t0 + 30 * MIN, 'short', 0)).toEqual({
      kind: 'give-up',
      message: 'the provider has not answered for 30 minutes; check the connection and send again',
    });
  });

  it('resumes by itself even when the setting turns limit resumes off', () => {
    expect(planWait(WAIT_POLICY, { kind: 'offline', since: t0, tries: 0, resetAt: null }, t0, 'off', 0)).toEqual({ kind: 'at', at: t0 + 5000 });
  });
});

describe('planWait limited', () => {
  const limited = (resetAt: number | null, tries = 0): WaitClock => ({ kind: 'limited', since: t0, tries, resetAt });

  it('resumes at the reset plus its jitter', () => {
    expect(planWait(WAIT_POLICY, limited(t0 + 5 * MIN), t0, 'short', 0)).toEqual({ kind: 'at', at: t0 + 5 * MIN });
    expect(planWait(WAIT_POLICY, limited(t0 + 5 * MIN), t0, 'short', 0.5)).toEqual({ kind: 'at', at: t0 + 5 * MIN + 1500 });
  });

  it('resumes by itself up to a 15-minute wait, and holds a longer one for the user unless the setting says always', () => {
    expect(planWait(WAIT_POLICY, limited(t0 + 15 * MIN), t0, 'short', 0)).toEqual({ kind: 'at', at: t0 + 15 * MIN });
    expect(planWait(WAIT_POLICY, limited(t0 + 15 * MIN + 1), t0, 'short', 0)).toEqual({ kind: 'hold' });
    expect(planWait(WAIT_POLICY, limited(t0 + 5 * 60 * MIN), t0, 'always', 0)).toEqual({ kind: 'at', at: t0 + 5 * 60 * MIN });
  });

  it('holds every limit for the user when the setting is off', () => {
    expect(planWait(WAIT_POLICY, limited(t0 + 1000), t0, 'off', 0)).toEqual({ kind: 'hold' });
    expect(planWait(WAIT_POLICY, limited(null), t0, 'off', 0)).toEqual({ kind: 'hold' });
  });

  it('backs off from 15s to 5 minutes with no known reset, and gives up after 15 minutes', () => {
    const delays = [0, 1, 2, 3, 4, 5, 6].map((tries) => {
      const plan = planWait(WAIT_POLICY, limited(null, tries), t0, 'short', 0);
      return plan.kind === 'at' ? plan.at - t0 : plan.kind;
    });
    expect(delays).toEqual([15_000, 30_000, 60_000, 120_000, 240_000, 300_000, 300_000]);
    expect(planWait(WAIT_POLICY, limited(null, 5), t0 + 13 * MIN, 'short', 0)).toEqual({ kind: 'at', at: t0 + 15 * MIN });
    expect(planWait(WAIT_POLICY, limited(null, 6), t0 + 15 * MIN, 'short', 0)).toMatchObject({ kind: 'give-up' });
  });

  it('waits out a reset whenever it is, past the no-reset give-up', () => {
    expect(planWait(WAIT_POLICY, limited(t0 + 14 * MIN, 3), t0 + 14 * MIN, 'short', 0)).toEqual({ kind: 'at', at: t0 + 14 * MIN });
  });

  it('never plans a try before now, for a reset that already passed', () => {
    expect(planWait(WAIT_POLICY, limited(t0 - 1000), t0, 'short', 0)).toEqual({ kind: 'at', at: t0 });
  });
});

const offline: Waiting = { kind: 'offline', since: t0, retryAt: t0 + 12_000, resetAt: null, message: 'fetch failed' };
const limitedUntil: Waiting = { kind: 'limited', since: t0, retryAt: t0 + 5 * MIN + 400, resetAt: t0 + 5 * MIN, message: '429' };

describe('waitLabel', () => {
  const clock = (ms: number) => new Date(ms).toISOString().slice(11, 16);

  it('counts down to the next probe', () => {
    expect(waitLabel(offline, t0, clock)).toBe('Offline, retrying in 12s');
    expect(waitLabel(offline, t0 + 11_001, clock)).toBe('Offline, retrying in 1s');
    expect(waitLabel(offline, t0 + 12_000, clock)).toBe('Offline, retrying now');
  });

  it('names the reset time of a limit', () => {
    expect(waitLabel(limitedUntil, t0, clock)).toBe('Limited until 14:05');
    expect(waitLabel({ ...limitedUntil, retryAt: null }, t0, clock)).toBe('Limited until 14:05');
  });

  it('counts down a limit with no reset, and says only Limited when it waits for the user', () => {
    expect(waitLabel({ ...limitedUntil, resetAt: null, retryAt: t0 + 40_000 }, t0, clock)).toBe('Limited, retrying in 40s');
    expect(waitLabel({ ...limitedUntil, resetAt: null, retryAt: null }, t0, clock)).toBe('Limited');
  });
});

describe('changesCourse', () => {
  it('logs a new wait, a new kind, a new reset or a switch to holding, and not a rescheduled probe', () => {
    expect(changesCourse(undefined, offline)).toBe(true);
    expect(changesCourse(offline, { ...offline, retryAt: t0 + 60_000 })).toBe(false);
    expect(changesCourse(offline, limitedUntil)).toBe(true);
    expect(changesCourse(limitedUntil, { ...limitedUntil, resetAt: t0 + 6 * MIN })).toBe(true);
    expect(changesCourse(limitedUntil, { ...limitedUntil, retryAt: null })).toBe(true);
  });
});

describe('openWaitOf', () => {
  const session = { id: asSessionId('s'), createdAt: '2026-10-06T14:00:00Z', workspace: '/w', provider: 'modelstudio' as const, model: 'm', effort: 'medium' as const };
  const at = '2026-10-06T14:00:00Z';
  const start: TurnEvent = { kind: 'session-start', session };
  const user: TurnEvent = { kind: 'user', seq: 1, at, content: 'hi' };
  const wait = (seq: number, w: Waiting): TurnEvent => ({ kind: 'wait', seq, at, wait: w });

  it('finds the wait the log ends in, past bookkeeping after it', () => {
    expect(openWaitOf([start, user, wait(2, offline), wait(3, limitedUntil), { kind: 'title', seq: 4, at, title: 'x' }])).toEqual(limitedUntil);
  });

  it('finds none once the call answered, failed or a new prompt came', () => {
    const answered: TurnEvent = { kind: 'assistant', seq: 3, at, content: [], stopReason: 'end_turn', usage: { input: 1, cacheRead: 0, cacheWrite: 0, output: 1 }, costUsd: 0, latencyMs: 1, model: 'm' };
    expect(openWaitOf([start, user, wait(2, offline), answered])).toBeUndefined();
    expect(openWaitOf([start, user, wait(2, offline), { kind: 'error', seq: 3, at, error: 'abort', message: 'stopped' }])).toBeUndefined();
    expect(openWaitOf([start, user])).toBeUndefined();
  });
});
