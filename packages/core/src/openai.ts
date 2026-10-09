import { parseToolInput } from './stream-message.js';
import type {
  ContentBlock,
  ContentBlockParam,
  ImageBlockParam,
  Message,
  MessageParam,
  MessageStreamEvent,
  MessageStreamParams,
  StopReason,
  ToolResultBlockParam,
  Usage,
} from '@anthropic-ai/sdk/resources/messages/messages';

/**
 * Translation between Geno's Anthropic-shaped conversation and the OpenAI Chat Completions wire format, both
 * ways: a Messages request becomes a Chat Completions request, and a streamed completion becomes the Messages
 * stream events and final message the rest of Geno already reads. Pure; the engine does the HTTP.
 */

export type ChatPart = { readonly type: 'text'; readonly text: string } | { readonly type: 'image_url'; readonly image_url: { readonly url: string } };

export type ChatToolCall = {
  readonly id: string;
  readonly type: 'function';
  readonly function: { readonly name: string; readonly arguments: string };
};

export type ChatMessage =
  | { readonly role: 'system'; readonly content: string }
  | { readonly role: 'user'; readonly content: string | readonly ChatPart[] }
  | { readonly role: 'assistant'; readonly content: string; readonly tool_calls?: readonly ChatToolCall[] }
  | { readonly role: 'tool'; readonly tool_call_id: string; readonly content: string };

export type ChatTool = {
  readonly type: 'function';
  readonly function: { readonly name: string; readonly description?: string; readonly parameters: unknown };
};

export type ChatToolChoice = 'auto' | 'none' | 'required' | { readonly type: 'function'; readonly function: { readonly name: string } };

/**
 * No token cap is sent: providers disagree on its name and limit, and each defaults to the model's own. The
 * effort and cache breakpoints have no field here; these providers cache a stable prefix on their own.
 */
export type ChatRequest = {
  readonly model: string;
  readonly messages: readonly ChatMessage[];
  readonly tools?: readonly ChatTool[];
  readonly tool_choice?: ChatToolChoice;
  readonly stream: true;
  readonly stream_options: { readonly include_usage: true };
};

export type ChatUsage = {
  readonly prompt_tokens?: number;
  readonly completion_tokens?: number;
  /** OpenAI, Groq, xAI and others. */
  readonly prompt_tokens_details?: { readonly cached_tokens?: number | null } | null;
  /** DeepSeek. */
  readonly prompt_cache_hit_tokens?: number;
  readonly prompt_cache_miss_tokens?: number;
};

export type ChatDelta = {
  readonly role?: string;
  readonly content?: string | null;
  /** DeepSeek, Qwen and vLLM name the reasoning `reasoning_content`; OpenRouter, Groq and Ollama name it `reasoning`. */
  readonly reasoning_content?: string | null;
  readonly reasoning?: string | null;
  readonly tool_calls?: readonly {
    readonly index: number;
    readonly id?: string;
    readonly type?: string;
    readonly function?: { readonly name?: string; readonly arguments?: string };
  }[];
};

export type ChatChunk = {
  readonly id?: string;
  readonly model?: string;
  readonly choices: readonly { readonly index: number; readonly delta: ChatDelta; readonly finish_reason: string | null }[];
  readonly usage?: ChatUsage | null;
};

const omitted = (type: string): ChatPart => ({ type: 'text', text: `[a ${type} block this provider cannot take was left out]` });

function imageUrl({ source }: ImageBlockParam): ChatPart {
  if (source.type === 'base64') return { type: 'image_url', image_url: { url: `data:${source.media_type};base64,${source.data}` } };
  if (source.type === 'url') return { type: 'image_url', image_url: { url: source.url } };
  return omitted('Files API image');
}

function userPart(block: ContentBlockParam): ChatPart | undefined {
  if (block.type === 'text') return { type: 'text', text: block.text };
  if (block.type === 'image') return imageUrl(block);
  // Thinking is bound to the model that wrote it, and another provider cannot read it.
  if (block.type === 'thinking' || block.type === 'redacted_thinking') return undefined;
  return omitted(block.type);
}

