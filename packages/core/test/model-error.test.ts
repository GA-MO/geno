import { describe, expect, it } from 'vitest';
import { classifyFailure, classifyModelError, resetAtOf, RETRY_POLICY, retryDelayMs, type ModelErrorKind } from '../src/index.js';

const NO_STATUS = undefined;

// Messages as @anthropic-ai/sdk renders them: the status, then the error body (stringified when it has no
// top-level message). Errors sent mid-stream and dropped connections carry no status.
const CASES: readonly [provider: string, status: number | undefined, message: string, kind: ModelErrorKind][] = [
  ['anthropic', 529, '529 {"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}', 'transient'],
  ['anthropic', NO_STATUS, '{"type":"error","error":{"details":null,"type":"overloaded_error","message":"Overloaded"}}', 'transient'],
  ['anthropic', 500, '500 {"type":"error","error":{"type":"api_error","message":"Internal server error"}}', 'transient'],
  ['anthropic', NO_STATUS, '{"type":"error","error":{"type":"api_error","message":"Internal server error"}}', 'transient'],
  [
    'anthropic',
    429,
    '429 {"type":"error","error":{"type":"rate_limit_error","message":"This request would exceed the rate limit for your organization of 50,000 input tokens per minute."}}',
    'limited',
  ],
  ['anthropic', 400, '400 {"type":"error","error":{"type":"invalid_request_error","message":"prompt is too long: 213462 tokens > 200000 maximum"}}', 'overflow'],
  ['anthropic', 413, '413 {"type":"error","error":{"type":"request_too_large","message":"Request exceeds the maximum size"}}', 'overflow'],
  [
    'anthropic',
    400,
    '400 {"type":"error","error":{"type":"invalid_request_error","message":"Your credit balance is too low to access the Anthropic API. Please go to Plans & Billing to upgrade or purchase credits."}}',
    'quota',
  ],
  ['anthropic', 401, '401 {"type":"error","error":{"type":"authentication_error","message":"invalid x-api-key"}}', 'fatal'],
  ['anthropic', 400, '400 {"type":"error","error":{"type":"invalid_request_error","message":"max_tokens: 500000 > 64000, which is the maximum allowed"}}', 'fatal'],
  ['openrouter', 502, '502 {"error":{"message":"Provider returned error","code":502}}', 'transient'],
  ['openrouter', NO_STATUS, '{"error":{"message":"Provider returned error","code":502}}', 'transient'],
  [
    'openrouter',
    429,
    '429 {"error":{"message":"Provider returned error","code":429,"metadata":{"raw":"anthropic/claude-opus-5.5 is temporarily rate-limited upstream."}}}',
    'limited',
  ],
  [
    'openrouter',
    400,
    `400 {"error":{"message":"This endpoint's maximum context length is 200000 tokens. However, you requested about 251234 tokens (187234 of text input, 64000 in the output). Please reduce the length of either one.","code":400}}`,
    'overflow',
  ],
  [
    'openrouter',
    400,
    '400 {"error":{"message":"Input length 265330 exceeds the maximum allowed input length of 262144 tokens.","code":400}}',
    'overflow',
  ],
  ['openrouter', 402, '402 {"error":{"message":"Insufficient credits. Add more using https://openrouter.ai/settings/credits","code":402}}', 'quota'],
  [
    'openrouter',
    402,
    '402 {"error":{"message":"This request requires more credits, or fewer max_tokens. You requested up to 64000 tokens, but can only afford 1234.","code":402}}',
    'quota',
  ],
  [
    'openrouter',
    429,
    '429 {"error":{"message":"Rate limit exceeded: free-models-per-day. Add 10 credits to unlock 1000 free model requests per day","code":429}}',
    'limited',
  ],
  [
    'dashscope',
    400,
    '400 {"type":"error","error":{"type":"invalid_request_error","message":"<400> InternalError.Algo.InvalidParameter: Range of input length should be [1, 129024]"}}',
    'overflow',
  ],
  ['dashscope', 400, 'Range of input length should be [1, 98304]', 'overflow'],
  [
    'dashscope',
    429,
    '429 {"type":"error","error":{"type":"rate_limit_error","message":"Requests rate limit exceeded, please try again later."}}',
    'limited',
  ],
  [
    'dashscope',
    429,
    '429 {"type":"error","error":{"type":"rate_limit_error","message":"Too many tokens, please wait before trying again."}}',
    'limited',
  ],
  [
    'dashscope',
    429,
    '429 {"type":"error","error":{"type":"rate_limit_error","message":"Allocated quota exceeded, please increase your quota limit."}}',
    'quota',
  ],
  [
    'dashscope',
    400,
    '400 {"type":"error","error":{"type":"invalid_request_error","message":"Access denied, please make sure your account is in good standing."}}',
    'quota',
  ],
  [
    'dashscope',
    403,
    '403 {"type":"error","error":{"type":"invalid_request_error","message":"The free tier of the model has been exhausted. If you wish to continue access the model on a paid basis, please disable the \\"use free tier only\\" mode in the management console."}}',
    'quota',
  ],
  ['dashscope', 503, '503 {"type":"error","error":{"type":"api_error","message":"Service temporarily unavailable"}}', 'transient'],
  ['dashscope', 404, '404 {"type":"error","error":{"type":"not_found_error","message":"Model not exist."}}', 'fatal'],
  ['transport', NO_STATUS, 'Connection error.', 'offline'],
  ['transport', NO_STATUS, 'Request timed out.', 'transient'],
  ['transport', NO_STATUS, 'terminated: other side closed', 'offline'],
  ['transport', NO_STATUS, 'fetch failed: read ECONNRESET', 'offline'],
  ['transport', NO_STATUS, 'stream ended without producing a Message with role=assistant', 'transient'],
  ['transport', 408, '408 status code (no body)', 'transient'],
  ['transport', NO_STATUS, 'something nobody has seen before', 'fatal'],
];

