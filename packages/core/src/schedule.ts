import type { Tool } from '@anthropic-ai/sdk/resources/messages/messages';
import type { ApprovalMode } from './approval.js';
import type { Parsed } from './ask-user.js';
import { instantOf, MONTH_NAMES, nextCronAfter, parseCron, wallOf, WEEKDAY_NAMES, weekdayOf, type Wall } from './cron.js';
import type { TurnEvent } from './session.js';
import type { Brand } from './types.js';

/**
 * Scheduled tasks: a prompt the engine runs by itself, once or on a cron schedule in local time, each run a new
 * background session with its own budget. The engine keeps them per workspace in its home, so they outlive it. Each
 * time the engine looks, `planDue` says what a task needs now: nothing, a wait, a run, or a record of runs missed.
 * The webview bundles this file, so it imports only types and the pure cron module.
 */

export type ScheduleId = Brand<string, 'ScheduleId'>;

/** A cron expression in the engine's local time, or one instant. */
export type When = { readonly kind: 'cron'; readonly expr: string } | { readonly kind: 'at'; readonly at: number };

export type ScheduleBudget = { readonly maxCostUsd: number; readonly maxTurns: number };

/** A run spends money with nobody watching, so the default is small; a task asks for more when it needs it. */
export const DEFAULT_SCHEDULE_BUDGET: ScheduleBudget = { maxCostUsd: 0.05, maxTurns: 20 };

/** `runs` is how many of a task's runs it keeps, newest last. */
export const SCHEDULE_LIMITS = { title: 60, prompt: 8000, maxCostUsd: 1, maxTurns: 100, tasks: 50, runs: 10 } as const;

/**
 * `graceMs`: a run missed while the engine was off still runs, once, if the engine starts within this long of it.
 * `lateMs`: a run that starts later than this after it came due is a catch-up.
 */
export type SchedulePolicy = { readonly graceMs: number; readonly lateMs: number };
export const SCHEDULE_POLICY: SchedulePolicy = { graceMs: 60 * 60_000, lateMs: 60_000 };

export type ScheduleAuthor = { readonly kind: 'user' } | { readonly kind: 'model'; readonly sessionId: string };

/** `now` is the user's Run now; `catch-up` a run that came due while the engine was off or asleep. */
export type RunTrigger = 'schedule' | 'catch-up' | 'now';

export const RUN_END_KINDS = ['done', 'failed', 'stopped', 'budget', 'max-turns'] as const;
export type RunEndKind = (typeof RUN_END_KINDS)[number];
export type RunEnd = { readonly kind: RunEndKind; readonly at: number; readonly costUsd: number | null; readonly message?: string | undefined };

/** Occurrences that did not run: the engine was off past the grace window, or the task's last run still ran. */
export type Missed = { readonly from: number; readonly to: number; readonly count: number; readonly why: 'off' | 'busy' };

export type ScheduleRun =
  /** `by` is the engine's pid; `end` is null while the run goes on. `workspace` is where its session runs: a lane, or the main checkout. */
  | {
      readonly kind: 'ran';
      readonly dueAt: number;
      readonly trigger: RunTrigger;
      readonly startedAt: number;
      readonly sessionId: string;
      readonly workspace: string;
      readonly lane: string | null;
      readonly by: number;
      readonly end: RunEnd | null;
    }
  | ({ readonly kind: 'missed'; readonly at: number } & Missed)
  /** The session could not start, such as an edit task in a folder that is not a git repository. */
  | { readonly kind: 'not-started'; readonly dueAt: number; readonly trigger: RunTrigger; readonly at: number; readonly message: string };

/** `edits` runs each session in its own lane in Auto; otherwise in the main checkout in Plan, which is read-only. */
export type ScheduleDraft = { readonly title: string; readonly prompt: string; readonly when: When; readonly edits: boolean; readonly budget: ScheduleBudget };

/**
 * One scheduled task. `since` is the cursor: occurrences at or before it are settled, run or missed. It starts at the
 * creation time, and a resume or a new schedule moves it to that moment, so neither runs what came due before.
 */
export type ScheduledTask = ScheduleDraft & {
  readonly id: ScheduleId;
  readonly paused: boolean;
  readonly createdAt: number;
  readonly createdBy: ScheduleAuthor;
  readonly since: number;
  readonly runs: readonly ScheduleRun[];
};

export type SchedulePatch = Partial<ScheduleDraft & { readonly paused: boolean }>;