/** A tool message holds text only, so a result's images follow in a user message that names the call. */
function toolResult(block: ToolResultBlockParam): { readonly message: ChatMessage; readonly images: readonly ChatPart[] } {
  const parts = typeof block.content === 'string' || block.content === undefined ? [{ type: 'text' as const, text: block.content ?? '' }] : block.content;
  const text = parts.flatMap((part) => (part.type === 'text' ? [part.text] : [])).join('\n');
  const images = parts.flatMap((part) => (part.type === 'image' ? [imageUrl(part)] : []));
  return {
    message: { role: 'tool', tool_call_id: block.tool_use_id, content: block.is_error ? `[error] ${text}` : text },
    images: images.length === 0 ? [] : [{ type: 'text', text: `The result of ${block.tool_use_id} included this image:` }, ...images],
  };
}

const textOf = (content: string | readonly { readonly type: string; readonly text?: string }[]): string =>
  typeof content === 'string' ? content : content.flatMap((block) => (block.type === 'text' && block.text !== undefined ? [block.text] : [])).join('\n\n');

function chatMessages(message: MessageParam): ChatMessage[] {
  if (message.role === 'system') return [{ role: 'system', content: textOf(message.content) }];
  if (typeof message.content === 'string') return [{ role: message.role, content: message.content }];
  if (message.role === 'assistant') {
    const text = message.content.flatMap((block) => (block.type === 'text' ? [block.text] : [])).join('');
    const calls = message.content.flatMap((block): ChatToolCall[] =>
      block.type === 'tool_use' ? [{ id: block.id, type: 'function', function: { name: block.name, arguments: JSON.stringify(block.input) } }] : [],
    );
    return [{ role: 'assistant', content: text, ...(calls.length === 0 ? {} : { tool_calls: calls }) }];
  }
  const results = message.content.flatMap((block) => (block.type === 'tool_result' ? [toolResult(block)] : []));
  const parts = [
    ...results.flatMap((result) => result.images),
    ...message.content.flatMap((block) => (block.type === 'tool_result' ? [] : (userPart(block) ?? []))),
  ];
  return [...results.map((result) => result.message), ...(parts.length === 0 ? [] : [{ role: 'user' as const, content: parts }])];
}

function toolChoice(choice: MessageStreamParams['tool_choice']): ChatToolChoice | undefined {
  if (choice === undefined || choice.type === 'auto') return undefined;
  if (choice.type === 'any') return 'required';
  if (choice.type === 'none') return 'none';
  return { type: 'function', function: { name: choice.name } };
}

export function toChatRequest(params: MessageStreamParams): ChatRequest {
  const system = params.system === undefined ? [] : [{ role: 'system' as const, content: textOf(params.system) }];
  const tools = (params.tools ?? []).flatMap((tool): ChatTool[] =>
    'input_schema' in tool
      ? [{ type: 'function', function: { name: tool.name, ...(tool.description === undefined ? {} : { description: tool.description }), parameters: tool.input_schema } }]
      : [],
  );
  const choice = toolChoice(params.tool_choice);
  return {
    model: params.model,
    messages: [...system, ...params.messages.flatMap(chatMessages)],
    ...(tools.length === 0 ? {} : { tools }),
    ...(choice === undefined ? {} : { tool_choice: choice }),
    stream: true,
    stream_options: { include_usage: true },
  };
}

const STOP_REASONS: Readonly<Record<string, StopReason>> = {
  stop: 'end_turn',
  length: 'max_tokens',
  tool_calls: 'tool_use',
  function_call: 'tool_use',
  content_filter: 'refusal',
};

/** Anthropic counts cached prompt tokens apart from the rest; Chat Completions counts them inside the prompt. */
export function chatUsage(usage: ChatUsage | undefined): Usage {
  const cached = usage?.prompt_tokens_details?.cached_tokens ?? usage?.prompt_cache_hit_tokens ?? 0;
  return {
    input_tokens: Math.max(0, (usage?.prompt_tokens ?? 0) - cached),
    cache_read_input_tokens: cached,
    cache_creation_input_tokens: 0,
    output_tokens: usage?.completion_tokens ?? 0,
    cache_creation: null,
    inference_geo: null,
    output_tokens_details: null,
    server_tool_use: null,
    service_tier: null,
  };
}

type OpenBlock = { readonly index: number; readonly kind: 'thinking' | 'text' };
type ToolDraft = { readonly index: number; readonly id: string; readonly name: string; json: string };

/**
 * Turns streamed chunks into Messages stream events as they arrive, and the final message at the end. Text and
 * reasoning blocks close when another kind starts; tool calls stay open to the end, since providers may
 * interleave the argument fragments of parallel calls.
 */
