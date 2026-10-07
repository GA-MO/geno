import { describe, expect, it } from 'vitest';
import {
  asSessionId,
  DEFAULT_SCHEDULE_BUDGET,
  describeWhen,
  endRun,
  formatAt,
  instantOf,
  isRunning,
  MISSED_COUNT_CAP,
  newTask,
  nextCronAfter,
  nextOccurrence,
  parseCron,
  parseScheduleCommand,
  parseScheduleTask,
  parseWhen,
  patchTask,
  planDue,
  runEndOf,
  runText,
  SCHEDULE_LIMITS,
  SCHEDULE_POLICY,
  scheduleIdOf,
  scheduleToolDefinitions,
  settled,
  updatedTask,
  withRuns,
  type Cron,
  type ScheduleDraft,
  type ScheduledTask,
  type ScheduleRun,
  type TurnEvent,
  type When,
} from '../src/index.js';

const NY = 'America/New_York';
const LONDON = 'Europe/London';
const BANGKOK = 'Asia/Bangkok';
const UTC = 'UTC';
const z = (iso: string) => Date.parse(iso);
const iso = (ms: number | null) => (ms === null ? null : new Date(ms).toISOString());
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

function cron(expr: string): Cron {
  const parsed = parseCron(expr);
  if (!parsed.ok) throw new Error(parsed.problem);
  return parsed.value;
}

describe('parseCron', () => {
  it.each([
    ['0 9 * * 1-5', { minutes: [0], hours: [9] }],
    ['*/15 * * * *', { minutes: [0, 15, 30, 45] }],
    ['5/20 * * * *', { minutes: [5, 25, 45] }],
    ['0 9,17 * * *', { hours: [9, 17] }],
    ['@daily', { minutes: [0], hours: [0] }],
  ])('reads %s', (expr, fields) => {
    expect(cron(expr)).toMatchObject(fields);
  });

  it('reads month and weekday names, and 7 as Sunday', () => {
    const parsed = cron('0 9 * jan-mar mon,FRI,7');
    expect([...parsed.months]).toEqual([1, 2, 3]);
    expect([...parsed.weekdays].toSorted()).toEqual([0, 1, 5]);
  });

  it.each([
    ['0 9 * *', /has 4/],
    ['60 * * * *', /minute field "60" is outside 0 to 59/],
    ['* * * * 8', /day of the week field "8" is outside/],
    ['0 9 * * x', /names no day of the week/],
    ['*/0 * * * *', /step of 0/],
    ['0 9 * * 5-1', /outside/],
    ['0 9 * * 1;2', /not a number, range, list or step/],
  ])('refuses %s', (expr, problem) => {
    const parsed = parseCron(expr);
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(parsed.problem).toMatch(problem);
  });
});

describe('instantOf', () => {
  it('reads a plain wall time with the zone offset', () => {
    expect(iso(instantOf({ year: 2026, month: 10, day: 8, hour: 9, minute: 0 }, BANGKOK))).toBe('2026-10-08T02:00:00.000Z');
  });

  it('moves a minute the clock skips later by the hour skipped', () => {
    expect(iso(instantOf({ year: 2026, month: 3, day: 8, hour: 2, minute: 30 }, NY))).toBe('2026-03-08T07:30:00.000Z');
    expect(iso(instantOf({ year: 2026, month: 3, day: 29, hour: 1, minute: 30 }, LONDON))).toBe('2026-03-29T01:30:00.000Z');
  });

  it('takes the first of a minute the clock shows twice', () => {
    expect(iso(instantOf({ year: 2026, month: 11, day: 1, hour: 1, minute: 30 }, NY))).toBe('2026-11-01T05:30:00.000Z');
    expect(iso(instantOf({ year: 2026, month: 10, day: 25, hour: 1, minute: 30 }, LONDON))).toBe('2026-10-25T00:30:00.000Z');
  });
});