const fail = (problem: string): Parsed<never> => ({ ok: false, problem });
const isRecord = (raw: unknown): raw is Record<string, unknown> => typeof raw === 'object' && raw !== null && !Array.isArray(raw);

export function nextOccurrence(when: When, after: number, zone: string): number | null {
  if (when.kind === 'at') return when.at > after ? when.at : null;
  const cron = parseCron(when.expr);
  return cron.ok ? nextCronAfter(cron.value, after, zone) : null;
}

const HOUR = 60 * 60_000;

/** The latest occurrence in (since, until], or null. Looks back in growing windows, so a long gap costs a few searches. */
export function latestDue(when: When, since: number, until: number, zone: string): number | null {
  const first = nextOccurrence(when, since, zone);
  if (first === null || first > until) return null;
  for (let back = HOUR; ; back *= 4) {
    const from = Math.max(since, until - back);
    let at = from === since ? first : nextOccurrence(when, from, zone);
    if (at === null || at > until) continue;
    for (;;) {
      const next = nextOccurrence(when, at, zone);
      if (next === null || next > until) return at;
      at = next;
    }
  }
}

/** Counting stops here, so a long gap of a minutely schedule is "999+", not a long count. */
export const MISSED_COUNT_CAP = 999;

function countDue(when: When, since: number, until: number, zone: string): number {
  let count = 0;
  for (let at = nextOccurrence(when, since, zone); at !== null && at <= until && count < MISSED_COUNT_CAP; at = nextOccurrence(when, at, zone)) count++;
  return count;
}

export type DuePlan =
  | { readonly kind: 'none' }
  | { readonly kind: 'wait'; readonly at: number }
  /** Runs the latest occurrence due; `skipped` are the earlier ones it stands for. */
  | { readonly kind: 'run'; readonly dueAt: number; readonly trigger: Exclude<RunTrigger, 'now'>; readonly skipped: Missed | null }
  | { readonly kind: 'miss'; readonly missed: Missed };

/**
 * What a task needs at `now`. The missed-run rule: of the occurrences due since the cursor, only the latest may run,
 * and only within the grace window of its time; the rest, or all of them past the window, are recorded as missed. A
 * task whose last run still runs misses what comes due meanwhile.
 */
export function planDue(task: ScheduledTask, now: number, zone: string, policy: SchedulePolicy, busy: boolean): DuePlan {
  if (task.paused) return { kind: 'none' };
  const latest = latestDue(task.when, task.since, now, zone);
  if (latest === null) {
    const next = nextOccurrence(task.when, task.since, zone);
    return next === null ? { kind: 'none' } : { kind: 'wait', at: next };
  }
  const first = nextOccurrence(task.when, task.since, zone)!;
  if (busy || now - latest > policy.graceMs) {
    return { kind: 'miss', missed: { from: first, to: latest, count: countDue(task.when, task.since, latest, zone), why: busy ? 'busy' : 'off' } };
  }
  const before = latestDue(task.when, task.since, latest - 1, zone);
  const skipped: Missed | null = before === null ? null : { from: first, to: before, count: countDue(task.when, task.since, before, zone), why: 'off' };
  return { kind: 'run', dueAt: latest, trigger: now - latest > policy.lateMs ? 'catch-up' : 'schedule', skipped };
}

export const hasOpenRun = (task: ScheduledTask): boolean => task.runs.some((run) => run.kind === 'ran' && run.end === null);

export const withRuns = (task: ScheduledTask, ...runs: readonly ScheduleRun[]): ScheduledTask => ({ ...task, runs: [...task.runs, ...runs].slice(-SCHEDULE_LIMITS.runs) });

export const missedRun = (missed: Missed, at: number): ScheduleRun => ({ kind: 'missed', at, ...missed });

/** The task after its plan settled the occurrences up to `since`, with the runs that record it. */
export const settled = (task: ScheduledTask, since: number, ...runs: readonly ScheduleRun[]): ScheduledTask => ({ ...withRuns(task, ...runs), since: Math.max(task.since, since) });

/** A run's end; a run that already ended keeps its end. */
export const endRun = (task: ScheduledTask, sessionId: string, end: RunEnd): ScheduledTask => ({
  ...task,
  runs: task.runs.map((run) => (run.kind === 'ran' && run.sessionId === sessionId && run.end === null ? { ...run, end } : run)),
});

