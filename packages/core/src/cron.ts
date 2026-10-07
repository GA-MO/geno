import type { Parsed } from './ask-user.js';

/**
 * Five-field cron schedules and wall-clock time in a time zone. Times are ms since the epoch; a `Wall` is what a clock
 * in the zone reads. Pure, with the zone passed in, so tests pin it; the webview bundles this file.
 */

/** `month` is 1 to 12. */
export type Wall = { readonly year: number; readonly month: number; readonly day: number; readonly hour: number; readonly minute: number };

export type Cron = {
  readonly expr: string;
  readonly minutes: readonly number[];
  readonly hours: readonly number[];
  readonly days: ReadonlySet<number>;
  readonly months: ReadonlySet<number>;
  /** 0 is Sunday; a 7 in the expression reads as 0. */
  readonly weekdays: ReadonlySet<number>;
  /** The day-of-month or day-of-week field is `*`: then a day must match both, otherwise either, as Vixie cron does. */
  readonly anyDay: boolean;
};

const MINUTE = 60_000;
const DAY = 86_400_000;
/** A schedule with no run in five years, such as February 30, never runs. */
const SEARCH_DAYS = 366 * 5;

export const WEEKDAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'] as const;
export const MONTH_NAMES = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'] as const;

type Field = { readonly name: string; readonly min: number; readonly max: number; readonly names?: readonly string[]; readonly first?: number };

const FIELDS: readonly Field[] = [
  { name: 'minute', min: 0, max: 59 },
  { name: 'hour', min: 0, max: 23 },
  { name: 'day of the month', min: 1, max: 31 },
  { name: 'month', min: 1, max: 12, names: MONTH_NAMES, first: 1 },
  { name: 'day of the week', min: 0, max: 7, names: WEEKDAY_NAMES, first: 0 },
];

const CRON_MACROS: Readonly<Record<string, string>> = {
  '@hourly': '0 * * * *',
  '@daily': '0 0 * * *',
  '@midnight': '0 0 * * *',
  '@weekly': '0 0 * * 0',
  '@monthly': '0 0 1 * *',
  '@yearly': '0 0 1 1 *',
  '@annually': '0 0 1 1 *',
};

const fail = (problem: string): Parsed<never> => ({ ok: false, problem });

function valueOf(token: string, field: Field): number | undefined {
  if (/^\d+$/.test(token)) return Number(token);
  const at = field.names?.findIndex((name) => name.toLowerCase() === token.toLowerCase()) ?? -1;
  return at === -1 ? undefined : at + (field.first ?? 0);
}

function parseField(text: string, field: Field): Parsed<number[]> {
  const values = new Set<number>();
  for (const part of text.split(',')) {
    const match = /^(\*|[a-z0-9]+(?:-[a-z0-9]+)?)(?:\/(\d+))?$/i.exec(part);
    if (match === null) return fail(`the ${field.name} field "${text}" is not a number, range, list or step`);
    const [, range, stepText] = match as unknown as [string, string, string | undefined];
    const step = stepText === undefined ? 1 : Number(stepText);
    if (step < 1) return fail(`the ${field.name} field "${text}" has a step of 0`);
    const [from, to] = range === '*' ? [String(field.min), String(field.max)] : range.split('-');
    const lo = valueOf(from!, field);
    const hi = to === undefined ? (stepText === undefined ? lo : field.max) : valueOf(to, field);
    if (lo === undefined || hi === undefined) return fail(`the ${field.name} field "${text}" names no ${field.name}`);
    if (lo < field.min || hi > field.max || lo > hi) return fail(`the ${field.name} field "${text}" is outside ${field.min} to ${field.max}`);
    for (let value = lo; value <= hi; value += step) values.add(field.name === 'day of the week' && value === 7 ? 0 : value);
  }
  return { ok: true, value: [...values].toSorted((a, b) => a - b) };
}

const cache = new Map<string, Cron>();