describe('nextCronAfter', () => {
  const next = (expr: string, after: string, zone: string) => iso(nextCronAfter(cron(expr), z(after), zone));

  it('finds the next weekday at 9:00 in local time, over a weekend', () => {
    expect(next('0 9 * * 1-5', '2026-10-09T03:00:00Z', BANGKOK)).toBe('2026-10-12T02:00:00.000Z');
    expect(next('0 9 * * 1-5', '2026-10-08T01:59:00Z', BANGKOK)).toBe('2026-10-08T02:00:00.000Z');
  });

  it('is strictly after: a run at 9:00 is next due the day after', () => {
    expect(next('0 9 * * *', '2026-10-08T02:00:00Z', BANGKOK)).toBe('2026-10-09T02:00:00.000Z');
  });

  it('runs a daily time the spring change skips once, an hour late, and keeps its time the day after', () => {
    expect(next('30 2 * * *', '2026-03-07T08:00:00Z', NY)).toBe('2026-03-08T07:30:00.000Z');
    expect(next('30 2 * * *', '2026-03-08T07:30:00Z', NY)).toBe('2026-03-09T06:30:00.000Z');
  });

  it('runs a daily time the autumn change repeats only at its first showing', () => {
    expect(next('30 1 * * *', '2026-10-31T16:00:00Z', NY)).toBe('2026-11-01T05:30:00.000Z');
    expect(next('30 1 * * *', '2026-11-01T05:30:00Z', NY)).toBe('2026-11-02T06:30:00.000Z');
  });

  it('runs an hourly schedule once an hour across the spring change, with no double run', () => {
    const runs: string[] = [];
    let at = z('2026-03-08T05:30:00Z');
    for (let i = 0; i < 4; i++) {
      at = nextCronAfter(cron('0 * * * *'), at, NY)!;
      runs.push(iso(at)!);
    }
    expect(runs).toEqual(['2026-03-08T06:00:00.000Z', '2026-03-08T07:00:00.000Z', '2026-03-08T08:00:00.000Z', '2026-03-08T09:00:00.000Z']);
  });

  it('runs a half-hourly schedule once through the hour the autumn change repeats', () => {
    expect(next('*/30 * * * *', '2026-11-01T05:30:00Z', NY)).toBe('2026-11-01T07:00:00.000Z');
  });

  it('matches either the day of the month or the weekday when both are given', () => {
    expect(next('0 0 13 * 5', '2026-10-07T00:00:00Z', UTC)).toBe('2026-10-09T00:00:00.000Z');
    expect(next('0 0 13 * 5', '2026-10-09T00:00:00Z', UTC)).toBe('2026-10-13T00:00:00.000Z');
    expect(next('0 0 13 * *', '2026-10-07T00:00:00Z', UTC)).toBe('2026-10-13T00:00:00.000Z');
  });

  it('finds February 29 years ahead, and never a February 30', () => {
    expect(next('0 0 29 2 *', '2026-03-01T00:00:00Z', UTC)).toBe('2028-02-29T00:00:00.000Z');
    expect(next('0 0 30 2 *', '2026-03-01T00:00:00Z', UTC)).toBeNull();
  });
});

