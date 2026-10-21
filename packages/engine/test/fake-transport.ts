import { MCP_TOOLS_HEADER } from '@g-code/core';

type SseEvent = { readonly type: string } & Record<string, unknown>;

export type Reply = {
  readonly events: readonly SseEvent[];
  /** Emit this many events, then stall until the request is aborted. */
  readonly stallAfter?: number;
  /** Send no headers and no body until the request is aborted, as a provider that took the request and went quiet. */
  readonly hang?: true;
  /** Wait this long before each event, as a slow but live stream does. */
  readonly everyMs?: number;
  /** Emit this many events, then drop the connection the way undici reports a peer reset. */
  readonly dropAfter?: number;
  /** Answer with this HTTP error instead of a stream. */
  readonly failure?: { readonly status: number; readonly body: unknown; readonly headers?: Record<string, string> };
  /** Fail before any answer, as fetch does when nothing listens at the provider's address. */
  readonly offline?: true;
};

/** A request that never reaches the provider: undici's refused connection. */
export const OFFLINE: Reply = { events: [], offline: true };

export const refusedConnection = (): TypeError =>
  new TypeError('fetch failed', { cause: Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:443'), { code: 'ECONNREFUSED' }) });

/** An HTTP error response, such as a 529 overload, with the provider's JSON error body. */
export const httpError = (status: number, body: unknown, headers: Record<string, string> = {}): Reply => ({
  events: [],
  failure: { status, body, headers },
});

export type RecordedRequest = { readonly url: string; readonly headers: Headers; readonly body: any };

export type CacheUsage = { readonly input: number; readonly cacheRead: number; readonly cacheWrite: number };

function messageStart(usage: CacheUsage): SseEvent {
  return {
    type: 'message_start',
    message: {
      id: 'msg_fake',
      type: 'message',
      role: 'assistant',
      model: 'qwen3.8-flash',
      content: [],
      stop_reason: null,
      stop_sequence: null,
      stop_details: null,
      usage: {
        input_tokens: usage.input,
        cache_creation_input_tokens: usage.cacheWrite,
        cache_read_input_tokens: usage.cacheRead,
        output_tokens: 1,
      },
    },
  };
}

/** `rawJson` streams that text as the input instead of `input`, for a model that sends arguments that are not JSON. */
export type FakeToolUse = { readonly id: string; readonly name: string; readonly input: unknown; readonly rawJson?: string };

type OfferingBody = {
  readonly tools?: readonly { readonly name: string; readonly description?: string }[];
  readonly messages?: readonly unknown[];
};

const textBlocks = (content: unknown): string[] =>
  typeof content === 'string'
    ? [content]
    : Array.isArray(content)
      ? content.flatMap((block: { type?: unknown; text?: unknown }) => (block.type === 'text' && typeof block.text === 'string' ? [block.text] : []))
      : [];

const listedNames = (block: string): string[] => block.split('\n\n')[0]!.split('\n').flatMap((line) => /^- ([A-Za-z0-9_-]+): /.exec(line)?.[1] ?? []);

/**
 * Every tool a request offers: those it defines, those listed by name in tool_search's description, and the MCP tools
 * Geno's notices in the conversation name.
 */
export function offeredTools(body: OfferingBody): string[] {
  const tools = body.tools ?? [];
  const deferred = listedNames(tools.find((tool) => tool.name === 'tool_search')?.description?.split('The tools:\n')[1] ?? '');
  const texts = (body.messages ?? []).flatMap((message) => textBlocks((message as { content?: unknown }).content));
  const announced = texts.flatMap((text) => text.split(MCP_TOOLS_HEADER).slice(1).flatMap(listedNames));
  return [...tools.map((tool) => tool.name), ...deferred, ...new Set(announced)];
}

let loads = 0;
/** A tool_search call that loads deferred tools, for a turn before their first call. */
export const loadTools = (...names: string[]): FakeToolUse => ({ id: `tu_load_${loads++}`, name: 'tool_search', input: { select: names } });

/** A text block at `index` that streams `text` in pieces of `chunk` characters; none for empty text, which a provider never sends. */
const textBlock = (index: number, text: string, chunk = text.length): SseEvent[] =>
  text === ''
    ? []
    : [
        { type: 'content_block_start', index, content_block: { type: 'text', text: '', citations: null } },
        ...Array.from({ length: Math.ceil(text.length / chunk) }, (_, i) => ({ type: 'content_block_delta', index, delta: { type: 'text_delta', text: text.slice(i * chunk, (i + 1) * chunk) } })),
        { type: 'content_block_stop', index },
      ];

/**
 * A Messages stream that says `text`, then asks for each tool use with its input streamed as JSON fragments.
 * `cutOff` stops at `max_tokens` halfway through the last tool use's input, as a provider does at the output limit.
 */
export function toolCall(text: string, uses: readonly FakeToolUse[], usage: CacheUsage, opts: { cutOff?: true } = {}): Reply {
  const said = textBlock(0, text);
  const blocks = uses.flatMap((use, i): SseEvent[] => {
    const index = i + (said.length === 0 ? 0 : 1);
    const json = use.rawJson ?? JSON.stringify(use.input);
    const half = Math.ceil(json.length / 2);
    const cut = opts.cutOff === true && i === uses.length - 1;
    return [
      { type: 'content_block_start', index, content_block: { type: 'tool_use', id: use.id, name: use.name, input: {}, caller: { type: 'direct' } } },
      { type: 'content_block_delta', index, delta: { type: 'input_json_delta', partial_json: json.slice(0, half) } },
      ...(cut ? [] : [{ type: 'content_block_delta', index, delta: { type: 'input_json_delta', partial_json: json.slice(half) } }]),
      { type: 'content_block_stop', index },
    ];
  });
  return {
    events: [
      messageStart(usage),
      ...said,
      ...blocks,
      {
        type: 'message_delta',
        delta: { stop_reason: opts.cutOff === true ? 'max_tokens' : 'tool_use', stop_sequence: null, stop_details: null },
        usage: { output_tokens: 30 },
      },
      { type: 'message_stop' },
    ],
  };
}

/** A subagent's last turn: its report call, which ends its run. */
export const handBack = (message: string, usage: CacheUsage, id = 'tu_report'): Reply => toolCall('', [{ id, name: 'report', input: { message } }], usage);

/** A thinking block's text and signature. */
export type Thinking = { readonly thought: string; readonly signature: string };

/**
 * A hand-built Messages stream: a thinking block, then the text, if any, in chunks of `chunk` characters. `thinking`
 * sets the thinking block, or leaves it out with `null`; by default it holds a placeholder that names the text's length.
 */
export function answer(text: string, usage: CacheUsage, opts: { stopReason?: string; chunk?: number; thinking?: Thinking | null } = {}): Reply {
  const thinking = opts.thinking === undefined ? { thought: `pondering ${text.length}`, signature: `sig-${text.length}` } : opts.thinking;
  const thought: SseEvent[] =
    thinking === null
      ? []
      : [
          { type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '', signature: '' } },
          { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: thinking.thought } },
          { type: 'content_block_delta', index: 0, delta: { type: 'signature_delta', signature: thinking.signature } },
          { type: 'content_block_stop', index: 0 },
        ];
  return {
    events: [
      {
        type: 'message_start',
        message: {
          id: 'msg_fake',
          type: 'message',
          role: 'assistant',
          model: 'anthropic/claude-opus-5.5',
          content: [],
          stop_reason: null,
          stop_sequence: null,
          stop_details: null,
          usage: {
            input_tokens: usage.input,
            cache_creation_input_tokens: usage.cacheWrite,
            cache_read_input_tokens: usage.cacheRead,
            output_tokens: 1,
          },
        },
      },
      ...thought,
      ...textBlock(thought.length === 0 ? 0 : 1, text, opts.chunk ?? 8),
      {
        type: 'message_delta',
        delta: { stop_reason: opts.stopReason ?? 'end_turn', stop_sequence: null, stop_details: null },
        usage: { output_tokens: 42 },
      },
      { type: 'message_stop' },
    ],
  };
}

