type SseEvent = { readonly type: string } & Record<string, unknown>;

export type Reply = {
  readonly events: readonly SseEvent[];
  /** Emit this many events, then stall until the request is aborted. */
  readonly stallAfter?: number;
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

export type FakeToolUse = { readonly id: string; readonly name: string; readonly input: unknown };

/** Every tool a request offers: those it defines, and those listed by name in tool_search's description. */
export function offeredTools(body: { readonly tools?: readonly { readonly name: string; readonly description?: string }[] }): string[] {
  const tools = body.tools ?? [];
  const block = tools.find((tool) => tool.name === 'tool_search')?.description?.split('The tools:\n')[1] ?? '';
  const deferred = block.split('\n').flatMap((line) => /^- ([A-Za-z0-9_-]+): /.exec(line)?.[1] ?? []);
  return [...tools.map((tool) => tool.name), ...deferred];
}

let loads = 0;
/** A tool_search call that loads deferred tools, for a turn before their first call. */
export const loadTools = (...names: string[]): FakeToolUse => ({ id: `tu_load_${loads++}`, name: 'tool_search', input: { select: names } });

/**
 * A Messages stream that says `text`, then asks for each tool use with its input streamed as JSON fragments.
 * `cutOff` stops at `max_tokens` halfway through the last tool use's input, as a provider does at the output limit.
 */
export function toolCall(text: string, uses: readonly FakeToolUse[], usage: CacheUsage, opts: { cutOff?: true } = {}): Reply {
  const blocks = uses.flatMap((use, i): SseEvent[] => {
    const index = i + 1;
    const json = JSON.stringify(use.input);
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
      { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '', citations: null } },
      { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } },
      { type: 'content_block_stop', index: 0 },
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

/** A hand-built Messages stream: a thinking block, then the text in chunks of `chunk` characters. */
export function answer(text: string, usage: CacheUsage, opts: { stopReason?: string; chunk?: number } = {}): Reply {
  const chunk = opts.chunk ?? 8;
  const deltas: SseEvent[] = [];
  for (let i = 0; i < text.length; i += chunk) {
    deltas.push({ type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: text.slice(i, i + chunk) } });
  }
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
      { type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '', signature: '' } },
      { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: `pondering ${text.length}` } },
      { type: 'content_block_delta', index: 0, delta: { type: 'signature_delta', signature: `sig-${text.length}` } },
      { type: 'content_block_stop', index: 0 },
      { type: 'content_block_start', index: 1, content_block: { type: 'text', text: '', citations: null } },
      ...deltas,
      { type: 'content_block_stop', index: 1 },
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
    pull(controller) {
      const event = events[next++];
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
    if (reply.offline) throw refusedConnection();
    if (reply.failure !== undefined) {
      const { status, body: json, headers } = reply.failure;
      return new Response(JSON.stringify(json), { status, headers: { 'content-type': 'application/json', ...headers } });
    }
    return new Response(body(reply, init?.signal), {
      status: 200,
      headers: { 'content-type': 'text/event-stream' },
    });
  };
  return { fetch, requests, probes };
}
