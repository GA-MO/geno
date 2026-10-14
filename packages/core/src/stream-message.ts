import type { ContentBlock, Message, MessageStreamEvent } from '@anthropic-ai/sdk/resources/messages/messages';
import { TOOL_SEARCH_TOOL } from './deferred-tools.js';

const NAMES = String.raw`[\w.:-]+(?:\s*,\s*[\w.:-]+)*`;
const BARE_SELECT = new RegExp(String.raw`^\s*\{\s*"select"\s*:\s*(?:\[\s*(${NAMES})\s*\]|(${NAMES}))\s*\}\s*$`);

/** Claude sends tool_search `{"select": show_files}` with the names unquoted, as Claude Code's ToolSearch takes them in a bare `select:a,b` query. */
function bareSelect(tool: string, json: string): { readonly select: readonly string[] } | undefined {
  if (tool !== TOOL_SEARCH_TOOL) return undefined;
  const match = BARE_SELECT.exec(json);
  const names = match?.[1] ?? match?.[2];
  return names === undefined ? undefined : { select: names.split(',').map((name) => name.trim()) };
}

/** Arguments that are not a JSON object reach the tool as `{ invalid_json }`, so its error shows the model what it sent (`invalidInputError`). */
export function parseToolInput(tool: string, json: string): unknown {
  if (json.trim() === '') return {};
  try {
    const parsed: unknown = JSON.parse(json);
    return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed) ? parsed : { invalid_json: json };
  } catch {
    return bareSelect(tool, json) ?? { invalid_json: json };
  }
}

const isJson = (text: string): boolean => {
  try {
    JSON.parse(text);
    return true;
  } catch {
    return false;
  }
};

/** What `tool` answers to arguments `parseToolInput` could not take as a JSON object, echoing them; undefined for any other input. */
export function invalidInputError(tool: string, input: unknown): string | undefined {
  if (typeof input !== 'object' || input === null || Object.keys(input).length !== 1) return undefined;
  const text = (input as { readonly invalid_json?: unknown }).invalid_json;
  if (typeof text !== 'string') return undefined;
  const problem = isJson(text) ? 'was JSON but not an object' : 'was not valid JSON';
  return `Your input to ${tool} ${problem}: ${text}. Send it again as a JSON object that matches the tool's input_schema.`;
}

type Mutable<T> = { -readonly [K in keyof T]: T[K] };

/**
 * The message a finished stream carried, built from its events. The SDK's own `finalMessage` throws on a tool input
 * that is not JSON, which a cheap model sometimes sends; here that input becomes `{ invalid_json }` instead, so the
 * tool refuses it and the model can send it again, as on the Chat Completions wire. Undefined when the stream never
 * started or never stopped.
 */
export function messageFromEvents(events: readonly MessageStreamEvent[]): Message | undefined {
  let message: Mutable<Message> | undefined;
  const json = new Map<number, string>();
  let stopped = false;
  for (const event of events) {
    switch (event.type) {
      case 'message_start':
        message = { ...event.message, content: [] };
        break;
      case 'content_block_start':
        // The SDK's own stream gives a text block `citations: null` when none came, and the next request sends it back as given.
        if (message === undefined) break;
        (message.content as ContentBlock[])[event.index] = { ...event.content_block, ...(event.content_block.type === 'text' ? { citations: event.content_block.citations ?? null } : {}) } as ContentBlock;
        break;
      case 'content_block_delta': {
        const block = message?.content[event.index] as Record<string, unknown> | undefined;
        if (block === undefined) break;
        const { delta } = event;
        if (delta.type === 'text_delta') block['text'] = `${(block['text'] as string | undefined) ?? ''}${delta.text}`;
        else if (delta.type === 'input_json_delta') json.set(event.index, `${json.get(event.index) ?? ''}${delta.partial_json}`);
        else if (delta.type === 'thinking_delta') block['thinking'] = `${(block['thinking'] as string | undefined) ?? ''}${delta.thinking}`;
        else if (delta.type === 'signature_delta') block['signature'] = delta.signature;
        else if (delta.type === 'citations_delta') block['citations'] = [...((block['citations'] as unknown[] | null | undefined) ?? []), delta.citation];
        break;
      }
      case 'content_block_stop': {
        const block = message?.content[event.index] as Record<string, unknown> | undefined;
        const buffered = json.get(event.index);
        if (block === undefined || buffered === undefined) break;
        // Set last, as the SDK's own stream does, so the next request sends the block's fields in the same order.
        delete block['input'];
        block['input'] = parseToolInput(block['name'] as string, buffered);
        break;
      }
      case 'message_delta':
        if (message === undefined) break;
        message.stop_reason = event.delta.stop_reason;
        message.stop_sequence = event.delta.stop_sequence;
        message.usage = { ...message.usage, ...Object.fromEntries(Object.entries(event.usage).filter(([, value]) => value !== null)) };
        break;
      case 'message_stop':
        stopped = true;
        break;
    }
  }
  return stopped ? message : undefined;
}
