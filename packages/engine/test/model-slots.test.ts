import { setTimeout as sleep } from 'node:timers/promises';
import { describe, expect, it } from 'vitest';
import { asSessionId, type Session, type TurnEvent } from '@g-code/core';
import { gatewayFor } from '../src/gateway.js';
import { modelSlots } from '../src/model-slots.js';
import { answer, httpError, sseBody, type Reply } from './fake-transport.js';

const live = () => new AbortController().signal;

describe('model slots', () => {
  it('runs at most size calls at once and starts each waiting call in order', async () => {
    const slots = modelSlots(2);
    let open = 0;
    let most = 0;
    const order: number[] = [];
    await Promise.all(
      Array.from({ length: 6 }, (_, i) =>
        slots.run(async () => {
          open++;
          most = Math.max(most, open);
          order.push(i);
          await sleep(20);
          open--;
        }, live()),
      ),
    );
    expect(most).toBe(2);
    expect(order).toEqual([0, 1, 2, 3, 4, 5]);
    expect(slots.stats()).toMatchObject({ size: 2, calls: 6, peak: 2, waited: 4 });
  });

  it('holds every call that has not started for a pause, and lets running ones finish', async () => {
    const slots = modelSlots(4);
    const started: number[] = [];
    const t0 = Date.now();
    slots.pause(150);
    await Promise.all([0, 1].map((i) => slots.run(async () => void started.push(Date.now() - t0), live())));
    expect(Math.min(...started)).toBeGreaterThanOrEqual(140);
  });

  it('drops a waiting call whose signal aborts, without taking a slot', async () => {
    const slots = modelSlots(1);
    let release!: () => void;
    const first = slots.run(() => new Promise<void>((resolve) => (release = resolve)), live());
    const controller = new AbortController();
    const second = slots.run(async () => 'ran', controller.signal);
    controller.abort(new Error('stopped'));
    await expect(second).rejects.toThrow('stopped');
    const third = slots.run(async () => 'third', live());
    release();
    await first;
    await expect(third).resolves.toBe('third');
    expect(slots.stats().calls).toBe(2);
  });
});

const session: Session = { id: asSessionId('s'), createdAt: '2026-10-06T00:00:00.000Z', workspace: '/tmp/ws', provider: 'modelstudio', model: 'qwen3.8-flash', effort: 'medium' };
const events: TurnEvent[] = [
  { kind: 'session-start', session },
  { kind: 'user', seq: 1, at: session.createdAt, content: 'hi' },
];
const env = { DASHSCOPE_API_KEY: 'sk-test', DASHSCOPE_BASE_URL: 'https://ws-1.ap-southeast-1.maas.aliyuncs.com/apps/anthropic' };
const policy = { maxRetries: 3, baseDelayMs: 10, maxDelayMs: 1000 };

/** A fake endpoint that answers 429 while more than `limit` requests are open, as a rate limit keyed on concurrency would. */
function crowdedServer(limit: number, latencyMs: number) {
  let open = 0;
  let rejected = 0;
  const reply = (r: Reply) =>
    r.failure === undefined
      ? new Response(sseBody(r), { status: 200, headers: { 'content-type': 'text/event-stream' } })
      : new Response(JSON.stringify(r.failure.body), { status: r.failure.status, headers: { 'content-type': 'application/json', ...r.failure.headers } });
  const fetch: typeof globalThis.fetch = async () => {
    if (open >= limit) {
      rejected++;
      return reply(httpError(429, { error: { type: 'rate_limit_error', message: 'Too many requests' } }, { 'retry-after-ms': '200' }));
    }
    open++;
    await sleep(latencyMs);
    open--;
    return reply(answer('ok', { input: 1, cacheRead: 0, cacheWrite: 0 }));
  };
  return { fetch, rejected: () => rejected };
}

const turnInput = (onRetry: () => void) => ({ session, events, tools: [], signal: live(), onText: () => {}, onRetry });

describe('gateway with shared slots', () => {
  it('keeps several gateways under the endpoint limit, so none of them sees a 429', async () => {
    const server = crowdedServer(2, 30);
    const slots = modelSlots(2);
    let retries = 0;
    const results = await Promise.all(Array.from({ length: 6 }, () => gatewayFor('modelstudio', env, server.fetch, policy, slots).turn(turnInput(() => void retries++))));
    expect(results.every((r) => r.kind === 'answer')).toBe(true);
    expect(server.rejected()).toBe(0);
    expect(retries).toBe(0);
  });

  it('pauses the other gateways after one gets a 429', async () => {
    const server = crowdedServer(1, 30);
    const slots = modelSlots(3);
    const retries: number[] = [];
    const t0 = Date.now();
    const results = await Promise.all(Array.from({ length: 3 }, () => gatewayFor('modelstudio', env, server.fetch, policy, slots).turn(turnInput(() => void retries.push(Date.now() - t0)))));
    expect(results.every((r) => r.kind === 'answer')).toBe(true);
    expect(server.rejected()).toBeGreaterThan(0);
    expect(slots.stats().pauses).toBe(server.rejected());
  });
});
