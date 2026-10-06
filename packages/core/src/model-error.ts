// Portions ported from Pi (https://github.com/earendil-works/pi) at b2b5c42, Copyright (c) 2025 Mario Zechner, MIT License.
// The patterns come from packages/ai/src/utils/retry.ts and overflow.ts, cut to Anthropic, OpenRouter and DashScope.

import type { TurnErrorKind } from './session.js';

/**
 * What to do about a failed model call. `offline`: the request never reached the provider, so wait until its host
 * answers. `limited`: the provider throttled it, so wait for the limit to reset. `transient`: try again soon.
 * `overflow`: shrink the context. `quota`: tell the user to pay. `fatal`: stop.
 */
export const MODEL_ERROR_KINDS = ['offline', 'limited', 'transient', 'overflow', 'quota', 'fatal'] as const;
export type ModelErrorKind = (typeof MODEL_ERROR_KINDS)[number];

/**
 * A failed model call as the transport reported it. A dropped connection or an error sent mid-stream has no status.
 * `streamed` is true once any of the answer's stream arrived. `headers` have lowercase names; `body` is the parsed error body.
 */
export type ModelFailure = {
  readonly status: number | undefined;
  readonly message: string;
  readonly streamed?: boolean | undefined;
  readonly headers?: Readonly<Record<string, string>> | undefined;
  readonly body?: unknown;
};

/** A failure as the gateway acts on it. Only `limited` carries a time: when the provider said its limit resets, in ms since the epoch. */
export type FailureClass =
  | { readonly kind: 'offline' }
  | { readonly kind: 'limited'; readonly resetAt: number | undefined }
  | { readonly kind: Exclude<ModelErrorKind, 'offline' | 'limited'> };

const QUOTA = new RegExp(
  [
    'insufficient_quota',
    'quota exceeded',
    'billing',
    'credit balance is too low',
    'insufficient credits',
    'requires more credits',
    'account is in good standing',
    'arrearage',
    'free tier of the model has been exhausted',
  ].join('|'),
  'i',
);

// Throttling text can also name tokens, so it is settled before the overflow patterns see it. OpenRouter's daily
// free-model cap resets each day, so it is a limit to wait out rather than a bill.
const RATE_LIMIT = /rate.?limit|too many requests|free-models-per-day/i;

const OVERFLOW = new RegExp(
  [
    'prompt is too long',
    'request_too_large',
    'maximum context length is \\d+ tokens',
    'exceeds (?:the )?maximum allowed input length of [\\d,]+ tokens?',
    'range of input length should be',
    'context[_ ]length[_ ]exceeded',
  ].join('|'),
  'i',
);

// What undici, fetch and the SDKs say when no connection to the provider was made, or it broke before any answer.
const OFFLINE = new RegExp(
  [
    'ECONNREFUSED',
    'ENOTFOUND',
    'EAI_AGAIN',
    'ENETUNREACH',
    'EHOSTUNREACH',
    'ENETDOWN',
    'ECONNRESET',
    'ETIMEDOUT',
    'EPIPE',
    'UND_ERR_CONNECT_TIMEOUT',
    'UND_ERR_SOCKET',
    'connect timeout',
    'fetch failed',
    'connection.?error',
    'connection.?refused',
    'other side closed',
    'socket hang up',
    'network.?error',
  ].join('|'),
  'i',
);

const TRANSIENT = new RegExp(
  [
    'overloaded',
    'currently experiencing high demand',
    'model is at capacity',
    'service.?unavailable',
    'server.?error',
    'internal.?error',
    'provider.?returned.?error',
    'network.?error',
    'connection.?error',
    'connection.?refused',
    'connection.?lost',
    'other side closed',
    'fetch failed',
    'ECONNRESET',
    'EAI_AGAIN',
    'upstream.?connect',
    'reset before headers',
    'socket hang up',
    'timed? out',
    'timeout',
    'terminated',
    'ended without',
    'stream ended before message_stop',
  ].join('|'),
  'i',
);

const transientStatus = (status: number) => status === 408 || status >= 500;

type Match = { readonly text: RegExp } | { readonly status: (status: number) => boolean } | { readonly unanswered: RegExp };