export const newTask = (id: ScheduleId, draft: ScheduleDraft, createdBy: ScheduleAuthor, now: number): ScheduledTask => ({
  ...draft,
  id,
  paused: false,
  createdAt: now,
  createdBy,
  since: now,
  runs: [],
});

/** A changed schedule, or a resume, starts counting from now: neither runs what came due before it. */
export function patchTask(task: ScheduledTask, patch: SchedulePatch, now: number): ScheduledTask {
  const next = { ...task, ...patch };
  const restarts = (patch.when !== undefined && JSON.stringify(patch.when) !== JSON.stringify(task.when)) || (task.paused && patch.paused === false);
  return restarts ? { ...next, since: Math.max(task.since, now) } : next;
}

/** How a run's session ended, read from its log: its last error, if any, decides. */
export function runEndOf(events: readonly TurnEvent[], at: number): RunEnd {
  const answers = events.filter((event) => event.kind === 'assistant');
  const costUsd = answers.some((event) => event.costUsd === null) ? null : answers.reduce((sum, event) => sum + (event.costUsd ?? 0), 0);
  const last = events.findLast((event) => event.kind === 'error' || event.kind === 'assistant' || event.kind === 'user');
  if (last?.kind !== 'error') return { kind: 'done', at, costUsd };
  const kind: RunEndKind = last.error === 'abort' ? 'stopped' : last.error === 'budget' || last.error === 'max-turns' ? last.error : 'failed';
  return { kind, at, costUsd, message: last.message };
}

export const SCHEDULE_ID_PATTERN = /^sch_[0-9a-f]{6}$/;

/** `sch_` and 6 hex digits, short enough for a model to copy back. */
export function scheduleIdOf(random: () => number, taken: readonly ScheduledTask[]): ScheduleId {
  const used = new Set<string>(taken.map((task) => task.id));
  for (;;) {
    const id = `sch_${Math.floor(random() * 0x1000000).toString(16).padStart(6, '0')}`;
    if (!used.has(id)) return id as ScheduleId;
  }
}

const pad = (n: number): string => String(n).padStart(2, '0');
const clock = ({ hour, minute }: Pick<Wall, 'hour' | 'minute'>): string => `${pad(hour)}:${pad(minute)}`;

/** "Thu 8 Oct 09:00", with the year when it is not `now`'s. */
export function formatAt(ms: number, zone: string, now?: number): string {
  const wall = wallOf(ms, zone);
  const year = now === undefined || wallOf(now, zone).year === wall.year ? '' : ` ${wall.year}`;
  return `${WEEKDAY_NAMES[weekdayOf(wall)]} ${wall.day} ${MONTH_NAMES[wall.month - 1]}${year} ${clock(wall)}`;
}

/** How a schedule reads: "Weekdays at 09:00", "Every day at 18:30", "Once, Thu 8 Oct 09:00", or the cron itself. */
export function describeWhen(when: When, zone: string, now?: number): string {
  if (when.kind === 'at') return `Once, ${formatAt(when.at, zone, now)}`;
  const daily = /^(\d+) (\d+) \* \* (\*|1-5|0,6)$/.exec(when.expr);
  if (daily !== null) {
    const at = clock({ hour: Number(daily[2]), minute: Number(daily[1]) });
    return { '*': `Every day at ${at}`, '1-5': `Weekdays at ${at}`, '0,6': `Weekends at ${at}` }[daily[3] as '*' | '1-5' | '0,6'];
  }
  const hourly = /^(\d+) \* \* \* \*$/.exec(when.expr);
  if (hourly !== null) return `Every hour at :${pad(Number(hourly[1]))}`;
  return `cron ${when.expr}`;
}

const usd = (n: number): string => `$${n.toFixed(n < 0.1 ? 3 : 2).replace(/(\.\d\d)0$/, '$1')}`;

export const budgetText = ({ maxCostUsd, maxTurns }: ScheduleBudget): string => `up to ${usd(maxCostUsd)} and ${maxTurns} model calls a run`;

/** One line about a task for the model and the approval card: when, next run, where it runs, and its budget. */
export function taskLine(task: ScheduleDraft & { readonly paused?: boolean }, zone: string, now: number): string {
  const next = nextOccurrence(task.when, now, zone);
  const nextText = task.paused === true ? 'paused' : next === null ? 'no run left' : `next ${formatAt(next, zone, now)}`;
  return `"${task.title}": ${describeWhen(task.when, zone, now)} (${nextText}), ${task.edits ? 'with edits, in its own lane' : 'read-only'}, ${budgetText(task.budget)}`;
}