describe('parseWhen and parseScheduleCommand', () => {
  // Wednesday 7 October 2026, 10:00 in Bangkok.
  const now = z('2026-10-07T03:00:00Z');
  const when = (text: string) => {
    const parsed = parseWhen(text, now, BANGKOK);
    if (!parsed.ok) throw new Error(parsed.problem);
    return parsed.value;
  };

  it.each([
    ['in 1h', { kind: 'at', at: now + HOUR }],
    ['in 1h30m', { kind: 'at', at: now + 90 * MINUTE }],
    ['in 1h 30m', { kind: 'at', at: now + 90 * MINUTE }],
    ['in 2 hours', { kind: 'at', at: now + 2 * HOUR }],
    ['in 1 day', { kind: 'at', at: now + 24 * HOUR }],
    ['at 11:30', { kind: 'at', at: z('2026-10-07T04:30:00Z') }],
    ['at 9:00', { kind: 'at', at: z('2026-10-08T02:00:00Z') }],
    ['at 9pm', { kind: 'at', at: z('2026-10-07T14:00:00Z') }],
    ['at 2026-10-08 09:00', { kind: 'at', at: z('2026-10-08T02:00:00Z') }],
    ['weekdays at 9:00', { kind: 'cron', expr: '0 9 * * 1-5' }],
    ['every weekday at 9:00', { kind: 'cron', expr: '0 9 * * 1-5' }],
    ['daily at 18:30', { kind: 'cron', expr: '30 18 * * *' }],
    ['every day at 7am', { kind: 'cron', expr: '0 7 * * *' }],
    ['0 9 * * 1-5', { kind: 'cron', expr: '0 9 * * 1-5' }],
    ['cron "*/15 9-17 * * 1-5"', { kind: 'cron', expr: '*/15 9-17 * * 1-5' }],
    ['@hourly', { kind: 'cron', expr: '@hourly' }],
  ] satisfies [string, When][])('reads %s', (text, expected) => {
    expect(when(text)).toEqual(expected);
  });

  it.each([
    ['in 30s', /say when it runs/],
    ['in 0m', /at least 1 minute/],
    ['at 9', /needs minutes/],
    ['at 25:00', /not a time/],
    ['at 2026-10-01 09:00', /has passed/],
    ['at 2026-02-30 09:00', /does not exist/],
    ['0 0 30 2 *', /never runs/],
    ['tomorrow morning', /say when it runs/],
    ['in 1h then', /"then" follows the time/],
  ])('refuses %s', (text, problem) => {
    const parsed = parseWhen(text, now, BANGKOK);
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(parsed.problem).toMatch(problem);
  });

  it('splits the command into the time, the flags and the prompt, with the conservative budget by default', () => {
    expect(parseScheduleCommand('weekdays at 9:00 run /review on main', now, BANGKOK)).toEqual({
      ok: true,
      value: { title: 'run /review on main', prompt: 'run /review on main', when: { kind: 'cron', expr: '0 9 * * 1-5' }, edits: false, budget: DEFAULT_SCHEDULE_BUDGET },
    });
    expect(parseScheduleCommand('in 1h --edits --max-cost 0.2 --max-turns 30 fix the lint errors in src/', now, BANGKOK)).toMatchObject({
      ok: true,
      value: { prompt: 'fix the lint errors in src/', edits: true, budget: { maxCostUsd: 0.2, maxTurns: 30 }, when: { kind: 'at', at: now + HOUR } },
    });
  });

  it('keeps flags inside the prompt as the prompt', () => {
    expect(parseScheduleCommand('in 1h run pnpm lint --edits', now, BANGKOK)).toMatchObject({ ok: true, value: { prompt: 'run pnpm lint --edits', edits: false } });
  });

  it.each([
    ['weekdays at 9:00', /say what each run does/],
    ['in 1h --max-cost 5 x', /--max-cost is more than 0 and at most 1/],
    ['in 1h --max-turns 2.5 x', /--max-turns is a whole number/],
    ['in 1h --max-cost x', /takes a number/],
  ])('refuses /schedule %s', (args, problem) => {
    const parsed = parseScheduleCommand(args, now, BANGKOK);
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(parsed.problem).toMatch(problem);
  });

  it('names the title from a long prompt within the limit', () => {
    const parsed = parseScheduleCommand(`in 1h ${'check the deploy '.repeat(10)}`, now, BANGKOK);
    expect(parsed.ok && parsed.value.title.length).toBe(SCHEDULE_LIMITS.title);
  });
});

const draft = (when: When, patch: Partial<ScheduleDraft> = {}): ScheduleDraft => ({ title: 'Review main', prompt: '/review main', when, edits: false, budget: DEFAULT_SCHEDULE_BUDGET, ...patch });
const daily9 = (createdAt: string) => newTask(scheduleIdOf(() => 0.5, []), draft({ kind: 'cron', expr: '0 9 * * *' }), { kind: 'user' }, z(createdAt));
const plan = (task: ScheduledTask, now: string, busy = false) => planDue(task, z(now), UTC, SCHEDULE_POLICY, busy);

