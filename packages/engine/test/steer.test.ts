import { describe, expect, it, vi } from 'vitest';
import { asSessionId, REPLAYED_TURN_META, STEER_META, steerEvent, type TurnEvent } from '@g-code/core';
import { replayUpdates } from '../src/session-replay.js';
import { Steers, steerRunning } from '../src/steer.js';

// A steer that never lands must fail here in seconds, never leave a worker spinning.
vi.setConfig({ testTimeout: 15_000, hookTimeout: 15_000 });

function bounded<T>(work: Promise<T>, step: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => (timer = setTimeout(() => reject(new Error(`timed out after 1000ms waiting for ${step}`)), 1000)));
  return Promise.race([work, timeout]).finally(() => clearTimeout(timer));
}

const text = (t: string) => [{ type: 'text' as const, text: t }];

describe('steer inbox', () => {
  it('queues in order, settles each with where it was logged, and sends what is left to the next turn', async () => {
    const steers = new Steers();
    const inbox = steers.open('s1', undefined);
    const first = inbox.push({ text: 'a', from: 'user' })!;
    const also = inbox.push({ text: 'b', from: 'user' })!;
    const taken = inbox.take();
    expect(taken.map((q) => q.steer.text)).toEqual(['a', 'b']);
    taken.forEach((q, i) => q.settle({ kind: 'delivered', seq: 5 + i }));
    expect(await bounded(also, 'the second steer to settle')).toEqual({ kind: 'delivered', seq: 6 });
    const second = inbox.push({ text: 'late', from: 'user' })!;
    steers.release('s1', inbox);
    expect(await bounded(first, 'the first steer to settle')).toEqual({ kind: 'delivered', seq: 5 });
    expect(await bounded(second, 'the late steer to go to the next turn')).toEqual({ kind: 'next-turn' });
    expect(inbox.push({ text: 'c', from: 'user' }), 'a closed run takes nothing').toBeUndefined();
    expect(steers.of('s1')).toBeUndefined();
  });

  it('wakes a run that waits for a background report once the report is pushed', async () => {
    const inbox = new Steers().open('s1', undefined);
    const paid = inbox.owe();
    expect(inbox.owed).toBe(1);
    const waited = inbox.arrival(new AbortController().signal);
    inbox.push({ text: 'report', from: 'child' });
    paid();
    await bounded(waited, 'the run to wake for the report');
    expect(inbox.owed).toBe(0);
    expect(inbox.queued().map((s) => s.from)).toEqual(['child']);
  });

  it('stops waiting on abort', async () => {
    const inbox = new Steers().open('s1', undefined);
    inbox.owe();
    const controller = new AbortController();
    const waited = inbox.arrival(controller.signal);
    controller.abort();
    await expect(bounded(waited, 'the abort to end the wait')).resolves.toBeUndefined();
  });
});

describe('replay', () => {
  it('shows a steer inside the turn it joined, after the tool it followed', () => {
    const at = '2026-10-06T00:00:01.000Z';
    const events: TurnEvent[] = [
      { kind: 'session-start', session: { id: asSessionId('s1'), createdAt: at, workspace: '/tmp/ws', provider: 'modelstudio', model: 'qwen3.8-flash', effort: 'medium' } },
      { kind: 'user', seq: 1, at, content: 'find alpha' },
      {
        kind: 'assistant',
        seq: 2,
        at,
        content: [{ type: 'tool_use', id: 'tu_1', name: 'grep', input: { pattern: 'alpha' }, caller: { type: 'direct' } }],
        stopReason: 'tool_use',
        usage: { input: 1, cacheRead: 0, cacheWrite: 0, output: 1 },
        costUsd: 0,
        latencyMs: 1,
        model: 'qwen3.8-flash',
      },
      { kind: 'tool-result', seq: 3, at, toolUseId: 'tu_1', name: 'grep', status: 'ok', output: 'a.ts:1' },
      steerEvent({ text: 'and beta', from: 'user' }, 4, at),
      { kind: 'assistant', seq: 5, at, content: [{ type: 'text', text: 'both found', citations: null }], stopReason: 'end_turn', usage: { input: 1, cacheRead: 0, cacheWrite: 0, output: 1 }, costUsd: 0, latencyMs: 1, model: 'qwen3.8-flash' },
    ];
    const shown = replayUpdates(events).map((u) => [u.sessionUpdate, u._meta?.[REPLAYED_TURN_META] !== undefined ? 'turn' : (u._meta?.[STEER_META] ?? null)]);
    expect(shown).toEqual([
      ['user_message_chunk', 'turn'],
      ['tool_call', null],
      ['tool_call_update', null],
      ['user_message_chunk', { seq: 4, from: 'user' }],
      ['agent_message_chunk', null],
    ]);
  });
});

describe('steerRunning', () => {
  it('refuses anything but text', async () => {
    await expect(steerRunning(new Steers(), 's1', [{ type: 'image', data: '', mimeType: 'image/png' }])).rejects.toThrow(/text only/);
    await expect(steerRunning(new Steers(), 's1', text('  '))).rejects.toThrow(/no text/);
  });

  it('is the next turn when no run takes it, and refused for a child that finished', async () => {
    const steers = new Steers();
    expect(await steerRunning(steers, 's1', text('hi'))).toEqual({ kind: 'next-turn' });
    const child = steers.open('c1', asSessionId('s1'));
    steers.release('c1', child);
    await expect(steerRunning(steers, 'c1', text('hi'))).rejects.toThrow(/the subagent already finished/);
  });
});
