import { describe, expect, it } from 'vitest';
import { asSessionId, type Session, type StreamMarks, type TurnEvent } from '@g-code/core';
import { gatewayFor } from '../src/gateway.js';
import { answer, fakeTransport, httpError, type Reply } from './fake-transport.js';

const session: Session = {
  id: asSessionId('sess-1'),
  createdAt: '2026-10-04T00:00:00.000Z',
  workspace: '/tmp/ws',
  provider: 'openrouter',
  model: 'anthropic/claude-opus-5.5',
  effort: 'high',
};
const events: TurnEvent[] = [
  { kind: 'session-start', session },
  { kind: 'user', seq: 1, at: session.createdAt, content: 'hi' },
];
const env = { OPENROUTER_API_KEY: 'test-key', ANTHROPIC_API_KEY: 'must-not-be-sent' };

describe('gatewayFor', () => {
  it('streams text and maps usage, cost and blocks from the final message', async () => {
    const transport = fakeTransport([answer('Hello there, friend.', { input: 10, cacheRead: 0, cacheWrite: 1200 })]);
    const deltas: string[] = [];
    const result = await gatewayFor('openrouter', env, transport.fetch).turn({
      session,
      events,
      signal: new AbortController().signal,
      tools: [],
      onText: (d) => deltas.push(d),
      onRetry: () => {},
    });

    expect(deltas.join('')).toBe('Hello there, friend.');
    expect(deltas.length).toBeGreaterThan(1);
    expect(result).toMatchObject({
      kind: 'answer',
      turn: {
        content: [
          { type: 'thinking', thinking: 'pondering 20', signature: 'sig-20' },
          { type: 'text', text: 'Hello there, friend.' },
        ],
        stopReason: 'end_turn',
        usage: { input: 10, cacheRead: 0, cacheWrite: 1200, output: 42 },
        costUsd: (10 * 4 + 1200 * 5 + 42 * 20) / 1e6,
      },
    });

    const [request] = transport.requests;
    expect(request?.url).toBe('https://openrouter.ai/api/v1/messages');
    expect(request?.headers.get('authorization')).toBe('Bearer test-key');
    expect(request?.headers.get('x-api-key')).toBeNull();
    expect(request?.headers.get('x-session-id')).toBe('sess-1');
    expect(request?.body).toMatchObject({ stream: true, max_tokens: 64000, output_config: { effort: 'high' } });
    expect(request?.body).not.toHaveProperty('thinking');
  });

  it('returns a refusal as its own outcome instead of throwing', async () => {
    const transport = fakeTransport([answer('', { input: 5, cacheRead: 0, cacheWrite: 0 }, { stopReason: 'refusal' })]);
    const result = await gatewayFor('openrouter', env, transport.fetch).turn({
      session,
      events,
      signal: new AbortController().signal,
      tools: [],
      onText: () => {},
      onRetry: () => {},
    });
    expect(result).toEqual({ kind: 'error', error: 'refusal', message: 'the model refused' });
  });

  it('names the missing key variable', () => {
    expect(() => gatewayFor('openrouter', {})).toThrow('OPENROUTER_API_KEY is not set');
  });

  it('sends Model Studio turns to the configured workspace endpoint with its own key', async () => {
    const transport = fakeTransport([answer('Hi.', { input: 3, cacheRead: 0, cacheWrite: 0 })]);
    const qwen: Session = { ...session, provider: 'modelstudio', model: 'qwen3.8-flash' };
    const modelstudioEnv = {
      DASHSCOPE_API_KEY: 'sk-test',
      DASHSCOPE_BASE_URL: 'https://ws-1.ap-southeast-1.maas.aliyuncs.com/apps/anthropic',
      OPENROUTER_API_KEY: 'must-not-be-sent',
    };
    const result = await gatewayFor('modelstudio', modelstudioEnv, transport.fetch).turn({
      session: qwen,
      events: [{ kind: 'session-start', session: qwen }, ...events.slice(1)],
      signal: new AbortController().signal,
      tools: [],
      onText: () => {},
      onRetry: () => {},
    });

    expect(result).toMatchObject({ kind: 'answer', turn: { costUsd: (3 * 0.15 + 42 * 0.47) / 1e6 } });
    const [request] = transport.requests;
    expect(request?.url).toBe('https://ws-1.ap-southeast-1.maas.aliyuncs.com/apps/anthropic/v1/messages');
    expect(request?.headers.get('authorization')).toBe('Bearer sk-test');
    expect(request?.headers.get('x-session-id')).toBeNull();
    expect(request?.body).toMatchObject({ model: 'qwen3.8-flash' });
  });

  it('names the missing Model Studio endpoint variable', () => {
    expect(() => gatewayFor('modelstudio', { DASHSCOPE_API_KEY: 'sk-test' })).toThrow('DASHSCOPE_BASE_URL is not set');
  });
});

const overloaded = httpError(529, { type: 'error', error: { type: 'overloaded_error', message: 'Overloaded' } });
const fast = { maxRetries: 3, baseDelayMs: 1, maxDelayMs: 20_000 };
const usage = { input: 10, cacheRead: 0, cacheWrite: 0 };

async function turnOver(replies: readonly Reply[], opts: { retry?: typeof fast; signal?: AbortSignal; onRetry?: () => void } = {}) {
  const transport = fakeTransport(replies);
  const retries: unknown[] = [];
  const result = await gatewayFor('openrouter', env, transport.fetch, opts.retry ?? fast).turn({
    session,
    events,
    signal: opts.signal ?? new AbortController().signal,
    tools: [],
    onText: () => {},
    onRetry: (retry) => {
      retries.push(retry);
      opts.onRetry?.();
    },
  });
  return { result, retries, requests: transport.requests.length };
}

