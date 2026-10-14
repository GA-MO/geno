import { describe, expect, it } from 'vitest';
import {
  AGENT_PROMPTS,
  asSessionId,
  buildRequest,
  hasPendingPrompt,
  nextSeq,
  replayMessages,
  SYSTEM_PROMPT,
  TOOL_DEFINITIONS,
  type Session,
  type TurnEvent,
  STOPPED_TURN_NOTE,
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
            ...(kind === 'abort' ? [{ type: 'text', text: STOPPED_TURN_NOTE }] : []),
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

  it('numbers past a mode switch logged beside a running turn, which has no seq', () => {
    const beside: TurnEvent = { kind: 'mode', at: '2026-01-01T00:00:00.000Z', mode: 'auto' };
    expect(nextSeq([start, user(1, 'a'), beside])).toBe(2);
    expect(nextSeq([start, beside])).toBe(1);
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
        { type: 'text', text: STOPPED_TURN_NOTE },
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
          { type: 'text', text: STOPPED_TURN_NOTE },
          { type: 'text', text: 'b', cache_control: { type: 'ephemeral' } },
        ],
      },
    ]);
    expect(request).toMatchObject({ model: session.model, max_tokens: 128_000, output_config: { effort: 'medium' } });
    expect(request).not.toHaveProperty('thinking');
  });

  describe('with the model capability record', () => {
    const opus: Session = { ...session, provider: 'anthropic', model: 'claude-opus-5-5' };
    const flash: Session = { ...session, provider: 'modelstudio', model: 'qwen3.8-flash' };
    const unknown: Session = { ...session, provider: 'openrouter', model: 'some/model' };
    const measured = (seq: number, input: number): TurnEvent => ({
      kind: 'assistant',
      seq,
      at,
      content: [{ type: 'text', text: 'ok', citations: null }],
      stopReason: 'end_turn',
      usage: { input, cacheRead: 0, cacheWrite: 0, output: 5 },
      costUsd: 0.001,
      latencyMs: 100,
      model: opus.model,
    });
    const breakpoints = (request: ReturnType<typeof buildRequest>) => [
      ...(request.system as { cache_control?: unknown }[]).map((block) => block.cache_control),
      ...request.messages.flatMap((m) => (typeof m.content === 'string' ? [] : m.content.flatMap((b) => ('cache_control' in b && b.cache_control ? [b.cache_control] : [])))),
    ];

    it('asks Anthropic for adaptive thinking, its full output limit and 1 h cache entries at every breakpoint', () => {
      const request = buildRequest(opus, [start, user(1, 'hi')]);
      expect(request).toMatchObject({ max_tokens: 128_000, thinking: { type: 'adaptive', display: 'omitted' }, output_config: { effort: 'medium' } });
      expect(breakpoints(request)).toEqual([
        { type: 'ephemeral', ttl: '1h' },
        { type: 'ephemeral', ttl: '1h' },
      ]);
    });

    it('sends Model Studio no thinking field and default-TTL breakpoints, byte for byte as before', () => {
      const request = buildRequest(flash, [start, user(1, 'hi')]);
      expect(request).not.toHaveProperty('thinking');
      expect(request.max_tokens).toBe(131_072);
      expect(breakpoints(request)).toEqual([{ type: 'ephemeral' }, { type: 'ephemeral' }]);
    });

    it('sends effort only to a model that takes it: none to Haiku 4.5, which refuses it, or to an unknown model', () => {
      const haiku: Session = { ...session, provider: 'anthropic', model: 'claude-haiku-4-5' };
      expect(buildRequest(flash, [start, user(1, 'hi')]).output_config).toEqual({ effort: 'medium' });
      expect(buildRequest(haiku, [start, user(1, 'hi')])).not.toHaveProperty('output_config');
      expect(buildRequest(unknown, [start, user(1, 'hi')])).not.toHaveProperty('output_config');
    });

    it('clamps max_tokens to the window minus the input and a 1,000-token margin near a full window', () => {
      const events = [start, user(1, 'hi'), measured(2, 899_995), user(3, 'go on')];
      expect(buildRequest(opus, events).max_tokens).toBe(1_000_000 - 900_000 - 2 - 1_000);
    });

    it('still asks for one token when the input alone fills the window, so the provider answers with an overflow', () => {
      const events = [start, user(1, 'hi'), measured(2, 1_200_000), user(3, 'go on')];
      expect(buildRequest(opus, events).max_tokens).toBe(1);
    });

    it('forces a tool with thinking off in the shape the model takes, and offers it with auto to a model that refuses a forced tool', () => {
      const forced = (s: Session) => {
        const { thinking, tool_choice } = buildRequest(s, [start, user(1, 'hi')], TOOL_DEFINITIONS, 'system', undefined, 'read');
        return { thinking, tool_choice };
      };
      const haiku: Session = { ...session, provider: 'anthropic', model: 'claude-haiku-4-5' };
      const sonnet: Session = { ...session, provider: 'anthropic', model: 'claude-sonnet-5-5' };
      expect(forced(flash)).toEqual({ thinking: { type: 'disabled' }, tool_choice: { type: 'tool', name: 'read' } });
      expect(forced(haiku)).toEqual({ thinking: { type: 'disabled' }, tool_choice: { type: 'tool', name: 'read' } });
      expect(forced(unknown)).toEqual({ thinking: { type: 'disabled' }, tool_choice: { type: 'tool', name: 'read' } });
      // Claude Sonnet and Opus 5.5 answer a forced tool_choice, and a disabled thinking, with a 400.
      expect(forced(sonnet)).toEqual({ thinking: { type: 'adaptive', display: 'omitted' }, tool_choice: undefined });
      expect(forced(opus)).toEqual({ thinking: { type: 'adaptive', display: 'omitted' }, tool_choice: undefined });
    });

    it('turns the tools off on a last call with tool_choice none on every model, Claude 5.5 too', () => {
      const sonnet: Session = { ...session, provider: 'anthropic', model: 'claude-sonnet-5-5' };
      for (const s of [flash, sonnet, opus]) {
        const request = buildRequest(s, [start, user(1, 'hi')], TOOL_DEFINITIONS, 'system', undefined, undefined, true);
        expect(request.tool_choice, s.model).toEqual({ type: 'none' });
        expect((request.thinking as { type?: string } | undefined)?.type, s.model).not.toBe('disabled');
      }
    });

    it('sends the fallback output limit, unclamped, for a model whose window is unknown', () => {
      const events = [start, user(1, 'hi'), measured(2, 5_000_000), user(3, 'go on')];
      expect(buildRequest(unknown, events).max_tokens).toBe(64_000);
    });
  });

  it('has a system prompt long enough to cache (512 tokens at roughly 4 characters each)', () => {
    expect(SYSTEM_PROMPT.length).toBeGreaterThan(512 * 4);
  });

  it('offers mermaid diagrams in the fixed system prompt and in both agent tiers', () => {
    const line = "- When a flow, architecture or process is clearer drawn than written, you may add a small mermaid diagram as a fenced code block with the language mermaid; the chat draws it.";
    expect(SYSTEM_PROMPT.split('\n')).toContain(line);
    expect(AGENT_PROMPTS.principles.startsWith(SYSTEM_PROMPT)).toBe(true);
    expect(AGENT_PROMPTS.rules.split('\n')).toContain(line);
  });
});
