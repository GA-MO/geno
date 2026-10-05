import { describe, expect, it } from 'vitest';
import {
  asSessionId,
  buildRequest,
  hasPendingPrompt,
  nextSeq,
  replayMessages,
  SYSTEM_PROMPT,
  TOOL_DEFINITIONS,
  type Session,
  type TurnEvent,
} from '../src/index.js';

const session: Session = {
  id: asSessionId('s1'),
  createdAt: '2026-10-04T00:00:00.000Z',
  workspace: '/tmp/ws',
  provider: 'openrouter',
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
const error = (seq: number, kind: 'refusal' | 'transport' | 'overflow' | 'abort'): TurnEvent => ({
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
    for (const kind of ['abort', 'transport', 'overflow'] as const) {
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

const toolCall = (seq: number, ...uses: [id: string, name: string, input: object][]): TurnEvent => ({
  kind: 'assistant',
  seq,
  at,
  content: [
    { type: 'text', text: 'Looking.', citations: null },
    ...uses.map(([id, name, input]) => ({ type: 'tool_use' as const, id, name, input, caller: { type: 'direct' as const } })),
  ],
  stopReason: 'tool_use',
  usage: { input: 10, cacheRead: 0, cacheWrite: 900, output: 5 },
  costUsd: 0.001,
  latencyMs: 100,
  model: session.model,
});
const result = (seq: number, toolUseId: string, output: string, status: 'ok' | 'error' = 'ok'): TurnEvent => ({
  kind: 'tool-result',
  seq,
  at,
  toolUseId,
  name: 'grep',
  status,
  output,
});

describe('replayMessages with tools', () => {
  it('puts every result of one assistant turn into one user message, in tool-use order', () => {
    const events = [
      start,
      user(1, 'where?'),
      toolCall(2, ['tu_a', 'grep', { pattern: 'x' }], ['tu_b', 'read', { path: 'a.ts' }]),
      result(3, 'tu_b', 'no such file: a.ts', 'error'),
      result(4, 'tu_a', 'a.ts:1:x'),
      assistant(5, 'done'),
    ];
    const messages = replayMessages(events);
    expect(messages.map((m) => m.role)).toEqual(['user', 'assistant', 'user', 'assistant']);
    expect(messages[2]).toEqual({
      role: 'user',
      content: [
        { type: 'tool_result', tool_use_id: 'tu_a', content: 'a.ts:1:x' },
        { type: 'tool_result', tool_use_id: 'tu_b', content: 'no such file: a.ts', is_error: true },
      ],
    });
  });

  it('shows a spilled result as its notice with head, tail and path', () => {
    const spilled: TurnEvent = {
      kind: 'tool-result',
      seq: 3,
      at,
      toolUseId: 'tu_a',
      name: 'grep',
      status: 'ok',
      spill: { path: '/home/spill/s1/3-grep.txt', bytes: 100_000, head: 'HEAD', tail: 'TAIL' },
    };
    const [, , results] = replayMessages([start, user(1, 'q'), toolCall(2, ['tu_a', 'grep', {}]), spilled]);
    const block = (results!.content as { content: string }[])[0]!;
    expect(block.content).toContain('/home/spill/s1/3-grep.txt');
    expect(block.content).toContain('100000 bytes');
    expect(block.content).toMatch(/HEAD[\s\S]*TAIL/);
  });

  it('follows tool results with a prompt sent after them in the same user message', () => {
    const events = [start, user(1, 'q'), toolCall(2, ['tu_a', 'grep', {}]), result(3, 'tu_a', 'hit'), error(4, 'abort'), user(5, 'go on')];
    expect(replayMessages(events).at(-1)).toEqual({
      role: 'user',
      content: [
        { type: 'tool_result', tool_use_id: 'tu_a', content: 'hit' },
        { type: 'text', text: 'go on' },
      ],
    });
  });
});

describe('buildRequest', () => {
  it('sends the tool definitions only when asked, and breaks the cache on the newest tool result', () => {
    const events = [start, user(1, 'q'), toolCall(2, ['tu_a', 'grep', {}]), result(3, 'tu_a', 'hit')];
    expect(buildRequest(session, events)).not.toHaveProperty('tools');
    const request = buildRequest(session, events, TOOL_DEFINITIONS);
    expect(request.tools).toEqual(TOOL_DEFINITIONS);
    expect(request.messages.at(-1)).toEqual({
      role: 'user',
      content: [{ type: 'tool_result', tool_use_id: 'tu_a', content: 'hit', cache_control: { type: 'ephemeral' } }],
    });
  });

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
