import { describe, expect, it } from 'vitest';
import type { MessageStreamEvent, MessageStreamParams } from '@anthropic-ai/sdk/resources/messages/messages';
import { chatStream, toChatRequest, type ChatChunk } from '../src/index.js';

const PNG = 'iVBORw0KGgo=';

const params: MessageStreamParams = {
  model: 'gpt-test',
  max_tokens: 64000,
  system: [{ type: 'text', text: 'You are Geno.', cache_control: { type: 'ephemeral' } }],
  tools: [{ name: 'read', description: 'Read a file', input_schema: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] } }],
  output_config: { effort: 'medium' },
  messages: [
    {
      role: 'user',
      content: [
        { type: 'image', source: { type: 'base64', media_type: 'image/png', data: PNG } },
        { type: 'text', text: 'What is in a.ts and this picture?' },
      ],
    },
    {
      role: 'assistant',
      content: [
        { type: 'thinking', thinking: 'hidden', signature: 'sig' },
        { type: 'text', text: 'Reading both.' },
        { type: 'tool_use', id: 'call_1', name: 'read', input: { path: 'a.ts' } },
        { type: 'tool_use', id: 'call_2', name: 'read', input: { path: 'shot.png' } },
      ],
    },
    {
      role: 'user',
      content: [
        { type: 'tool_result', tool_use_id: 'call_1', content: 'export const a = 1;' },
        {
          type: 'tool_result',
          tool_use_id: 'call_2',
          is_error: true,
          content: [
            { type: 'text', text: 'shot.png, 2x1' },
            { type: 'image', source: { type: 'url', url: 'https://example.com/shot.png' } },
          ],
        },
        { type: 'text', text: 'Thanks.', cache_control: { type: 'ephemeral' } },
      ],
    },
  ],
};

describe('toChatRequest', () => {
  const request = toChatRequest(params);

  it('turns the system blocks into one system message, and streams with usage', () => {
    expect(request.model).toBe('gpt-test');
    expect(request.messages[0]).toEqual({ role: 'system', content: 'You are Geno.' });
    expect(request.stream).toBe(true);
    expect(request.stream_options).toEqual({ include_usage: true });
  });

  it('sends images as data URLs and text as parts, in order', () => {
    expect(request.messages[1]).toEqual({
      role: 'user',
      content: [
        { type: 'image_url', image_url: { url: `data:image/png;base64,${PNG}` } },
        { type: 'text', text: 'What is in a.ts and this picture?' },
      ],
    });
  });

  it('turns tool_use blocks into tool calls with JSON arguments, and drops thinking', () => {
    expect(request.messages[2]).toEqual({
      role: 'assistant',
      content: 'Reading both.',
      tool_calls: [
        { id: 'call_1', type: 'function', function: { name: 'read', arguments: '{"path":"a.ts"}' } },
        { id: 'call_2', type: 'function', function: { name: 'read', arguments: '{"path":"shot.png"}' } },
      ],
    });
  });

  it('answers each call with a tool message, then hands its images and the prompt over as a user message', () => {
    expect(request.messages.slice(3)).toEqual([
      { role: 'tool', tool_call_id: 'call_1', content: 'export const a = 1;' },
      { role: 'tool', tool_call_id: 'call_2', content: '[error] shot.png, 2x1' },
      {
        role: 'user',
        content: [
          { type: 'text', text: 'The result of call_2 included this image:' },
          { type: 'image_url', image_url: { url: 'https://example.com/shot.png' } },
          { type: 'text', text: 'Thanks.' },
        ],
      },
    ]);
  });

  it('declares tools as functions and leaves out what Chat Completions has no field for', () => {
    expect(request.tools).toEqual([
      { type: 'function', function: { name: 'read', description: 'Read a file', parameters: (params.tools![0] as { input_schema: unknown }).input_schema } },
    ]);
    const raw = JSON.stringify(request);
    for (const absent of ['cache_control', 'output_config', 'max_tokens', 'thinking', 'signature']) expect(raw).not.toContain(absent);
  });

  it('maps a forced tool choice to the function it names', () => {
    expect(toChatRequest({ ...params, tool_choice: { type: 'tool', name: 'read' } }).tool_choice).toEqual({ type: 'function', function: { name: 'read' } });
    expect(toChatRequest({ ...params, tool_choice: { type: 'any' } }).tool_choice).toBe('required');
    expect(toChatRequest(params).tool_choice).toBeUndefined();
  });

  it('is byte-stable for the same conversation, so the provider’s automatic prefix cache hits', () => {
    expect(JSON.stringify(toChatRequest(params))).toBe(JSON.stringify(toChatRequest(structuredClone(params))));
  });
});

const chunk = (delta: Record<string, unknown>, finish: string | null = null): ChatChunk => ({
  id: 'chatcmpl-1',
  model: 'gpt-test-0001',
  choices: [{ index: 0, delta, finish_reason: finish }],
});

function run(chunks: readonly ChatChunk[]) {
  const stream = chatStream();
  const events: MessageStreamEvent[] = chunks.flatMap((c) => stream.push(c));
  const end = stream.finish();
  return { events: [...events, ...end.events], message: end.message };
}