const END_WORDS: Readonly<Record<RunEndKind, string>> = { done: 'done', failed: 'failed', stopped: 'stopped', budget: 'stopped at its budget', 'max-turns': 'stopped at its turn limit' };

export function runText(run: ScheduleRun, zone: string, now: number): string {
  switch (run.kind) {
    case 'ran': {
      const when = formatAt(run.startedAt, zone, now);
      if (run.end === null) return `running since ${when}`;
      const cost = run.end.costUsd === null ? '' : `, ${usd(run.end.costUsd)}`;
      return `${END_WORDS[run.end.kind]} (${when}${cost})`;
    }
    case 'missed': {
      const count = run.count >= MISSED_COUNT_CAP ? `${MISSED_COUNT_CAP}+ runs` : run.count === 1 ? 'the run' : `${run.count} runs`;
      const span = run.count === 1 ? formatAt(run.to, zone, now) : `${formatAt(run.from, zone, now)} to ${formatAt(run.to, zone, now)}`;
      return `missed ${count} of ${span}${run.why === 'off' ? ', while Geno was not running' : ', while the previous run still ran'}`;
    }
    case 'not-started':
      return `did not start: ${run.message}`;
  }
}

export const SCHEDULE_TASK_TOOL = 'schedule_task';
export const SCHEDULE_ACTIONS = ['create', 'list', 'update', 'delete'] as const;
export type ScheduleToolAction = (typeof SCHEDULE_ACTIONS)[number];

const WHEN_HELP = 'in 1h, in 30m, at 9:00, at 2026-10-08 09:00, daily at 18:30, weekdays at 9:00, or a 5-field cron such as 0 9 * * 1-5';

export const SCHEDULE_TASK_SPEC: Tool = {
  name: SCHEDULE_TASK_TOOL,
  description: `Create, list, change or delete a scheduled task: a prompt Geno runs by itself later, each run as a new background session, once or on a schedule in the user's local time. Use it only when the user asks for something to happen later or regularly, such as "every weekday at 9 run /review" or "in an hour, check the deploy". A run is unattended and spends money, so create, update and delete ask the user's approval; list does not. A run is read-only (Plan mode, in the main checkout) unless edits is true, which runs it in its own lane in Auto. Each run stops at its budget: max_cost_usd (default ${usd(DEFAULT_SCHEDULE_BUDGET.maxCostUsd)}, at most ${usd(SCHEDULE_LIMITS.maxCostUsd)}) and max_turns (default ${DEFAULT_SCHEDULE_BUDGET.maxTurns}, at most ${SCHEDULE_LIMITS.maxTurns}). The prompt is the run's first message and the run does not see this conversation, so make it self-contained; it may be a slash command such as /review. A run missed while Geno was not running runs once when it starts again, if that is within an hour.`,
  input_schema: {
    type: 'object',
    properties: {
      action: { type: 'string', enum: [...SCHEDULE_ACTIONS] },
      id: { type: 'string', description: 'For update and delete: the task id, such as sch_1a2b3c, from create or list.' },
      title: { type: 'string', maxLength: SCHEDULE_LIMITS.title, description: 'A short name, such as "Review main". Defaults to the prompt\'s start.' },
      prompt: { type: 'string', description: 'What each run does: its first message, self-contained.' },
      when: { type: 'string', description: `When it runs: ${WHEN_HELP}.` },
      edits: { type: 'boolean', description: 'true to let runs change files, each in its own lane. Defaults to false: read-only.' },
      max_cost_usd: { type: 'number', description: `The most one run may spend, in US dollars. Defaults to ${DEFAULT_SCHEDULE_BUDGET.maxCostUsd}.` },
      max_turns: { type: 'integer', description: `The most model calls one run may make. Defaults to ${DEFAULT_SCHEDULE_BUDGET.maxTurns}.` },
      paused: { type: 'boolean', description: 'For update: true pauses the task, false resumes it.' },
    },
    required: ['action'],
    additionalProperties: false,
  },
};

/** Only a session someone watches can approve a schedule; a non-interactive run has nobody to ask. */
export const SCHEDULE_MODES: Readonly<Record<ApprovalMode, boolean>> = { plan: true, ask: true, auto: true, 'non-interactive': false };