describe('classifyModelError', () => {
  it.each(CASES)('%s %s %s is %s', (_provider, status, message, kind) => {
    expect(classifyModelError({ status, message })).toBe(kind);
  });

  it('does not take a known client error for transient because its text sounds like one', () => {
    expect(classifyModelError({ status: 400, message: '400 the upstream connection timed out in a tool schema' })).toBe('fatal');
  });
});

// Recorded from Node 22's fetch (undici) and @anthropic-ai/sdk 0.131, joined cause by cause as the gateway's messagesOf
// joins them. The SDK wraps a failed fetch in APIConnectionError, "Connection error.".
const UNDICI: readonly [what: string, message: string, streamed: boolean, kind: ModelErrorKind][] = [
  ['connection refused', 'Connection error.: fetch failed: connect ECONNREFUSED 127.0.0.1:39123', false, 'offline'],
  ['DNS lookup failed', 'Connection error.: fetch failed: getaddrinfo ENOTFOUND no-such-host.invalid', false, 'offline'],
  ['DNS lookup timed out', 'Connection error.: fetch failed: getaddrinfo EAI_AGAIN api.anthropic.com', false, 'offline'],
  ['reset before any response', 'Connection error.: fetch failed: read ECONNRESET', false, 'offline'],
  ['connect timeout', 'Connection error.: fetch failed: Connect Timeout Error (attempted address: 10.255.255.1:81, timeout: 10000ms)', false, 'offline'],
  ['network unreachable', 'Connection error.: fetch failed: connect ENETUNREACH 2606:4700::6812:1a2b:443', false, 'offline'],
  ['closed before headers', 'terminated: terminated: other side closed', false, 'offline'],
  ['plain fetch failed', 'fetch failed', false, 'offline'],
  ['closed mid-stream', 'terminated: terminated: other side closed', true, 'transient'],
  ['reset mid-stream', 'Connection error.: fetch failed: read ECONNRESET', true, 'transient'],
  ['a request timeout is the model being slow, not the network', 'Request timed out.', false, 'transient'],
];

describe('classifyModelError on transport failures', () => {
  it.each(UNDICI)('%s is %s', (_what, message, streamed, kind) => {
    expect(classifyModelError({ status: undefined, message, streamed })).toBe(kind);
  });

  it('never calls a failure with a status offline, whatever its text', () => {
    expect(classifyModelError({ status: 502, message: '502 upstream connect error or disconnect/reset before headers. reset reason: connection failure' })).toBe('transient');
  });
});

describe('classifyFailure', () => {
  const now = Date.parse('2026-10-06T14:00:00Z');

  it('gives a 429 the reset its retry-after names', () => {
    expect(classifyFailure({ status: 429, message: '429 slow down', headers: { 'retry-after': '30' } }, now)).toEqual({ kind: 'limited', resetAt: now + 30_000 });
  });

  it('gives a 429 with nothing to go on no reset', () => {
    expect(classifyFailure({ status: 429, message: '429 {"error":{"message":"Requests rate limit exceeded","code":"limit_requests"}}' }, now)).toEqual({ kind: 'limited', resetAt: undefined });
  });

  it('leaves the other kinds without a time', () => {
    expect(classifyFailure({ status: undefined, message: 'fetch failed: connect ECONNREFUSED 127.0.0.1:1234' }, now)).toEqual({ kind: 'offline' });
    expect(classifyFailure({ status: 529, message: '529 overloaded', headers: { 'retry-after': '30' } }, now)).toEqual({ kind: 'transient' });
  });
});

