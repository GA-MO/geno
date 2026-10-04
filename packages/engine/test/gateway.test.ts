import { describe, expect, it } from 'vitest';
import { asSessionId, type Session, type TurnEvent } from '@g-code/core';
import { gatewayFor } from '../src/gateway.js';
import { answer, fakeTransport } from './fake-transport.js';

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
      onText: (d) => deltas.push(d),
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
      onText: () => {},
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
      onText: () => {},
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