/** The tool a run offers: none unless the mode allows it and the engine keeps schedules for an editor that shows them. */
export const scheduleToolDefinitions = (mode: ApprovalMode, attached: boolean): readonly Tool[] => (attached && SCHEDULE_MODES[mode] ? [SCHEDULE_TASK_SPEC] : []);

export type ScheduleToolInput =
  | { readonly action: 'create'; readonly draft: ScheduleDraft }
  | { readonly action: 'list' }
  /** `budget` names only the limits to change; the others stay. */
  | { readonly action: 'update'; readonly id: string; readonly patch: Omit<SchedulePatch, 'budget'>; readonly budget: Partial<ScheduleBudget> }
  | { readonly action: 'delete'; readonly id: string };

const DURATION_UNITS: readonly (readonly [RegExp, number])[] = [
  [/^(m|mins?|minutes?)$/, 60_000],
  [/^(h|hrs?|hours?)$/, HOUR],
  [/^(d|days?)$/, 24 * HOUR],
];

const UNIT = String.raw`(?:minutes?|mins?|m|hours?|hrs?|h|days?|d)(?=\d|\s|$)`;

function parseDuration(text: string): Parsed<number> {
  const parts = [...text.matchAll(/(\d+)\s*([a-z]+)/gi)];
  let total = 0;
  for (const [, amount, unit] of parts) {
    const scale = DURATION_UNITS.find(([pattern]) => pattern.test(unit!.toLowerCase()))?.[1];
    if (scale === undefined) return fail(`"${unit}" is not a unit; use m, h or d`);
    total += Number(amount) * scale;
  }
  if (total < 60_000) return fail('a delay is at least 1 minute');
  if (total > 366 * 24 * HOUR) return fail('a delay is at most a year');
  return { ok: true, value: total };
}

const TIME = String.raw`\d{1,2}(?::\d{2})?\s*(?:am|pm)?`;

function parseClock(text: string): Parsed<{ readonly hour: number; readonly minute: number }> {
  const match = /^(\d{1,2})(?::(\d{2}))?\s*(am|pm)?$/i.exec(text.trim());
  if (match === null) return fail(`"${text}" is not a time such as 9:00 or 18:30`);
  const [, h, m, half] = match;
  let hour = Number(h);
  const minute = m === undefined ? 0 : Number(m);
  if (half !== undefined) {
    if (hour < 1 || hour > 12) return fail(`"${text}" is not a time`);
    hour = (hour % 12) + (half.toLowerCase() === 'pm' ? 12 : 0);
  } else if (m === undefined) return fail(`"${text}" needs minutes, such as ${hour}:00`);
  if (hour > 23 || minute > 59) return fail(`"${text}" is not a time`);
  return { ok: true, value: { hour, minute } };
}

function nextClock(hour: number, minute: number, now: number, zone: string): number {
  const today = wallOf(now, zone);
  const at = instantOf({ ...today, hour, minute }, zone);
  if (at > now) return at;
  const tomorrow = new Date(Date.UTC(today.year, today.month - 1, today.day + 1));
  return instantOf({ year: tomorrow.getUTCFullYear(), month: tomorrow.getUTCMonth() + 1, day: tomorrow.getUTCDate(), hour, minute }, zone);
}

type WhenForm = { readonly pattern: RegExp; readonly read: (match: RegExpExecArray, now: number, zone: string) => Parsed<When> };

const cronOf = (expr: string): Parsed<When> => {
  const cron = parseCron(expr);
  return cron.ok ? { ok: true, value: { kind: 'cron', expr: cron.value.expr } } : cron;
};

const dailyAt = (days: string) => (match: RegExpExecArray): Parsed<When> => {
  const time = parseClock(match[1]!);
  return time.ok ? { ok: true, value: { kind: 'cron', expr: `${time.value.minute} ${time.value.hour} * * ${days}` } } : time;
};