describe('planDue: the missed-run rule', () => {
  const task = daily9('2026-10-01T08:00:00Z');

  it('waits for the next occurrence', () => {
    expect(plan(task, '2026-10-01T08:30:00Z')).toEqual({ kind: 'wait', at: z('2026-10-01T09:00:00Z') });
  });

  it('runs on time', () => {
    expect(plan(task, '2026-10-01T09:00:05Z')).toEqual({ kind: 'run', dueAt: z('2026-10-01T09:00:00Z'), trigger: 'schedule', skipped: null });
  });

  it('runs once, as a catch-up, within the grace window', () => {
    expect(plan(task, '2026-10-01T09:59:00Z')).toEqual({ kind: 'run', dueAt: z('2026-10-01T09:00:00Z'), trigger: 'catch-up', skipped: null });
  });

  it('records a run past the grace window as missed, and runs nothing', () => {
    expect(plan(task, '2026-10-01T10:01:00Z')).toEqual({ kind: 'miss', missed: { from: z('2026-10-01T09:00:00Z'), to: z('2026-10-01T09:00:00Z'), count: 1, why: 'off' } });
  });

  it('runs only the latest of several missed runs, and records the earlier ones', () => {
    expect(plan(task, '2026-10-03T09:10:00Z')).toEqual({
      kind: 'run',
      dueAt: z('2026-10-03T09:00:00Z'),
      trigger: 'catch-up',
      skipped: { from: z('2026-10-01T09:00:00Z'), to: z('2026-10-02T09:00:00Z'), count: 2, why: 'off' },
    });
  });

  it('records what came due while the last run still runs as missed', () => {
    expect(plan(task, '2026-10-01T09:00:05Z', true)).toEqual({ kind: 'miss', missed: { from: z('2026-10-01T09:00:00Z'), to: z('2026-10-01T09:00:00Z'), count: 1, why: 'busy' } });
  });

  it('plans nothing while paused', () => {
    expect(plan({ ...task, paused: true }, '2026-10-01T09:00:05Z')).toEqual({ kind: 'none' });
  });

  it('waits for the occurrence after the cursor once a run settled it', () => {
    const ran = settled(task, z('2026-10-01T09:00:00Z'));
    expect(plan(ran, '2026-10-01T09:00:30Z')).toEqual({ kind: 'wait', at: z('2026-10-02T09:00:00Z') });
  });

  it('plans nothing for a one-shot task after its run', () => {
    const once = newTask(scheduleIdOf(() => 0.1, []), draft({ kind: 'at', at: z('2026-10-01T12:00:00Z') }), { kind: 'user' }, z('2026-10-01T11:00:00Z'));
    expect(plan(once, '2026-10-01T12:00:01Z')).toMatchObject({ kind: 'run', dueAt: z('2026-10-01T12:00:00Z') });
    expect(plan(settled(once, z('2026-10-01T12:00:00Z')), '2026-10-01T12:00:02Z')).toEqual({ kind: 'none' });
  });

  it('does not run what came due while paused once resumed', () => {
    const resumed = patchTask({ ...task, paused: true }, { paused: false }, z('2026-10-02T10:00:00Z'));
    expect(resumed.since).toBe(z('2026-10-02T10:00:00Z'));
    expect(plan(resumed, '2026-10-02T10:00:00Z')).toEqual({ kind: 'wait', at: z('2026-10-03T09:00:00Z') });
  });

  it('starts a changed schedule from the change', () => {
    const moved = patchTask(task, { when: { kind: 'cron', expr: '0 8 * * *' } }, z('2026-10-02T08:30:00Z'));
    expect(plan(moved, '2026-10-02T08:30:00Z')).toEqual({ kind: 'wait', at: z('2026-10-03T08:00:00Z') });
    expect(patchTask(task, { title: 'Renamed' }, z('2026-10-02T08:30:00Z')).since).toBe(task.since);
  });

  it('counts a minutely schedule off for a month up to the cap, quickly', () => {
    const minutely = newTask(scheduleIdOf(() => 0.2, []), draft({ kind: 'cron', expr: '* * * * *' }), { kind: 'user' }, z('2026-09-01T00:00:00Z'));
    const started = Date.now();
    const result = plan(minutely, '2026-10-01T00:00:30Z');
    expect(Date.now() - started).toBeLessThan(2000);
    expect(result).toMatchObject({ kind: 'run', dueAt: z('2026-10-01T00:00:00Z'), trigger: 'schedule', skipped: { count: MISSED_COUNT_CAP, to: z('2026-09-30T23:59:00Z') } });
  });

  it('plans in local time across the spring change', () => {
    const nightly = newTask(scheduleIdOf(() => 0.3, []), draft({ kind: 'cron', expr: '30 2 * * *' }), { kind: 'user' }, z('2026-03-07T12:00:00Z'));
    expect(planDue(nightly, z('2026-03-08T07:00:00Z'), NY, SCHEDULE_POLICY, false)).toEqual({ kind: 'wait', at: z('2026-03-08T07:30:00Z') });
    expect(planDue(nightly, z('2026-03-08T07:30:10Z'), NY, SCHEDULE_POLICY, false)).toMatchObject({ kind: 'run', dueAt: z('2026-03-08T07:30:00Z'), trigger: 'schedule' });
  });
});