/** A 5-field cron expression (minute hour day month weekday), or a macro such as `@daily`. */
export function parseCron(raw: string): Parsed<Cron> {
  const expr = raw.trim().replace(/\s+/g, ' ');
  const known = cache.get(expr);
  if (known !== undefined) return { ok: true, value: known };
  const parts = (CRON_MACROS[expr.toLowerCase()] ?? expr).split(' ');
  if (parts.length !== 5) return fail(`a cron schedule has 5 fields (minute hour day month weekday), such as "0 9 * * 1-5"; "${expr}" has ${parts.length}`);
  const fields: number[][] = [];
  for (const [i, part] of parts.entries()) {
    const parsed = parseField(part, FIELDS[i]!);
    if (!parsed.ok) return parsed;
    fields.push(parsed.value);
  }
  const [minutes, hours, days, months, weekdays] = fields as [number[], number[], number[], number[], number[]];
  const cron: Cron = { expr, minutes, hours, days: new Set(days), months: new Set(months), weekdays: new Set(weekdays), anyDay: parts[2]!.startsWith('*') || parts[4]!.startsWith('*') };
  cache.set(expr, cron);
  return { ok: true, value: cron };
}

const formats = new Map<string, Intl.DateTimeFormat>();

function formatIn(zone: string): Intl.DateTimeFormat {
  let format = formats.get(zone);
  if (format === undefined) {
    format = new Intl.DateTimeFormat('en-US', { timeZone: zone, hourCycle: 'h23', year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric' });
    formats.set(zone, format);
  }
  return format;
}

/** The zone this process runs in, which "local time" means. */
export const localZone = (): string => Intl.DateTimeFormat().resolvedOptions().timeZone;

export function wallOf(ms: number, zone: string): Wall {
  const parts = Object.fromEntries(formatIn(zone).formatToParts(ms).map((part) => [part.type, part.value]));
  return { year: Number(parts['year']), month: Number(parts['month']), day: Number(parts['day']), hour: Number(parts['hour']) % 24, minute: Number(parts['minute']) };
}

const utcOf = (wall: Wall): number => Date.UTC(wall.year, wall.month - 1, wall.day, wall.hour, wall.minute);
const offsetAt = (ms: number, zone: string): number => utcOf(wallOf(ms, zone)) - Math.floor(ms / MINUTE) * MINUTE;
const sameWall = (a: Wall, b: Wall): boolean => a.year === b.year && a.month === b.month && a.day === b.day && a.hour === b.hour && a.minute === b.minute;

/**
 * The instant a wall-clock minute names in `zone`. A minute the clock shows twice, as it goes back, is its first
 * showing; a minute it skips, as it goes forward, moves later by the skipped time, as Temporal's `compatible` does.
 */
export function instantOf(wall: Wall, zone: string): number {
  const guess = utcOf(wall);
  // No zone moves its clock twice within two days, so the offsets a day either side are the only two in play.
  const before = guess - offsetAt(guess - DAY, zone);
  const after = guess - offsetAt(guess + DAY, zone);
  const valid = [before, after].filter((at) => sameWall(wallOf(at, zone), wall));
  return valid.length === 0 ? before : Math.min(...valid);
}

export const weekdayOf = (wall: Pick<Wall, 'year' | 'month' | 'day'>): number => new Date(Date.UTC(wall.year, wall.month - 1, wall.day)).getUTCDay();

function dayMatches(cron: Cron, date: Date): boolean {
  if (!cron.months.has(date.getUTCMonth() + 1)) return false;
  const day = cron.days.has(date.getUTCDate());
  const weekday = cron.weekdays.has(date.getUTCDay());
  return cron.anyDay ? day && weekday : day || weekday;
}

/** The first instant after `after` that the schedule names in `zone`, or null when none comes within five years. */
export function nextCronAfter(cron: Cron, after: number, zone: string): number | null {
  const start = wallOf(after, zone);
  let date = Date.UTC(start.year, start.month - 1, start.day);
  for (let i = 0; i < SEARCH_DAYS; i++, date += DAY) {
    const calendar = new Date(date);
    if (!dayMatches(cron, calendar)) continue;
    const ymd = { year: calendar.getUTCFullYear(), month: calendar.getUTCMonth() + 1, day: calendar.getUTCDate() };
    const first = instantOf({ ...ymd, hour: 0, minute: 0 }, zone);
    const last = instantOf({ ...ymd, hour: 23, minute: 59 }, zone);
    // A day the clock does not move keeps one offset, so a wall minute is plain arithmetic, in order.
    const steady = last - first === (23 * 60 + 59) * MINUTE;
    let best: number | null = null;
    for (const hour of cron.hours) {
      for (const minute of cron.minutes) {
        const wall = { ...ymd, hour, minute };
        const at = steady ? first + (utcOf(wall) - date) : instantOf(wall, zone);
        if (at <= after) continue;
        if (steady) return at;
        best = best === null ? at : Math.min(best, at);
      }
    }
    if (best !== null) return best;
  }
  return null;
}
