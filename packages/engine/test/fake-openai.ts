import { createServer, type IncomingMessage } from 'node:http';
import type { AddressInfo } from 'node:net';

/** One streamed Chat Completions answer, as the chunks an OpenAI-compatible server sends. */
export type ChatReply = {
  readonly chunks: readonly Record<string, unknown>[];
  /** Answer with this HTTP error instead of a stream. */
  readonly failure?: { readonly status: number; readonly body: unknown; readonly headers?: Record<string, string> };
};

export type ChatUsageFake = { readonly prompt: number; readonly completion: number; readonly cached: number };

const chunk = (delta: Record<string, unknown>, finish: string | null = null) => ({
  id: 'chatcmpl-fake',
  object: 'chat.completion.chunk',
  model: 'gpt-fake',
  choices: [{ index: 0, delta, finish_reason: finish }],
});

const usageChunk = (usage: ChatUsageFake) => ({
  id: 'chatcmpl-fake',
  object: 'chat.completion.chunk',
  model: 'gpt-fake',
  choices: [],
  usage: { prompt_tokens: usage.prompt, completion_tokens: usage.completion, prompt_tokens_details: { cached_tokens: usage.cached } },
});

const pieces = (text: string, size = 6): string[] => Array.from({ length: Math.ceil(text.length / size) }, (_, i) => text.slice(i * size, (i + 1) * size));

/** Some reasoning, then `text` in pieces, then the usage chunk. */
export function chatAnswer(text: string, usage: ChatUsageFake): ChatReply {
  return {
    chunks: [
      chunk({ role: 'assistant', reasoning_content: 'Thinking it over.' }),
      ...pieces(text).map((piece) => chunk({ content: piece })),
      chunk({}, 'stop'),
      usageChunk(usage),
    ],
  };
}

export type FakeCall = { readonly id: string; readonly name: string; readonly input: unknown };

/** `text`, then each call with its arguments streamed in two halves. */
export function chatToolCall(text: string, calls: readonly FakeCall[], usage: ChatUsageFake): ChatReply {
  return {
    chunks: [
      chunk({ role: 'assistant', content: text }),
      ...calls.flatMap((call, index) => {
        const json = JSON.stringify(call.input);
        const half = Math.ceil(json.length / 2);
        return [
          chunk({ tool_calls: [{ index, id: call.id, type: 'function', function: { name: call.name, arguments: json.slice(0, half) } }] }),
          chunk({ tool_calls: [{ index, function: { arguments: json.slice(half) } }] }),
        ];
      }),
      chunk({}, 'tool_calls'),
      usageChunk(usage),
    ],
  };
}

export const chatFailure = (status: number, body: unknown, headers: Record<string, string> = {}): ChatReply => ({ chunks: [], failure: { status, body, headers } });

export const chatSse = (reply: ChatReply): string => `${reply.chunks.map((c) => `data: ${JSON.stringify(c)}\n\n`).join('')}data: [DONE]\n\n`;

export type SeenRequest = { readonly method: string; readonly path: string; readonly headers: IncomingMessage['headers']; readonly body: any };

async function bodyOf(req: IncomingMessage): Promise<string> {
  let body = '';
  for await (const piece of req) body += piece;
  return body;
}

/**
 * An OpenAI-compatible server on 127.0.0.1: chat completions answer `replies` in order, and `/v1/models` lists
 * `models`. Every request is recorded.
 */
export async function fakeOpenAiServer(replies: readonly ChatReply[], models: readonly string[] = ['gpt-fake', 'gpt-fake-mini']) {
  const requests: SeenRequest[] = [];
  let chats = 0;
  const server = createServer((req, res) => {
    void (async () => {
      const text = await bodyOf(req);
      const path = req.url?.split('?')[0] ?? '';
      requests.push({ method: req.method ?? '', path, headers: req.headers, body: text === '' ? undefined : JSON.parse(text) });
      if (req.method === 'GET' && path === '/v1/models') {
        res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ object: 'list', data: models.map((id) => ({ id, object: 'model' })) }));
        return;
      }
      if (req.method !== 'POST' || path !== '/v1/chat/completions') return void res.writeHead(404).end();
      const reply = replies[chats++];
      if (reply === undefined) return void res.writeHead(500).end(`no reply for chat ${chats - 1}`);
      if (reply.failure !== undefined) {
        res.writeHead(reply.failure.status, { 'content-type': 'application/json', ...reply.failure.headers }).end(JSON.stringify(reply.failure.body));
        return;
      }
      res.writeHead(200, { 'content-type': 'text/event-stream' }).end(chatSse(reply));
    })();
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`;
  return {
    url,
    requests,
    chats: () => requests.filter((r) => r.path === '/v1/chat/completions'),
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}