describe('runs', () => {
  const ran = (sessionId: string): ScheduleRun => ({ kind: 'ran', dueAt: 1, trigger: 'now', startedAt: 1, sessionId, workspace: '/ws', lane: null, by: 1, end: null });

  it('keeps the newest runs and ends only the open run of a session', () => {
    let task = daily9('2026-10-01T08:00:00Z');
    for (let i = 0; i < SCHEDULE_LIMITS.runs + 2; i++) task = withRuns(task, ran(`s${i}`));
    expect(task.runs).toHaveLength(SCHEDULE_LIMITS.runs);
    expect(task.runs[0]).toMatchObject({ sessionId: 's2' });
    expect(isRunning(task)).toBe(true);
    const end = { kind: 'done', at: 5, costUsd: 0.01 } as const;
    task = endRun(task, 's11', end);
    expect(task.runs.at(-1)).toMatchObject({ end });
    expect(endRun(task, 's11', { kind: 'failed', at: 6, costUsd: 0 }).runs.at(-1)).toMatchObject({ end });
  });

  const session = { id: asSessionId('s'), createdAt: '2026-10-01T00:00:00Z', workspace: '/ws', provider: 'modelstudio', model: 'qwen3.8-flash', effort: 'medium' } as const;
  const at = '2026-10-01T00:00:01Z';
  const answer = (costUsd: number | null): TurnEvent => ({ kind: 'assistant', seq: 2, at, content: [{ type: 'text', text: 'ok' }], stopReason: 'end_turn', usage: { input: 1, cacheRead: 0, cacheWrite: 0, output: 1 }, costUsd, latencyMs: 1 }) as TurnEvent;
  const events = (...more: TurnEvent[]): TurnEvent[] => [{ kind: 'session-start', session } as TurnEvent, { kind: 'user', seq: 1, at, content: 'go' }, ...more];
  const error = (kind: 'budget' | 'max-turns' | 'abort' | 'transport'): TurnEvent => ({ kind: 'error', seq: 9, at, error: kind, message: `${kind} message` });

  it.each([
    ['done', events(answer(0.01), answer(0.02)), { kind: 'done', costUsd: 0.03 }],
    ['budget', events(answer(0.06), error('budget')), { kind: 'budget', costUsd: 0.06, message: 'budget message' }],
    ['max-turns', events(answer(0.01), error('max-turns')), { kind: 'max-turns' }],
    ['stopped', events(answer(0.01), error('abort')), { kind: 'stopped' }],
    ['failed', events(error('transport')), { kind: 'failed', costUsd: 0 }],
    ['an unpriced model', events(answer(null)), { kind: 'done', costUsd: null }],
  ])('reads a run that ended %s from its log', (_name, log, expected) => {
    expect(runEndOf(log, 7)).toMatchObject({ ...expected, at: 7 });
  });

  it('says what a run came to', () => {
    const now = z('2026-10-07T03:00:00Z');
    const done: ScheduleRun = { ...(ran('s') as Extract<ScheduleRun, { kind: 'ran' }>), startedAt: z('2026-10-07T02:00:00Z'), end: { kind: 'budget', at: now, costUsd: 0.05 } };
    expect(runText(done, BANGKOK, now)).toBe('stopped at its budget (Wed 7 Oct 09:00, $0.05)');
    expect(runText({ kind: 'missed', at: now, from: z('2026-10-05T02:00:00Z'), to: z('2026-10-06T02:00:00Z'), count: 2, why: 'off' }, BANGKOK, now)).toBe(
      'missed 2 runs of Mon 5 Oct 09:00 to Tue 6 Oct 09:00, while Geno was not running',
    );
  });
});