const sseEvent = (event: SseEvent) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`;
const encode = (event: SseEvent) => new TextEncoder().encode(sseEvent(event));

/** A whole reply as one server-sent-events body, for a fake served over HTTP. */
export const sseBody = (reply: Reply): string => reply.events.map(sseEvent).join('');

function body(reply: Reply, signal: AbortSignal | null | undefined): ReadableStream<Uint8Array> {
  const events = reply.events.slice(0, reply.stallAfter ?? reply.dropAfter);
  let next = 0;
  return new ReadableStream({
    async pull(controller) {
      const event = events[next++];
      if (event !== undefined && reply.everyMs !== undefined) await new Promise((resolve) => setTimeout(resolve, reply.everyMs));
      if (event !== undefined) return controller.enqueue(encode(event));
      if (reply.dropAfter !== undefined) return controller.error(new TypeError('terminated', { cause: new Error('other side closed') }));
      if (reply.stallAfter === undefined) return controller.close();
      return new Promise<void>((resolve) => {
        const fail = () => {
          controller.error(new DOMException('aborted', 'AbortError'));
          resolve();
        };
        if (signal?.aborted) fail();
        else signal?.addEventListener('abort', fail, { once: true });
      });
    },
  });
}

/** The response a provider gives for `reply`; a stream that stalls waits on `signal`. */
export async function replyResponse(reply: Reply, signal: AbortSignal | null | undefined): Promise<Response> {
  if (reply.offline) throw refusedConnection();
  if (reply.hang) {
    await new Promise<void>((_, reject) => {
      const fail = () => reject(new DOMException('This operation was aborted', 'AbortError'));
      if (signal?.aborted) fail();
      else signal?.addEventListener('abort', fail, { once: true });
    });
  }
  if (reply.failure !== undefined) {
    const { status, body: json, headers } = reply.failure;
    return new Response(JSON.stringify(json), { status, headers: { 'content-type': 'application/json', ...headers } });
  }
  return new Response(body(reply, signal), {
    status: 200,
    headers: { 'content-type': 'text/event-stream' },
  });
}

/**
 * A fetch that serves replies in order and records every request it receives. A HEAD request is a reachability probe,
 * answered by `up` without taking a reply; it counts in `probes`.
 */
export function fakeTransport(replies: readonly Reply[], up: () => boolean = () => true) {
  const requests: RecordedRequest[] = [];
  const probes: number[] = [];
  const fetch: typeof globalThis.fetch = async (input, init) => {
    if (init?.method === 'HEAD') {
      probes.push(Date.now());
      if (!up()) throw refusedConnection();
      return new Response(null, { status: 404 });
    }
    const reply = replies[requests.length];
    requests.push({
      url: String(input),
      headers: new Headers(init?.headers),
      body: JSON.parse(String(init?.body)),
    });
    if (reply === undefined) throw new Error(`fake transport has no reply for request ${requests.length}`);
    return replyResponse(reply, init?.signal);
  };
  return { fetch, requests, probes };
}
