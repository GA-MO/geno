import { describe, expect, it } from 'vitest';
import {
  asSessionId,
  buildRequest,
  hasPendingPrompt,
  nextSeq,
  replayMessages,
  SYSTEM_PROMPT,
  type Session,
  type TurnEvent,
} from '../src/index.js';

const session: Session = {
  id: asSessionId('s1'),
  createdAt: '2026-10-04T00:00:00.000Z',
  workspace: '/tmp/ws',
  model: 'anthropic/claude-opus-5.5',
  effort: 'medium',
};
const at = '2026-10-04T00:00:01.000Z';
const start: TurnEvent = { kind: 'session-start', session };
const user = (seq: number, content: string): TurnEvent => ({ kind: 'user', seq, at, content });
const assistant = (seq: number, text: string): TurnEvent => ({
  kind: 'assistant',
  seq,
  at,
  content: [
    { type: 'thinking', thinking: `thinking ${seq}`, signature: `sig-${seq}` },
    { type: 'text', text, citations: null },
  ],
  stopReason: 'end_turn',
  usage: { input: 10, cacheRead: 0, cacheWrite: 900, output: 5 },
  costUsd: 0.001,
  latencyMs: 100,
  model: session.model,
});
const error = (seq: number, kind: 'refusal' | 'transport' | 'abort'): TurnEvent => ({
  kind: 'error',
  seq,
  at,
  error: kind,
  message: kind,
});

describe('replayMessages', () => {
  it('rebuilds alternating turns with assistant blocks unchanged', () => {
    const events = [start, user(1, 'hi'), assistant(2, 'hello'), user(3, 'again')];
    expect(replayMessages(events)).toEqual([
      { role: 'user', content: [{ type: 'text', text: 'hi' }] },
      {
        role: 'assistant',
        content: [
          { type: 'thinking', thinking: 'thinking 2', signature: 'sig-2' },
          { type: 'text', text: 'hello', citations: null },
        ],
      },
      { role: 'user', content: [{ type: 'text', text: 'again' }] },
    ]);
  });

  it('keeps a prompt interrupted by an abort or transport error and merges the next one into it', () => {
    for (const kind of ['abort', 'transport'] as const) {
      const events = [start, user(1, 'first'), error(2, kind), user(3, 'second')];
      expect(replayMessages(events)).toEqual([
        {
          role: 'user',
          content: [
            { type: 'text', text: 'first' },
            { type: 'text', text: 'second' },
          ],
        },
      ]);
      expect(hasPendingPrompt(events.slice(0, 3))).toBe(true);
    }
  });

  it('drops a refused prompt so it is never resent', () => {
    const events = [start, user(1, 'bad'), error(2, 'refusal'), user(3, 'fine')];
    expect(replayMessages(events)).toEqual([{ role: 'user', content: [{ type: 'text', text: 'fine' }] }]);
    expect(hasPendingPrompt(events.slice(0, 3))).toBe(false);
  });

  it('numbers events after the session header from 1', () => {
    expect(nextSeq([start])).toBe(1);
    expect(nextSeq([start, user(1, 'a'), error(2, 'abort')])).toBe(3);
  });
});

describe('buildRequest', () => {
  it('marks the system block and only the newest user block as cache breakpoints', () => {
    const request = buildRequest(session, [start, user(1, 'hi'), assistant(2, 'hello'), user(3, 'a'), error(4, 'abort'), user(5, 'b')]);
    expect(request.system).toEqual([{ type: 'text', text: SYSTEM_PROMPT, cache_control: { type: 'ephemeral' } }]);
    expect(request.messages).toEqual([
      { role: 'user', content: [{ type: 'text', text: 'hi' }] },
      expect.objectContaining({ role: 'assistant' }),
      {
        role: 'user',
        content: [
          { type: 'text', text: 'a' },
          { type: 'text', text: 'b', cache_control: { type: 'ephemeral' } },
        ],
      },
    ]);
    expect(request).toMatchObject({ model: session.model, max_tokens: 64000, output_config: { effort: 'medium' } });
    expect(request).not.toHaveProperty('thinking');
  });

  it('has a system prompt long enough to cache (512 tokens at roughly 4 characters each)', () => {
    expect(SYSTEM_PROMPT.length).toBeGreaterThan(512 * 4);
  });
});
