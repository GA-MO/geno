import type { TurnEvent } from './session.js';

/**
 * A model call that cannot go out yet, held instead of failing its turn. `offline`: the provider's host does not
 * answer. `limited`: the provider throttled the call.
 */
export const WAIT_KINDS = ['offline', 'limited'] as const;
export type WaitKind = (typeof WAIT_KINDS)[number];

/** Times are ms since the epoch. */
export type Waiting = {
  readonly kind: WaitKind;
  /** When this wait began; the give-up limits count from here. */
  readonly since: number;
  /** The next automatic try: a probe of the host when offline, the call itself when limited. Null waits for the user. */
  readonly retryAt: number | null;
  /** When the provider said its limit resets; null when it did not say, and always when offline. */
  readonly resetAt: number | null;
  /** The failure that started or last extended the wait, redacted. */
  readonly message: string;
};

/** The log event a wait leaves, written as it begins or changes course, so a restarted engine finds it and waits on. */
export type WaitEvent = { readonly kind: 'wait'; readonly seq: number; readonly at: string; readonly wait: Waiting };

type Backoff = { readonly firstMs: number; readonly maxMs: number };

/**
 * The schedules. Offline probes back off from `firstMs` to `maxMs` and give up `giveUpMs` after the wait began. A
 * limit with a known reset resumes at the reset plus up to `jitterMs`; one with no known reset backs off the same way
 * and gives up after `giveUpMs`. A limit whose wait runs past `autoMaxMs` resumes by itself only when the setting says so.
 */
export type WaitPolicy = {
  readonly offline: Backoff & { readonly giveUpMs: number };
  readonly limited: Backoff & { readonly giveUpMs: number; readonly jitterMs: number; readonly autoMaxMs: number };
};

export const WAIT_POLICY: WaitPolicy = {
  offline: { firstMs: 5000, maxMs: 60_000, giveUpMs: 30 * 60_000 },
  limited: { firstMs: 15_000, maxMs: 5 * 60_000, giveUpMs: 15 * 60_000, jitterMs: 3000, autoMaxMs: 15 * 60_000 },
};

/**
 * The `gcode.resume.afterLimit` setting. `short` resumes by itself after a limit only when the wait is at most
 * `autoMaxMs`; `always` after any limit; `off` never. A longer or unresumed wait holds until the user retries or stops.
 * Offline waits always resume by themselves.
 */
export const RESUME_AFTER_LIMIT = ['short', 'always', 'off'] as const;
export type ResumeAfterLimit = (typeof RESUME_AFTER_LIMIT)[number];
export const DEFAULT_RESUME_AFTER_LIMIT: ResumeAfterLimit = 'short';
export const isResumeAfterLimit = (raw: string): raw is ResumeAfterLimit => (RESUME_AFTER_LIMIT as readonly string[]).includes(raw);

/** What the wait does next: try again at `at`, hold for the user, or give up with `message`. */
export type WaitPlan = { readonly kind: 'at'; readonly at: number } | { readonly kind: 'hold' } | { readonly kind: 'give-up'; readonly message: string };

/** Where a wait stands: its kind and start, how many tries already failed in it, and the reset the last failure named. */
export type WaitClock = { readonly kind: WaitKind; readonly since: number; readonly tries: number; readonly resetAt: number | null };

const backoffMs = ({ firstMs, maxMs }: Backoff, tries: number): number => Math.min(firstMs * 2 ** tries, maxMs);

const minutes = (ms: number): string => `${Math.round(ms / 60_000)} minutes`;

/** The next step of a wait, at `now`. `jitter` is a number in [0, 1), from Math.random outside tests. */
export function planWait(policy: WaitPolicy, clock: WaitClock, now: number, resume: ResumeAfterLimit, jitter: number): WaitPlan {
  if (clock.kind === 'offline') {
    const { giveUpMs } = policy.offline;
    if (now - clock.since >= giveUpMs) return { kind: 'give-up', message: `the provider has not answered for ${minutes(giveUpMs)}; check the connection and send again` };
    return { kind: 'at', at: Math.min(now + backoffMs(policy.offline, clock.tries), clock.since + giveUpMs) };
  }
  const limited = policy.limited;
  if (resume === 'off') return { kind: 'hold' };
  if (clock.resetAt !== null) {
    if (resume === 'short' && clock.resetAt - clock.since > limited.autoMaxMs) return { kind: 'hold' };
    return { kind: 'at', at: Math.max(now, clock.resetAt) + Math.floor(jitter * limited.jitterMs) };
  }
  if (now - clock.since >= limited.giveUpMs) return { kind: 'give-up', message: `the provider kept refusing the call for ${minutes(limited.giveUpMs)} without saying when its limit resets; send again later` };
  return { kind: 'at', at: Math.min(now + backoffMs(limited, clock.tries), clock.since + limited.giveUpMs) };
}

/** Whether `next` differs from `last` in what a restart would need, so it is worth a log line of its own. */
export const changesCourse = (last: Waiting | undefined, next: Waiting): boolean =>
  last === undefined || last.kind !== next.kind || last.since !== next.since || last.resetAt !== next.resetAt || (last.retryAt === null) !== (next.retryAt === null);

/** The wait the log ends in: its last `wait` event, when no conversation event came after it. */
export function openWaitOf(events: readonly TurnEvent[]): Waiting | undefined {
  for (let i = events.length - 1; i >= 0; i--) {
    const event = events[i]!;
    if (event.kind === 'wait') return event.wait;
    if (event.kind === 'user' || event.kind === 'assistant' || event.kind === 'error' || event.kind === 'tool-result' || event.kind === 'session-start') return undefined;
  }
  return undefined;
}

const seconds = (ms: number): string => `${Math.max(1, Math.ceil(ms / 1000))}s`;

/**
 * The few words the running row and the tasks list give a wait: "Offline, retrying in 12s", "Limited until 14:05", or
 * "Limited, retrying in 40s". `clock` renders a time of day in the user's own zone.
 */
export function waitLabel(wait: Waiting, now: number, clock: (ms: number) => string): string {
  if (wait.kind === 'offline') return wait.retryAt === null || wait.retryAt <= now ? 'Offline, retrying now' : `Offline, retrying in ${seconds(wait.retryAt - now)}`;
  if (wait.resetAt !== null) return `Limited until ${clock(wait.resetAt)}`;
  if (wait.retryAt === null) return 'Limited';
  return wait.retryAt <= now ? 'Limited, retrying now' : `Limited, retrying in ${seconds(wait.retryAt - now)}`;
}

/** In a `notice` session update's `_meta`: the turn's wait, or null once it ended. */
export const WAITING_META = 'gcode/waiting';

/** Cuts a held wait short: the call is tried at once. Answers whether the session had a wait to cut. */
export const RETRY_NOW_METHOD = '_gcode/retryNow';
export type RetryNowRequest = { readonly sessionId: string };
export type RetryNowResponse = { readonly retried: boolean };
