import { describe, expect, it } from 'vitest';
import { classifyModelError, RETRY_POLICY, retryDelayMs, type ModelErrorKind } from '../src/index.js';

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
    'transient',
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
    'transient',
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
    'quota',
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
    'transient',
  ],
  [
    'dashscope',
    429,
    '429 {"type":"error","error":{"type":"rate_limit_error","message":"Too many tokens, please wait before trying again."}}',
    'transient',
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
  ['transport', NO_STATUS, 'Connection error.', 'transient'],
  ['transport', NO_STATUS, 'Request timed out.', 'transient'],
  ['transport', NO_STATUS, 'terminated: other side closed', 'transient'],
  ['transport', NO_STATUS, 'fetch failed: read ECONNRESET', 'transient'],
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
