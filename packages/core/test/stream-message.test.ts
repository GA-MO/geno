import { describe, expect, it } from 'vitest';
import type { MessageStreamEvent } from '@anthropic-ai/sdk/resources/messages/messages';
import { messageFromEvents, parseToolInput } from '../src/index.js';

describe('parseToolInput', () => {
  it('takes tool_search names Claude sent unquoted, as Claude Sonnet did in real runs', () => {
    expect(parseToolInput('tool_search', '{"select": show_files}')).toEqual({ select: ['show_files'] });
    expect(parseToolInput('tool_search', '{"select": task_stop}')).toEqual({ select: ['task_stop'] });
    expect(parseToolInput('tool_search', '{"select": [bash_output, mcp__docs.search-v2:x]}')).toEqual({ select: ['bash_output', 'mcp__docs.search-v2:x'] });
    expect(parseToolInput('tool_search', ' { "select" : monitor , task_stop } ')).toEqual({ select: ['monitor', 'task_stop'] });
  });

  it('keeps every other malformed input invalid', () => {
    for (const [tool, json] of [
      ['read', '{"path": src/a.ts}'],
      ['read', '{"select": show_files}'],
      ['tool_search', '{"select": show_files, "x": 1}'],
      ['tool_search', '{"query": browser}'],
      ['tool_search', '{"select": [show_files, "monitor"]}'],
      ['tool_search', '{"select": show files}'],
      ['tool_search', '{"select": }'],
    ] as const) {
      expect(parseToolInput(tool, json)).toEqual({ invalid_json: json });
    }
  });

  it('repairs a streamed Anthropic tool_search call', () => {
    const message = messageFromEvents([
      { type: 'message_start', message: { id: 'm', type: 'message', role: 'assistant', model: 'claude', content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 1, output_tokens: 0 } } } as unknown as MessageStreamEvent,
      { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 't', name: 'tool_search', input: {} } } as MessageStreamEvent,
      { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '{"select": ' } },
      { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: 'task_stop}' } },
      { type: 'content_block_stop', index: 0 },
      { type: 'message_stop' },
    ]);
    expect(message?.content[0]).toMatchObject({ type: 'tool_use', name: 'tool_search', input: { select: ['task_stop'] } });
  });

  it('leaves valid JSON as it came', () => {
    expect(parseToolInput('tool_search', '{"select": ["show_files"]}')).toEqual({ select: ['show_files'] });
    expect(parseToolInput('tool_search', '{"select": "show_files"}')).toEqual({ select: 'show_files' });
  });
});