export function chatStream() {
  const content: ContentBlock[] = [];
  const tools = new Map<number, ToolDraft>();
  let open: OpenBlock | undefined;
  let started: Message | undefined;
  let stopReason: StopReason | null = null;
  let usage: ChatUsage | undefined;

  function start(chunk: ChatChunk, events: MessageStreamEvent[]): void {
    if (started !== undefined) return;
    started = {
      id: chunk.id ?? `chatcmpl_${globalThis.crypto.randomUUID()}`,
      type: 'message',
      role: 'assistant',
      model: chunk.model ?? '',
      content: [],
      container: null,
      diagnostics: null,
      stop_details: null,
      stop_reason: null,
      stop_sequence: null,
      usage: chatUsage(undefined),
    };
    events.push({ type: 'message_start', message: started });
  }

  function close(events: MessageStreamEvent[]): void {
    if (open === undefined) return;
    events.push({ type: 'content_block_stop', index: open.index });
    open = undefined;
  }

  function append(kind: OpenBlock['kind'], text: string, events: MessageStreamEvent[]): void {
    if (open?.kind !== kind) {
      close(events);
      open = { index: content.length, kind };
      const block: ContentBlock = kind === 'text' ? { type: 'text', text: '', citations: null } : { type: 'thinking', thinking: '', signature: '' };
      content.push(block);
      events.push({ type: 'content_block_start', index: open.index, content_block: { ...block } });
    }
    const block = content[open.index]!;
    if (block.type === 'text') block.text += text;
    if (block.type === 'thinking') block.thinking += text;
    events.push({
      type: 'content_block_delta',
      index: open.index,
      delta: kind === 'text' ? { type: 'text_delta', text } : { type: 'thinking_delta', thinking: text },
    });
  }

  function toolDelta(call: NonNullable<ChatDelta['tool_calls']>[number], events: MessageStreamEvent[]): void {
    let draft = tools.get(call.index);
    if (draft === undefined) {
      close(events);
      draft = { index: content.length, id: call.id || `call_${globalThis.crypto.randomUUID()}`, name: call.function?.name ?? '', json: '' };
      tools.set(call.index, draft);
      const block: ContentBlock = { type: 'tool_use', id: draft.id, name: draft.name, input: {}, caller: { type: 'direct' } };
      content.push(block);
      events.push({ type: 'content_block_start', index: draft.index, content_block: { ...block } });
    }
    const fragment = call.function?.arguments ?? '';
    if (fragment === '') return;
    draft.json += fragment;
    events.push({ type: 'content_block_delta', index: draft.index, delta: { type: 'input_json_delta', partial_json: fragment } });
  }

  return {
    push(chunk: ChatChunk): MessageStreamEvent[] {
      const events: MessageStreamEvent[] = [];
      start(chunk, events);
      if (chunk.usage) usage = chunk.usage;
      for (const choice of chunk.choices) {
        const reasoning = choice.delta.reasoning_content ?? choice.delta.reasoning;
        if (reasoning) append('thinking', reasoning, events);
        if (choice.delta.content) append('text', choice.delta.content, events);
        for (const call of choice.delta.tool_calls ?? []) toolDelta(call, events);
        if (choice.finish_reason) stopReason = STOP_REASONS[choice.finish_reason] ?? 'end_turn';
      }
      return events;
    },

    finish(): { readonly events: MessageStreamEvent[]; readonly message: Message } {
      const events: MessageStreamEvent[] = [];
      start({ choices: [] }, events);
      close(events);
      for (const draft of tools.values()) {
        const block = content[draft.index];
        if (block?.type === 'tool_use') block.input = parseToolInput(draft.json);
        events.push({ type: 'content_block_stop', index: draft.index });
      }
      const final = chatUsage(usage);
      events.push({
        type: 'message_delta',
        delta: { container: null, stop_details: null, stop_reason: stopReason, stop_sequence: null },
        usage: {
          input_tokens: final.input_tokens,
          cache_read_input_tokens: final.cache_read_input_tokens,
          cache_creation_input_tokens: final.cache_creation_input_tokens,
          output_tokens: final.output_tokens,
          output_tokens_details: null,
          server_tool_use: null,
        },
      });
      events.push({ type: 'message_stop' });
      return { events, message: { ...started!, content, stop_reason: stopReason, usage: final } };
    },
  };
}