/**
 * The classification table. First match wins. Text that names a quota, a rate limit or an overflow outranks the
 * status. Otherwise a status decides, and a known client error is never retried on its wording. With no status, a
 * connection that failed before any of the answer streamed is offline, and text decides the rest.
 *
 * | Rule | Kind |
 * | --- | --- |
 * | billing or quota text | quota |
 * | rate-limit text | limited |
 * | context-overflow text | overflow |
 * | 402 | quota |
 * | 429 | limited |
 * | 408, 5xx | transient |
 * | any other status | fatal |
 * | no status, nothing streamed, connection-error text | offline |
 * | no status, overload, server or connection text | transient |
 * | anything else | fatal |
 */
const RULES: readonly (readonly [ModelErrorKind, Match])[] = [
  ['quota', { text: QUOTA }],
  ['limited', { text: RATE_LIMIT }],
  ['overflow', { text: OVERFLOW }],
  ['quota', { status: (status) => status === 402 }],
  ['limited', { status: (status) => status === 429 }],
  ['transient', { status: transientStatus }],
  ['fatal', { status: () => true }],
  ['offline', { unanswered: OFFLINE }],
  ['transient', { text: TRANSIENT }],
];

const matches = (match: Match, { status, message, streamed }: ModelFailure): boolean => {
  if ('text' in match) return match.text.test(message);
  if ('unanswered' in match) return status === undefined && streamed !== true && match.unanswered.test(message);
  return status !== undefined && match.status(status);
};

export function classifyModelError(failure: ModelFailure): ModelErrorKind {
  return RULES.find(([, match]) => matches(match, failure))?.[0] ?? 'fatal';
}

/** The failure's kind, and for a rate limit the reset time its headers or body name, read against `now`. */
export function classifyFailure(failure: ModelFailure, now: number): FailureClass {
  const kind = classifyModelError(failure);
  return kind === 'limited' ? { kind, resetAt: resetAtOf(failure.headers ?? {}, failure.body, now) } : { kind };
}

/** How a call that will not be retried is logged. Only an overflow gets its own kind, for compaction to act on. */
export const TURN_ERROR_OF: Readonly<Record<ModelErrorKind, TurnErrorKind>> = {
  offline: 'transport',
  limited: 'transport',
  transient: 'transport',
  overflow: 'overflow',
  quota: 'transport',
  fatal: 'transport',
};

// OpenAI's reset headers are durations such as `1s`, `6m0s` or `20ms`.
const DURATION = /^(?:\d+(?:\.\d+)?(?:ms|s|m|h))+$/;
const DURATION_PART = /(\d+(?:\.\d+)?)(ms|s|m|h)/g;
const DURATION_UNIT_MS: Readonly<Record<string, number>> = { ms: 1, s: 1000, m: 60_000, h: 3_600_000 };

function durationMs(raw: string): number | undefined {
  if (!DURATION.test(raw)) return undefined;
  let total = 0;
  for (const [, n, unit] of raw.matchAll(DURATION_PART)) total += Number(n) * DURATION_UNIT_MS[unit!]!;
  return total;
}

/** A reset given as epoch ms, epoch seconds, or seconds from now, told apart by size. */
function epochOrSeconds(raw: string, now: number): number | undefined {
  const n = Number(raw);
  if (raw.trim() === '' || !Number.isFinite(n) || n < 0) return undefined;
  if (n > 1e12) return n;
  if (n > 1e9) return n * 1000;
  return now + n * 1000;
}

function dateOf(raw: string): number | undefined {
  const date = Date.parse(raw);
  return Number.isNaN(date) ? undefined : date;
}

function retryAfterAt(headers: Readonly<Record<string, string>>, now: number): number | undefined {
  const ms = Number.parseFloat(headers['retry-after-ms'] ?? '');
  if (ms >= 0) return now + ms;
  const raw = headers['retry-after'];
  if (raw === undefined || raw.trim() === '') return undefined;
  const seconds = Number(raw);
  if (Number.isFinite(seconds)) return seconds >= 0 ? now + seconds * 1000 : undefined;
  return dateOf(raw);
}

type BucketFamily = {
  readonly reset: RegExp;
  readonly remaining: (bucket: string) => string;
  readonly at: (raw: string, now: number) => number | undefined;
};

