// Portions ported from Pi (https://github.com/earendil-works/pi) at b2b5c42, Copyright (c) 2025 Mario Zechner, MIT License.
// The patterns come from packages/ai/src/utils/retry.ts and overflow.ts, cut to Anthropic, OpenRouter and DashScope.

import type { TurnErrorKind } from './session.js';

/** What to do about a failed model call: try it again, shrink the context, tell the user to pay, or stop. */
export const MODEL_ERROR_KINDS = ['transient', 'overflow', 'quota', 'fatal'] as const;
export type ModelErrorKind = (typeof MODEL_ERROR_KINDS)[number];

/** A failed model call as the transport reported it. A dropped connection or an error sent mid-stream has no status. */
export type ModelFailure = { readonly status: number | undefined; readonly message: string };

const QUOTA = new RegExp(
  [
    'insufficient_quota',
    'quota exceeded',
    'billing',
    'credit balance is too low',
    'insufficient credits',
    'requires more credits',
    'free-models-per-day',
    'account is in good standing',
    'arrearage',
    'free tier of the model has been exhausted',
  ].join('|'),
  'i',
);

// Throttling text can also name tokens, so it is settled before the overflow patterns see it.
const RATE_LIMIT = /rate.?limit|too many requests/i;

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

const transientStatus = (status: number) => status === 408 || status === 429 || status >= 500;

type Match = { readonly text: RegExp } | { readonly status: (status: number) => boolean };

// First match wins. Text that names a quota or an overflow outranks the status; otherwise a status decides,
// and a known client error is never retried on its wording. Text alone decides only when there is no status.
const RULES: readonly (readonly [ModelErrorKind, Match])[] = [
  ['quota', { text: QUOTA }],
  ['transient', { text: RATE_LIMIT }],
  ['overflow', { text: OVERFLOW }],
  ['quota', { status: (status) => status === 402 }],
  ['transient', { status: transientStatus }],
  ['fatal', { status: () => true }],
  ['transient', { text: TRANSIENT }],
];

const matches = (match: Match, { status, message }: ModelFailure): boolean =>
  'text' in match ? match.text.test(message) : status !== undefined && match.status(status);

export function classifyModelError(failure: ModelFailure): ModelErrorKind {
  return RULES.find(([, match]) => matches(match, failure))?.[0] ?? 'fatal';
}

/** How a call that will not be retried is logged. Only an overflow gets its own kind, for compaction to act on. */
export const TURN_ERROR_OF: Readonly<Record<ModelErrorKind, TurnErrorKind>> = {
  transient: 'transport',
  overflow: 'overflow',
  quota: 'transport',
  fatal: 'transport',
};

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