describe('chatStream', () => {
  it('turns reasoning, text and two streamed tool calls into Anthropic events and one message', () => {
    const { events, message } = run([
      chunk({ role: 'assistant', reasoning_content: 'Let me ' }),
      chunk({ reasoning_content: 'look.' }),
      chunk({ content: 'Reading ' }),
      chunk({ content: 'a.ts.' }),
      chunk({ tool_calls: [{ index: 0, id: 'call_a', type: 'function', function: { name: 'read', arguments: '{"pa' } }] }),
      chunk({ tool_calls: [{ index: 0, function: { arguments: 'th":"a.ts"}' } }] }),
      chunk({ tool_calls: [{ index: 1, id: 'call_b', type: 'function', function: { name: 'grep', arguments: '{"pattern":"x"}' } }] }),
      chunk({}, 'tool_calls'),
      { id: 'chatcmpl-1', model: 'gpt-test-0001', choices: [], usage: { prompt_tokens: 1200, completion_tokens: 40, prompt_tokens_details: { cached_tokens: 1000 } } },
    ]);

    expect(message).toMatchObject({
      id: 'chatcmpl-1',
      type: 'message',
      role: 'assistant',
      model: 'gpt-test-0001',
      stop_reason: 'tool_use',
      content: [
        { type: 'thinking', thinking: 'Let me look.', signature: '' },
        { type: 'text', text: 'Reading a.ts.' },
        { type: 'tool_use', id: 'call_a', name: 'read', input: { path: 'a.ts' } },
        { type: 'tool_use', id: 'call_b', name: 'grep', input: { pattern: 'x' } },
      ],
      usage: { input_tokens: 200, cache_read_input_tokens: 1000, cache_creation_input_tokens: 0, output_tokens: 40 },
    });
    expect(events.map((e) => e.type)).toEqual([
      'message_start',
      'content_block_start',
      'content_block_delta',
      'content_block_delta',
      'content_block_stop',
      'content_block_start',
      'content_block_delta',
      'content_block_delta',
      'content_block_stop',
      'content_block_start',
      'content_block_delta',
      'content_block_delta',
      'content_block_start',
      'content_block_delta',
      'content_block_stop',
      'content_block_stop',
      'message_delta',
      'message_stop',
    ]);
    const textDeltas = events.flatMap((e) => (e.type === 'content_block_delta' && e.delta.type === 'text_delta' ? [e.delta.text] : []));
    expect(textDeltas).toEqual(['Reading ', 'a.ts.']);
  });

  it('reads DeepSeek’s cache fields, and maps each finish reason', () => {
    const deepseek = run([chunk({ content: 'Hi' }, 'stop'), { choices: [], usage: { prompt_tokens: 50, completion_tokens: 2, prompt_cache_hit_tokens: 30, prompt_cache_miss_tokens: 20 } }]);
    expect(deepseek.message.usage).toMatchObject({ input_tokens: 20, cache_read_input_tokens: 30, output_tokens: 2 });
    expect(deepseek.message.stop_reason).toBe('end_turn');
    expect(run([chunk({ content: 'cut' }, 'length')]).message.stop_reason).toBe('max_tokens');
    expect(run([chunk({}, 'content_filter')]).message.stop_reason).toBe('refusal');
  });

  it('gives a call the provider sent without an id one of its own, and keeps bad JSON visible to the model', () => {
    const { message } = run([chunk({ tool_calls: [{ index: 0, function: { name: 'read', arguments: '{"path":' } }] }, 'tool_calls')]);
    const [use] = message.content;
    expect(use).toMatchObject({ type: 'tool_use', name: 'read', input: { invalid_json: '{"path":' } });
    expect(use?.type === 'tool_use' && use.id).toMatch(/^call_[A-Za-z0-9_-]+$/);
  });

  it('takes tool_search names sent unquoted', () => {
    const { message } = run([chunk({ tool_calls: [{ index: 0, id: 'call_a', function: { name: 'tool_search', arguments: '{"select": show_files}' } }] }, 'tool_calls')]);
    expect(message.content[0]).toMatchObject({ type: 'tool_use', name: 'tool_search', input: { select: ['show_files'] } });
  });

  it('round-trips: the message it builds goes back out as the same tool calls', () => {
    const { message } = run([
      chunk({ content: 'Reading.' }),
      chunk({ tool_calls: [{ index: 0, id: 'call_a', function: { name: 'read', arguments: '{"path":"a.ts"}' } }] }, 'tool_calls'),
    ]);
    const next = toChatRequest({ model: 'gpt-test', max_tokens: 10, messages: [{ role: 'user', content: 'go' }, { role: 'assistant', content: message.content }] });
    expect(next.messages.at(-1)).toEqual({
      role: 'assistant',
      content: 'Reading.',
      tool_calls: [{ id: 'call_a', type: 'function', function: { name: 'read', arguments: '{"path":"a.ts"}' } }],
    });
  });
});