// OpenAI's `x-ratelimit-reset-<bucket>` durations, and Anthropic's `anthropic-ratelimit-<bucket>-reset` times.
const BUCKETS: readonly BucketFamily[] = [
  {
    reset: /^x-ratelimit-reset-(.+)$/,
    remaining: (bucket) => `x-ratelimit-remaining-${bucket}`,
    at: (raw, now) => {
      const ms = durationMs(raw);
      return ms === undefined ? epochOrSeconds(raw, now) : now + ms;
    },
  },
  { reset: /^anthropic-ratelimit-(.+)-reset$/, remaining: (bucket) => `anthropic-ratelimit-${bucket}-remaining`, at: dateOf },
];

/**
 * When the exhausted bucket resets. These headers also come on calls that succeed, so a bucket with none remaining
 * decides, the latest of them. With none at zero, the earliest reset, since a call resumed early only learns the next one.
 */
function bucketResetAt(headers: Readonly<Record<string, string>>, now: number): number | undefined {
  const exhausted: number[] = [];
  const any: number[] = [];
  for (const [name, raw] of Object.entries(headers)) {
    for (const family of BUCKETS) {
      const bucket = family.reset.exec(name)?.[1];
      const at = bucket === undefined ? undefined : family.at(raw, now);
      if (bucket === undefined || at === undefined) continue;
      any.push(at);
      if (headers[family.remaining(bucket)]?.trim() === '0') exhausted.push(at);
    }
  }
  if (exhausted.length > 0) return Math.max(...exhausted);
  return any.length > 0 ? Math.min(...any) : undefined;
}

const lowercased = (record: Readonly<Record<string, unknown>>): Record<string, string> =>
  Object.fromEntries(
    Object.entries(record).flatMap(([name, value]) => (typeof value === 'string' || typeof value === 'number' ? [[name.toLowerCase(), String(value)]] : [])),
  );

/** OpenRouter repeats the upstream limit's headers in the error body, at `error.metadata.headers`. */
function bodyHeaders(body: unknown): Record<string, string> {
  const headers = (body as { readonly error?: { readonly metadata?: { readonly headers?: unknown } } } | null | undefined)?.error?.metadata?.headers;
  return headers !== null && typeof headers === 'object' ? lowercased(headers as Record<string, unknown>) : {};
}

/**
 * When a rate limit resets, in ms since the epoch and never before `now`. The headers decide first, then the body's
 * copy of them: `retry-after-ms`, `retry-after`, the bucket headers, then `x-ratelimit-reset`. Undefined when none
 * names a time, as with Model Studio, whose 429 bodies carry no reset.
 */
export function resetAtOf(headers: Readonly<Record<string, string>>, body: unknown, now: number): number | undefined {
  for (const source of [headers, bodyHeaders(body)]) {
    const at = retryAfterAt(source, now) ?? bucketResetAt(source, now) ?? epochOrSeconds(source['x-ratelimit-reset'] ?? '', now);
    if (at !== undefined) return Math.max(now, Math.round(at));
  }
  return undefined;
}

export type RetryPolicy = {
  /** Calls after the first; 0 turns retries off. */
  readonly maxRetries: number;
  readonly baseDelayMs: number;
  readonly maxDelayMs: number;
};

export const RETRY_POLICY: RetryPolicy = { maxRetries: 3, baseDelayMs: 1000, maxDelayMs: 20_000 };

/** A retry about to wait `delayMs` before call `attempt + 1`, after a transient failure that said `message`. */
export type ModelRetry = { readonly attempt: number; readonly delayMs: number; readonly message: string };

/**
 * The wait before retry number `retry` (from 1), or undefined to give up. A server's own retry-after is
 * honored; one past the maximum delay gives up, since retrying sooner than asked would fail again.
 */
export function retryDelayMs(policy: RetryPolicy, retry: number, retryAfterMs: number | undefined): number | undefined {
  if (retry > policy.maxRetries) return undefined;
  if (retryAfterMs !== undefined) return retryAfterMs <= policy.maxDelayMs ? retryAfterMs : undefined;
  return Math.min(policy.baseDelayMs * 2 ** (retry - 1), policy.maxDelayMs);
}
