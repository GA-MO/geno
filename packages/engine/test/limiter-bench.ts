// pnpm tsx packages/engine/test/limiter-bench.ts
// Streams of sequential model calls against a fake endpoint that rate-limits, with the pre-U26 gateway (each call backs
// off alone) and with shared slots. Prints the median and range over the runs of each cell.
import { setTimeout as sleep } from 'node:timers/promises';
import { asSessionId, type Session, type TurnEvent } from '@g-code/core';
import { gatewayFor } from '../src/gateway.js';
import { modelSlots, type ModelSlots } from '../src/model-slots.js';
import { answer, httpError, sseBody, type Reply } from './fake-transport.js';

const session: Session = { id: asSessionId('s'), createdAt: '2026-10-06T00:00:00.000Z', workspace: '/tmp/ws', provider: 'modelstudio', model: 'qwen3.8-flash', effort: 'medium' };
const events: TurnEvent[] = [
  { kind: 'session-start', session },
  { kind: 'user', seq: 1, at: session.createdAt, content: 'hi' },
];
const env = { DASHSCOPE_API_KEY: 'sk-test', DASHSCOPE_BASE_URL: 'https://example.invalid/apps/anthropic' };

type Limit = { readonly name: string; readonly admit: (now: number, open: number) => boolean; readonly note: (now: number) => void };

const concurrencyLimit = (max: number): Limit => ({ name: `${max} open requests`, admit: (_now, open) => open < max, note: () => {} });

function rateLimit(perSecond: number): Limit {
  const starts: number[] = [];
  return {
    name: `${perSecond} requests a second`,
    admit: (now) => {
      while (starts.length > 0 && starts[0]! <= now - 1000) starts.shift();
      return starts.length < perSecond;
    },
    note: (now) => void starts.push(now),
  };
}

function server(limit: Limit, latencyMs: number) {
  let open = 0;
  let rejected = 0;
  const reply = (r: Reply) =>
    r.failure === undefined
      ? new Response(sseBody(r), { status: 200, headers: { 'content-type': 'text/event-stream' } })
      : new Response(JSON.stringify(r.failure.body), { status: r.failure.status, headers: { 'content-type': 'application/json', ...r.failure.headers } });
  const fetch: typeof globalThis.fetch = async () => {
    const now = Date.now();
    if (!limit.admit(now, open)) {
      rejected++;
      return reply(httpError(429, { error: { type: 'rate_limit_error', message: 'Too many requests' } }, { 'retry-after-ms': '500' }));
    }
    limit.note(now);
    open++;
    await sleep(latencyMs);
    open--;
    return reply(answer('ok', { input: 1, cacheRead: 0, cacheWrite: 0 }));
  };
  return { fetch, rejected: () => rejected };
}

type Setup = { readonly name: string; readonly slots: () => ModelSlots };

const SETUPS: readonly Setup[] = [
  // Before U26: no shared limit, and a 429 makes only its own call wait.
  { name: 'per-call backoff only', slots: () => ({ ...modelSlots(1_000), pause: () => {} }) },
  { name: 'shared slots (4) + pause', slots: () => modelSlots(4) },
];

const LOADS = [
  { name: '4 lanes', streams: 4 },
  { name: '4 lanes + a child each', streams: 8 },
];
const CALLS_PER_STREAM = 6;
const RUNS = 3;

async function once(setup: Setup, limit: () => Limit, streams: number) {
  const fake = server(limit(), 150);
  const slots = setup.slots();
  let retries = 0;
  let failed = 0;
  const t0 = performance.now();
  await Promise.all(
    Array.from({ length: streams }, async () => {
      const gateway = gatewayFor('modelstudio', env, fake.fetch, { maxRetries: 3, baseDelayMs: 500, maxDelayMs: 20_000 }, slots);
      for (let i = 0; i < CALLS_PER_STREAM; i++) {
        const result = await gateway.turn({ session, events, tools: [], signal: new AbortController().signal, onText: () => {}, onRetry: () => void retries++ });
        if (result.kind !== 'answer') failed++;
      }
    }),
  );
  return { rejected: fake.rejected(), retries, failed, wallMs: performance.now() - t0, peak: slots.stats().peak };
}

const med = (xs: number[]) => xs.toSorted((a, b) => a - b)[Math.floor(xs.length / 2)]!;
const cell = (xs: number[], f = (x: number) => String(Math.round(x))) => `${f(med(xs))} (${f(Math.min(...xs))}-${f(Math.max(...xs))})`;

console.log(`| Endpoint limit | Load | Gateway | 429s | Failed turns | Wall s | Peak open |`);
console.log(`|---|---|---|---|---|---|---|`);
for (const limit of [() => concurrencyLimit(4), () => rateLimit(6)]) {
  for (const load of LOADS) {
    for (const setup of SETUPS) {
      const runs = [];
      for (let r = 0; r < RUNS; r++) runs.push(await once(setup, limit, load.streams));
      console.log(
        `| ${limit().name} | ${load.name}, ${load.streams * CALLS_PER_STREAM} calls | ${setup.name} | ${cell(runs.map((r) => r.rejected))} | ${cell(runs.map((r) => r.failed))} | ${cell(
          runs.map((r) => r.wallMs),
          (x) => (x / 1000).toFixed(1),
        )} | ${cell(runs.map((r) => r.peak))} |`,
      );
    }
  }
}