/** Each form `when` takes, matched at the start of the text; the rest is the prompt. */
const WHEN_FORMS: readonly WhenForm[] = [
  {
    pattern: new RegExp(String.raw`^in\s+((?:\d+\s*${UNIT}\s*)+)`, 'i'),
    read: (match, now) => {
      const delay = parseDuration(match[1]!.trim());
      return delay.ok ? { ok: true, value: { kind: 'at', at: now + delay.value } } : delay;
    },
  },
  {
    pattern: /^at\s+(\d{4})-(\d{2})-(\d{2})[ T](\d{1,2}):(\d{2})(?=\s|$)/i,
    read: ([, y, mo, d, h, mi], now, zone) => {
      const wall = { year: Number(y), month: Number(mo), day: Number(d), hour: Number(h), minute: Number(mi) };
      const date = new Date(Date.UTC(wall.year, wall.month - 1, wall.day));
      if (date.getUTCMonth() !== wall.month - 1 || date.getUTCDate() !== wall.day || wall.hour > 23 || wall.minute > 59) return fail(`${y}-${mo}-${d} ${h}:${mi} does not exist`);
      const at = instantOf(wall, zone);
      return at > now ? { ok: true, value: { kind: 'at', at } } : fail(`${formatAt(at, zone, now)} has passed`);
    },
  },
  {
    pattern: new RegExp(String.raw`^at\s+(${TIME})(?=\s|$)`, 'i'),
    read: (match, now, zone) => {
      const time = parseClock(match[1]!);
      return time.ok ? { ok: true, value: { kind: 'at', at: nextClock(time.value.hour, time.value.minute, now, zone) } } : time;
    },
  },
  { pattern: new RegExp(String.raw`^(?:every\s+day|daily)\s+at\s+(${TIME})(?=\s|$)`, 'i'), read: dailyAt('*') },
  { pattern: new RegExp(String.raw`^(?:every\s+weekday|weekdays)\s+at\s+(${TIME})(?=\s|$)`, 'i'), read: dailyAt('1-5') },
  { pattern: /^cron\s+"([^"]+)"/i, read: (match) => cronOf(match[1]!) },
  { pattern: /^(?:cron\s+)?(@[a-z]+)(?=\s|$)/i, read: (match) => cronOf(match[1]!) },
  { pattern: /^(?:cron\s+)?([\d*][^\s]*(?:\s+[^\s]+){4})/i, read: (match) => cronOf(match[1]!) },
];

function readWhen(text: string, now: number, zone: string): Parsed<{ readonly when: When; readonly rest: string }> {
  const trimmed = text.trim();
  for (const form of WHEN_FORMS) {
    const match = form.pattern.exec(trimmed);
    if (match === null) continue;
    const when = form.read(match, now, zone);
    if (!when.ok) return when;
    if (nextOccurrence(when.value, now, zone) === null) return fail(`"${match[0]}" never runs`);
    return { ok: true, value: { when: when.value, rest: trimmed.slice(match[0].length).trim() } };
  }
  return fail(`say when it runs: ${WHEN_HELP}`);
}

/** A whole `when` text, such as the tool's field. */
export function parseWhen(text: string, now: number, zone: string): Parsed<When> {
  const read = readWhen(text, now, zone);
  if (!read.ok) return read;
  return read.value.rest === '' ? { ok: true, value: read.value.when } : fail(`"${read.value.rest}" follows the time; ${WHEN_HELP}`);
}

function parseBudget(cost: unknown, turns: unknown, base: ScheduleBudget = DEFAULT_SCHEDULE_BUDGET): Parsed<ScheduleBudget> {
  const maxCostUsd = cost ?? base.maxCostUsd;
  const maxTurns = turns ?? base.maxTurns;
  if (typeof maxCostUsd !== 'number' || !(maxCostUsd > 0) || maxCostUsd > SCHEDULE_LIMITS.maxCostUsd) return fail(`max_cost_usd is more than 0 and at most ${SCHEDULE_LIMITS.maxCostUsd}`);
  if (typeof maxTurns !== 'number' || !Number.isInteger(maxTurns) || maxTurns < 1 || maxTurns > SCHEDULE_LIMITS.maxTurns) return fail(`max_turns is a whole number from 1 to ${SCHEDULE_LIMITS.maxTurns}`);
  return { ok: true, value: { maxCostUsd, maxTurns } };
}

const titleOf = (prompt: string): string => {
  const line = prompt.replace(/\s+/g, ' ').trim();
  return line.length <= SCHEDULE_LIMITS.title ? line : `${line.slice(0, SCHEDULE_LIMITS.title - 1).trimEnd()}…`;
};

function textField(raw: Record<string, unknown>, field: 'title' | 'prompt'): Parsed<string | undefined> {
  const value = raw[field];
  if (value === undefined) return { ok: true, value: undefined };
  if (typeof value !== 'string' || value.trim() === '') return fail(`${field} is a non-empty string`);
  if (value.trim().length > SCHEDULE_LIMITS[field]) return fail(`${field} is ${value.trim().length} characters; keep it to ${SCHEDULE_LIMITS[field]}`);
  return { ok: true, value: value.trim() };
}