describe('gatewayFor retries', () => {
  it('retries an overloaded provider and answers with the next call', async () => {
    const { result, retries, requests } = await turnOver([overloaded, answer('Back.', usage)]);
    expect(result).toMatchObject({ kind: 'answer', turn: { content: [{ type: 'thinking' }, { type: 'text', text: 'Back.' }] } });
    expect(requests).toBe(2);
    expect(retries).toEqual([{ attempt: 1, delayMs: 1, message: expect.stringContaining('overloaded_error') }]);
  });

  it('retries a connection dropped mid-stream', async () => {
    const { result, retries } = await turnOver([{ ...answer('Lost half.', usage), dropAfter: 6 }, answer('Whole.', usage)]);
    expect(result).toMatchObject({ kind: 'answer' });
    expect(retries).toEqual([{ attempt: 1, delayMs: 1, message: expect.stringContaining('terminated') }]);
  });

  it('backs off exponentially and reports a transport error once the retries run out', async () => {
    const { result, retries, requests } = await turnOver([overloaded, overloaded, overloaded, overloaded]);
    expect(result).toEqual({ kind: 'error', error: 'transport', message: expect.stringContaining('529') });
    expect(requests).toBe(4);
    expect(retries.map((r) => (r as { delayMs: number }).delayMs)).toEqual([1, 2, 4]);
  });

  it('waits as long as retry-after asks', async () => {
    const limited = httpError(429, { type: 'error', error: { type: 'rate_limit_error', message: 'slow down' } }, { 'retry-after': '0.05' });
    const { result, retries } = await turnOver([limited, answer('Ok.', usage)]);
    expect(result).toMatchObject({ kind: 'answer' });
    expect(retries).toEqual([{ attempt: 1, delayMs: 50, message: expect.stringContaining('429') }]);
  });

  it('does not retry an exhausted quota', async () => {
    const quota = httpError(402, { error: { message: 'Insufficient credits. Add more using https://openrouter.ai/settings/credits', code: 402 } });
    const { result, retries, requests } = await turnOver([quota, answer('Never.', usage)]);
    expect(result).toEqual({ kind: 'error', error: 'transport', message: expect.stringContaining('Insufficient credits') });
    expect(requests).toBe(1);
    expect(retries).toEqual([]);
  });

  it('reports a context overflow as its own error without retrying', async () => {
    const tooLong = httpError(400, { type: 'error', error: { type: 'invalid_request_error', message: 'prompt is too long: 213462 tokens > 200000 maximum' } });
    const { result, requests } = await turnOver([tooLong, answer('Never.', usage)]);
    expect(result).toEqual({ kind: 'error', error: 'overflow', message: expect.stringContaining('prompt is too long') });
    expect(requests).toBe(1);
  });

  it('leaves no retries to the SDK, so a disabled policy makes exactly one call', async () => {
    const { result, requests } = await turnOver([overloaded, answer('Never.', usage)], { retry: { ...fast, maxRetries: 0 } });
    expect(result).toMatchObject({ kind: 'error', error: 'transport' });
    expect(requests).toBe(1);
  });

  it('ends as an abort when stopped during the backoff wait', async () => {
    const stop = new AbortController();
    const started = performance.now();
    const { result, requests } = await turnOver([overloaded, answer('Never.', usage)], {
      retry: { ...fast, baseDelayMs: 10_000 },
      signal: stop.signal,
      onRetry: () => stop.abort(),
    });
    expect(result).toEqual({ kind: 'error', error: 'abort', message: 'interrupted by the user' });
    expect(requests).toBe(1);
    expect(performance.now() - started).toBeLessThan(2000);
  });

  describe('stream marks', () => {
    const marksOf = async (reply: Reply, signal: AbortSignal) => {
      const marks: StreamMarks[] = [];
      const result = await gatewayFor('openrouter', env, fakeTransport([reply]).fetch).turn({
        session,
        events,
        signal,
        tools: [],
        onText: () => {},
        onRetry: () => {},
        onMarks: (m) => marks.push(m),
      });
      return { result, marks };
    };

    it('reports once, with every mark in stream order', async () => {
      const { result, marks } = await marksOf(answer('Hello there, friend.', usage), new AbortController().signal);
      expect(result.kind).toBe('answer');
      expect(marks).toHaveLength(1);
      const [{ requestAt, firstTokenAt, firstAnswerAt, lastTokenAt, endAt }] = marks as [StreamMarks];
      expect([firstTokenAt, firstAnswerAt, lastTokenAt].every((m) => m !== null)).toBe(true);
      expect([requestAt, firstTokenAt!, firstAnswerAt!, lastTokenAt!, endAt]).toEqual([requestAt, firstTokenAt, firstAnswerAt, lastTokenAt, endAt].toSorted());
    });

    it('counts thinking as a token but not as an answer, so a call cut off mid-thought has no first answer', async () => {
      const stop = new AbortController();
      // message_start, then the thinking block's start and first delta.
      const pending = marksOf({ ...answer('Never said.', usage), stallAfter: 3 }, stop.signal);
      setTimeout(() => stop.abort(), 50);
      const { result, marks } = await pending;
      expect(result).toEqual({ kind: 'error', error: 'abort', message: 'interrupted by the user' });
      expect(marks).toEqual([expect.objectContaining({ firstTokenAt: expect.any(Number), firstAnswerAt: null, lastTokenAt: expect.any(Number) })]);
      expect(marks[0]!.endAt - marks[0]!.lastTokenAt!).toBeGreaterThanOrEqual(40);
    });
  });
});