describe('resetAtOf', () => {
  const now = Date.parse('2026-10-06T14:00:00Z');

  it.each([
    ['retry-after in seconds', { 'retry-after': '12' }, now + 12_000],
    ['retry-after in fractional seconds', { 'retry-after': '0.5' }, now + 500],
    ['retry-after as an HTTP date', { 'retry-after': 'Tue, 06 Oct 2026 14:05:00 GMT' }, Date.parse('2026-10-06T14:05:00Z')],
    ['retry-after-ms before retry-after', { 'retry-after-ms': '1500', 'retry-after': '60' }, now + 1500],
    ['an OpenAI duration on the exhausted bucket', { 'x-ratelimit-reset-requests': '1s', 'x-ratelimit-remaining-requests': '0', 'x-ratelimit-reset-tokens': '6m0s', 'x-ratelimit-remaining-tokens': '9000' }, now + 1000],
    ['the latest of two exhausted OpenAI buckets', { 'x-ratelimit-reset-requests': '1s', 'x-ratelimit-remaining-requests': '0', 'x-ratelimit-reset-tokens': '1m30s', 'x-ratelimit-remaining-tokens': '0' }, now + 90_000],
    ['the earliest bucket when none says it is exhausted', { 'x-ratelimit-reset-requests': '20ms', 'x-ratelimit-reset-tokens': '2s' }, now + 20],
    [
      'Anthropic’s exhausted bucket',
      {
        'anthropic-ratelimit-requests-reset': '2026-10-06T14:00:20Z',
        'anthropic-ratelimit-requests-remaining': '40',
        'anthropic-ratelimit-input-tokens-reset': '2026-10-06T14:01:00Z',
        'anthropic-ratelimit-input-tokens-remaining': '0',
      },
      Date.parse('2026-10-06T14:01:00Z'),
    ],
    ['OpenRouter’s x-ratelimit-reset in epoch ms', { 'x-ratelimit-reset': String(now + 3_600_000) }, now + 3_600_000],
    ['an x-ratelimit-reset in epoch seconds', { 'x-ratelimit-reset': String((now + 60_000) / 1000) }, now + 60_000],
    ['a reset already past, as now', { 'retry-after': 'Tue, 06 Oct 2026 13:00:00 GMT' }, now],
  ] as const)('reads %s', (_what, headers, at) => {
    expect(resetAtOf(headers, undefined, now)).toBe(at);
  });

  it('reads OpenRouter’s copy of the upstream headers in a 429 body', () => {
    const body = {
      error: {
        message: 'Rate limit exceeded: free-models-per-day. Add 10 credits to unlock 1000 free model requests per day',
        code: 429,
        metadata: { headers: { 'X-RateLimit-Limit': '50', 'X-RateLimit-Remaining': '0', 'X-RateLimit-Reset': String(now + 7_200_000) } },
      },
    };
    expect(resetAtOf({}, body, now)).toBe(now + 7_200_000);
  });

  it('finds no reset in a Model Studio 429 body, nor in garbage', () => {
    expect(resetAtOf({}, { type: 'error', error: { type: 'rate_limit_error', message: 'Requests rate limit exceeded, please try again later.' } }, now)).toBeUndefined();
    expect(resetAtOf({ 'retry-after': 'soon', 'x-ratelimit-reset-requests': 'later' }, 'not json', now)).toBeUndefined();
  });
});

describe('retryDelayMs', () => {
  const policy = { maxRetries: 3, baseDelayMs: 1000, maxDelayMs: 20_000 };

  it('doubles from the base delay and stops after the last retry', () => {
    expect([1, 2, 3, 4].map((retry) => retryDelayMs(policy, retry, undefined))).toEqual([1000, 2000, 4000, undefined]);
  });

  it('caps the backoff at the maximum delay', () => {
    expect(retryDelayMs({ ...policy, maxRetries: 10 }, 7, undefined)).toBe(20_000);
  });

  it('waits as long as the server asked when that is within the maximum', () => {
    expect(retryDelayMs(policy, 1, 7500)).toBe(7500);
  });

  it('gives up when the server asks for a wait past the maximum', () => {
    expect(retryDelayMs(policy, 1, 60_000)).toBeUndefined();
  });

  it('defaults to three retries from one second, at most twenty seconds apart', () => {
    expect(RETRY_POLICY).toEqual(policy);
  });
});