const TOOL_FIELDS = ['action', 'id', 'title', 'prompt', 'when', 'edits', 'max_cost_usd', 'max_turns', 'paused'];

/** The model's schedule_task input, or what is wrong with it, in words it can act on. */
export function parseScheduleTask(raw: unknown, now: number, zone: string): Parsed<ScheduleToolInput> {
  if (!isRecord(raw) || !SCHEDULE_ACTIONS.includes(raw['action'] as ScheduleToolAction)) return fail(`${SCHEDULE_TASK_TOOL} takes an action: ${SCHEDULE_ACTIONS.join(', ')}`);
  const extra = Object.keys(raw).find((key) => !TOOL_FIELDS.includes(key));
  if (extra !== undefined) return fail(`${SCHEDULE_TASK_TOOL} has an unknown field "${extra}"`);
  const action = raw['action'] as ScheduleToolAction;
  if (action === 'list') return { ok: true, value: { action } };
  if (action !== 'create' && (typeof raw['id'] !== 'string' || raw['id'].trim() === '')) return fail(`${action} needs the id of a task, from list`);
  const id = String(raw['id'] ?? '').trim();
  if (action === 'delete') return { ok: true, value: { action, id } };
  const title = textField(raw, 'title');
  if (!title.ok) return title;
  const prompt = textField(raw, 'prompt');
  if (!prompt.ok) return prompt;
  const when = raw['when'] === undefined ? undefined : typeof raw['when'] === 'string' ? parseWhen(raw['when'], now, zone) : fail(`when is text: ${WHEN_HELP}`);
  if (when !== undefined && !when.ok) return when;
  for (const flag of ['edits', 'paused'] as const) if (raw[flag] !== undefined && typeof raw[flag] !== 'boolean') return fail(`${flag} is true or false`);
  if (action === 'create') {
    if (prompt.value === undefined) return fail('create needs the prompt each run starts with');
    if (when === undefined) return fail(`create needs when: ${WHEN_HELP}`);
    if (raw['paused'] !== undefined) return fail('a task starts unpaused; pause it with update');
    const budget = parseBudget(raw['max_cost_usd'], raw['max_turns']);
    if (!budget.ok) return budget;
    return { ok: true, value: { action, draft: { title: title.value ?? titleOf(prompt.value), prompt: prompt.value, when: when.value, edits: raw['edits'] === true, budget: budget.value } } };
  }
  const budget = Object.fromEntries(
    (
      [
        ['maxCostUsd', raw['max_cost_usd']],
        ['maxTurns', raw['max_turns']],
      ] as const
    ).filter(([, value]) => value !== undefined),
  ) as Partial<ScheduleBudget>;
  const patch = Object.fromEntries(Object.entries({ title: title.value, prompt: prompt.value, when: when?.value, edits: raw['edits'], paused: raw['paused'] }).filter(([, value]) => value !== undefined));
  if (Object.keys(patch).length === 0 && Object.keys(budget).length === 0) return fail('update needs something to change');
  return { ok: true, value: { action, id, patch, budget } };
}

/** The task an update makes, or why its budget is out of bounds. */
export function updatedTask(task: ScheduledTask, update: Extract<ScheduleToolInput, { action: 'update' }>, now: number): Parsed<ScheduledTask> {
  const budget = parseBudget(update.budget.maxCostUsd, update.budget.maxTurns, task.budget);
  if (!budget.ok) return budget;
  return { ok: true, value: patchTask(task, { ...update.patch, budget: budget.value }, now) };
}

/**
 * `/schedule <when> [--edits] [--max-cost <usd>] [--max-turns <n>] <prompt>`, as the user types it. The flags come
 * between the time and the prompt, so a prompt can say anything.
 */