describe('describeWhen and formatAt', () => {
  it.each([
    [{ kind: 'cron', expr: '0 9 * * 1-5' }, 'Weekdays at 09:00'],
    [{ kind: 'cron', expr: '30 18 * * *' }, 'Every day at 18:30'],
    [{ kind: 'cron', expr: '0 10 * * 0,6' }, 'Weekends at 10:00'],
    [{ kind: 'cron', expr: '15 * * * *' }, 'Every hour at :15'],
    [{ kind: 'cron', expr: '*/5 9-17 * * 1-5' }, 'cron */5 9-17 * * 1-5'],
    [{ kind: 'at', at: z('2026-10-08T02:00:00Z') }, 'Once, Thu 8 Oct 09:00'],
  ] satisfies [When, string][])('describes %j', (when, text) => {
    expect(describeWhen(when, BANGKOK, z('2026-10-07T03:00:00Z'))).toBe(text);
  });

  it('adds the year only when it differs', () => {
    expect(formatAt(z('2027-01-04T02:00:00Z'), BANGKOK, z('2026-10-07T03:00:00Z'))).toBe('Mon 4 Jan 2027 09:00');
  });
});

describe('schedule_task input', () => {
  const now = z('2026-10-07T03:00:00Z');
  const parse = (raw: unknown) => parseScheduleTask(raw, now, BANGKOK);

  it('creates with the defaults: read-only, the conservative budget, a title from the prompt', () => {
    expect(parse({ action: 'create', prompt: 'Check the deploy of main', when: 'in 1h' })).toEqual({
      ok: true,
      value: { action: 'create', draft: { title: 'Check the deploy of main', prompt: 'Check the deploy of main', when: { kind: 'at', at: now + HOUR }, edits: false, budget: DEFAULT_SCHEDULE_BUDGET } },
    });
  });

  it('updates only the budget limit it names', () => {
    const task = daily9('2026-10-01T08:00:00Z');
    const update = parse({ action: 'update', id: task.id, max_turns: 40 });
    if (!update.ok || update.value.action !== 'update') throw new Error('not an update');
    expect(updatedTask(task, update.value, now)).toMatchObject({ ok: true, value: { budget: { maxCostUsd: DEFAULT_SCHEDULE_BUDGET.maxCostUsd, maxTurns: 40 } } });
    const over = parse({ action: 'update', id: task.id, max_cost_usd: 3 });
    if (!over.ok || over.value.action !== 'update') throw new Error('not an update');
    expect(updatedTask(task, over.value, now)).toEqual({ ok: false, problem: 'max_cost_usd is more than 0 and at most 1' });
  });

  it.each([
    [{}, /takes an action/],
    [{ action: 'create', when: 'in 1h' }, /needs the prompt/],
    [{ action: 'create', prompt: 'x' }, /needs when/],
    [{ action: 'create', prompt: 'x', when: 'soon' }, /say when it runs/],
    [{ action: 'create', prompt: 'x', when: 'in 1h', max_cost_usd: 0 }, /max_cost_usd/],
    [{ action: 'create', prompt: 'x', when: 'in 1h', paused: true }, /starts unpaused/],
    [{ action: 'update', id: 'sch_000001' }, /something to change/],
    [{ action: 'delete' }, /needs the id/],
    [{ action: 'list', cron: '* * * * *' }, /unknown field "cron"/],
    [{ action: 'create', prompt: 'x', when: 'in 1h', title: 'x'.repeat(61) }, /keep it to 60/],
  ])('refuses %j', (raw, problem) => {
    const parsed = parse(raw);
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(parsed.problem).toMatch(problem);
  });

  it('is offered only where somebody can approve it and the engine keeps schedules', () => {
    expect(scheduleToolDefinitions('ask', true).map((tool) => tool.name)).toEqual(['schedule_task']);
    expect(scheduleToolDefinitions('plan', true)).toHaveLength(1);
    expect(scheduleToolDefinitions('non-interactive', true)).toEqual([]);
    expect(scheduleToolDefinitions('auto', false)).toEqual([]);
  });

  it('gives each task an id the model can copy, unique in the workspace', () => {
    const first = daily9('2026-10-01T08:00:00Z');
    expect(first.id).toMatch(/^sch_[0-9a-f]{6}$/);
    let calls = 0;
    expect(scheduleIdOf(() => (calls++ === 0 ? 0.5 : 0.25), [first])).toBe('sch_400000');
  });

  it('runs an at-task only once', () => {
    expect(nextOccurrence({ kind: 'at', at: 10 }, 9, UTC)).toBe(10);
    expect(nextOccurrence({ kind: 'at', at: 10 }, 10, UTC)).toBeNull();
  });
});