export function parseScheduleCommand(args: string, now: number, zone: string): Parsed<ScheduleDraft> {
  const read = readWhen(args, now, zone);
  if (!read.ok) return read;
  let rest = read.value.rest;
  const flags: { edits: boolean; cost?: number; turns?: number } = { edits: false };
  for (;;) {
    if (/^--edits(?=\s|$)/.test(rest)) {
      flags.edits = true;
      rest = rest.slice('--edits'.length).trimStart();
      continue;
    }
    const match = /^--(max-cost|max-turns)(?=\s|$)\s*(\d+(?:\.\d+)?(?=\s|$))?\s*/.exec(rest);
    if (match === null) break;
    const [whole, name, value] = match as unknown as [string, string, string | undefined];
    if (value === undefined) return fail(`--${name} takes a number`);
    if (name === 'max-cost') flags.cost = Number(value);
    else flags.turns = Number(value);
    rest = rest.slice(whole.length);
  }
  if (rest === '') return fail('say what each run does after the time, such as /schedule weekdays at 9:00 run /review on main');
  if (rest.length > SCHEDULE_LIMITS.prompt) return fail(`the prompt is ${rest.length} characters; keep it to ${SCHEDULE_LIMITS.prompt}`);
  const budget = parseBudget(flags.cost, flags.turns);
  if (!budget.ok) return { ok: false, problem: budget.problem.replace('max_cost_usd', '--max-cost').replace('max_turns', '--max-turns') };
  return { ok: true, value: { title: titleOf(rest), prompt: rest, when: read.value.when, edits: flags.edits, budget: budget.value } };
}

export const SCHEDULE_USAGE = `Usage: /schedule <when> [--edits] [--max-cost <usd>] [--max-turns <n>] <prompt>. When is ${WHEN_HELP}. Runs are read-only unless --edits, and each stops at ${budgetText(DEFAULT_SCHEDULE_BUDGET)} unless the flags say otherwise.`;

/** What the model or the user asks to change, as the approval card states it. */
export type ScheduleChange =
  | { readonly kind: 'create'; readonly draft: ScheduleDraft }
  | { readonly kind: 'update'; readonly task: ScheduledTask; readonly next: ScheduledTask }
  | { readonly kind: 'delete'; readonly task: ScheduledTask };

export function scheduleQuestion(change: ScheduleChange, zone: string, now: number): string {
  switch (change.kind) {
    case 'create':
      return `Schedule ${taskLine(change.draft, zone, now)}?`;
    case 'update':
      return `Change the scheduled task ${change.task.id} to ${taskLine(change.next, zone, now)}?`;
    case 'delete':
      return `Delete the scheduled task ${change.task.id} ${taskLine(change.task, zone, now)}?`;
  }
}

export const SCHEDULE_REASON = 'A scheduled task runs by itself, with nobody watching, and each run spends up to its budget.';

export function scheduleListText(tasks: readonly ScheduledTask[], zone: string, now: number): string {
  if (tasks.length === 0) return 'No scheduled tasks in this workspace.';
  return tasks
    .map((task) => {
      const last = task.runs.at(-1);
      return `- ${task.id} ${taskLine(task, zone, now)}; last run: ${last === undefined ? 'none yet' : runText(last, zone, now)}`;
    })
    .join('\n');
}

/** Follows the mode's system prompt in a scheduled run's session: nobody is there to answer or to read a plan. */
export const SCHEDULED_RUN_NOTE =
  'This session is a scheduled task that runs by itself: nobody reads it until it ends, and nobody can answer a question. Do what the first message asks, then end with a short report of what you found or changed. In Plan mode, report your findings rather than a plan to build.';

/** Key in the client capabilities' `_meta`: true when it lists scheduled tasks and takes SCHEDULES_UPDATE_METHOD. */
export const SCHEDULES_CAPABILITY = 'gcode/schedules';

/** A task with its next run as the engine computes it, in its own zone; null while paused or when none is left. */
export type ScheduleView = ScheduledTask & { readonly nextAt: number | null };

/** The workspace's scheduled tasks, in the order they were made. */
export const SCHEDULES_METHOD = '_gcode/schedules';
export type SchedulesRequest = { readonly cwd: string };
export type SchedulesResponse = { readonly workspace: string; readonly tasks: readonly ScheduleView[] };

export const SCHEDULE_PANEL_ACTIONS = ['run', 'pause', 'resume', 'delete'] as const;
export type SchedulePanelAction = (typeof SCHEDULE_PANEL_ACTIONS)[number];

/** The Tasks list's Run now, Pause, Resume and Delete. Answers with the workspace's list. */
export const SCHEDULE_ACT_METHOD = '_gcode/schedules/act';
export type ScheduleActRequest = { readonly cwd: string; readonly id: string; readonly action: SchedulePanelAction };

/** A notification to every editor that advertises SCHEDULES_CAPABILITY whenever a workspace's tasks change. */
export const SCHEDULES_UPDATE_METHOD = '_gcode/schedulesUpdate';
export type SchedulesUpdate = SchedulesResponse;
