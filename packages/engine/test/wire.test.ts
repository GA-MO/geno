import { describe, expect, it } from 'vitest';
import { asSessionId, type ProviderName, type Session, type TurnEvent, type TurnResult } from '@g-code/core';
import { gatewayFor } from '../src/gateway.js';
import { wireFor } from '../src/wire.js';
import { chatAnswer, chatFailure, chatSse, chatToolCall, type ChatReply } from './fake-openai.js';
import { answer, fakeTransport } from './fake-transport.js';

const usage = { input: 10, cacheRead: 0, cacheWrite: 0 };
const events = (session: Session): TurnEvent[] => [
  { kind: 'session-start', session },
  { kind: 'user', seq: 1, at: session.createdAt, content: 'hi' },
];
const sessionOn = (provider: ProviderName, model: string): Session => ({
  id: asSessionId('sess-1'),
  createdAt: '2026-10-06T00:00:00.000Z',
  workspace: '/tmp/ws',
  provider,
  model,
  effort: 'medium',
});

type Seen = { readonly url: string; readonly method: string; readonly headers: Headers; readonly body: any };

/** A fetch serving Chat Completions replies in order, recording each request. */
function chatTransport(replies: readonly ChatReply[]) {
  const requests: Seen[] = [];
  const fetch: typeof globalThis.fetch = async (input, init) => {
    const reply = replies[requests.length];
    requests.push({ url: String(input), method: init?.method ?? 'GET', headers: new Headers(init?.headers), body: init?.body === undefined ? undefined : JSON.parse(String(init.body)) });
    if (reply === undefined) throw new Error('no reply');
    if (reply.failure !== undefined) {
      return new Response(JSON.stringify(reply.failure.body), { status: reply.failure.status, headers: { 'content-type': 'application/json', ...reply.failure.headers } });
    }
    return new Response(chatSse(reply), { status: 200, headers: { 'content-type': 'text/event-stream' } });
  };
  return { fetch, requests };
}

async function turn(provider: ProviderName, model: string, env: Record<string, string>, fetch: typeof globalThis.fetch) {
  const deltas: string[] = [];
  const retries: string[] = [];
  const session = sessionOn(provider, model);
  const result: TurnResult = await gatewayFor(provider, env, fetch, { maxRetries: 2, baseDelayMs: 1, maxDelayMs: 5 }).turn({
    session,
    events: events(session),
    tools: [{ name: 'read', description: 'Read a file', input_schema: { type: 'object', properties: { path: { type: 'string' } } } }],
    signal: new AbortController().signal,
    onText: (d) => deltas.push(d),
    onRetry: (r) => void retries.push(r.message),
  });
  return { result, deltas, retries };
}

const OPENAI_KEY = 'sk-openai-canary-0123456789';

describe('the OpenAI-compatible adapter', () => {
  it('streams text and tool calls through the gateway, with the Bearer key and usage mapped', async () => {
    const transport = chatTransport([chatToolCall('Reading it.', [{ id: 'call_1', name: 'read', input: { path: 'a.ts' } }], { prompt: 500, completion: 20, cached: 400 })]);
    const { result, deltas } = await turn('openai', 'gpt-fake', { OPENAI_API_KEY: OPENAI_KEY, ANTHROPIC_API_KEY: 'must-not-be-sent' }, transport.fetch);

    expect(deltas.join('')).toBe('Reading it.');
    expect(result).toMatchObject({
      kind: 'answer',
      turn: {
        content: [{ type: 'text', text: 'Reading it.' }, { type: 'tool_use', id: 'call_1', name: 'read', input: { path: 'a.ts' } }],
        stopReason: 'tool_use',
        usage: { input: 100, cacheRead: 400, cacheWrite: 0, output: 20 },
        costUsd: null,
        model: 'gpt-fake',
      },
    });
    const [request] = transport.requests;
    expect(request?.url).toBe('https://api.openai.com/v1/chat/completions');
    expect(request?.headers.get('authorization')).toBe(`Bearer ${OPENAI_KEY}`);
    expect(request?.headers.get('x-api-key')).toBeNull();
    expect(request?.body).toMatchObject({ model: 'gpt-fake', stream: true, tools: [{ type: 'function', function: { name: 'read' } }] });
    expect(request?.body.messages[0].role).toBe('system');
  });

  it('sends Azure’s key as api-key to the endpoint the user gave, and needs that endpoint', async () => {
    const transport = chatTransport([chatAnswer('Hi.', { prompt: 5, completion: 1, cached: 0 })]);
    const env = { AZURE_OPENAI_API_KEY: 'azure-key-0123456789', GCODE_AZURE_OPENAI_BASE_URL: 'https://res.openai.azure.com/openai/v1/' };
    await turn('azure-openai', 'my-deployment', env, transport.fetch);
    expect(transport.requests[0]?.url).toBe('https://res.openai.azure.com/openai/v1/chat/completions');
    expect(transport.requests[0]?.headers.get('api-key')).toBe('azure-key-0123456789');
    expect(transport.requests[0]?.headers.get('authorization')).toBeNull();
    expect(() => wireFor('azure-openai', { AZURE_OPENAI_API_KEY: 'k' })).toThrow('GCODE_AZURE_OPENAI_BASE_URL is not set');
  });

  it('talks to a local Ollama with no key at all', async () => {
    const transport = chatTransport([chatAnswer('Local.', { prompt: 5, completion: 1, cached: 0 })]);
    const { result } = await turn('ollama', 'qwen3:8b', {}, transport.fetch);
    expect(result.kind).toBe('answer');
    expect(transport.requests[0]?.url).toBe('http://127.0.0.1:11434/v1/chat/completions');
    expect(transport.requests[0]?.headers.get('authorization')).toBeNull();
  });

  it('retries a 429 after its retry-after, then answers', async () => {
    const transport = chatTransport([
      chatFailure(429, { error: { message: 'Rate limit reached', type: 'rate_limit_error' } }, { 'retry-after-ms': '1' }),
      chatAnswer('Second try.', { prompt: 5, completion: 2, cached: 0 }),
    ]);
    const { result, retries } = await turn('groq', 'llama-fake', { GROQ_API_KEY: 'gsk-0123456789' }, transport.fetch);
    expect(retries).toHaveLength(1);
    expect(retries[0]).toMatch(/Rate limit reached/);
    expect(result).toMatchObject({ kind: 'answer', turn: { content: [{ type: 'thinking' }, { type: 'text', text: 'Second try.' }] } });
  });

  it('cuts the key out of an error that echoes it', async () => {
    const transport = chatTransport([chatFailure(401, { error: { message: `Incorrect API key provided: ${OPENAI_KEY}`, type: 'invalid_request_error' } })]);
    const { result } = await turn('openai', 'gpt-fake', { OPENAI_API_KEY: OPENAI_KEY }, transport.fetch);
    expect(result.kind).toBe('error');
    const message = result.kind === 'error' ? result.message : '';
    expect(message).toContain('Incorrect API key provided: [redacted]');
    expect(message).not.toContain(OPENAI_KEY);
  });

  it('retries a stream that drops before it finishes', async () => {
    const cut: ChatReply = { chunks: chatAnswer('never finished', { prompt: 1, completion: 1, cached: 0 }).chunks.slice(0, 2) };
    let calls = 0;
    const fetch: typeof globalThis.fetch = async () => {
      calls++;
      if (calls === 1) {
        const body = new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(new TextEncoder().encode(chatSse(cut).replace('data: [DONE]\n\n', '')));
            controller.error(new TypeError('terminated', { cause: new Error('other side closed') }));
          },
        });
        return new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } });
      }
      return new Response(chatSse(chatAnswer('Whole.', { prompt: 1, completion: 1, cached: 0 })), { status: 200 });
    };
    const { result, retries } = await turn('deepseek', 'deepseek-fake', { DEEPSEEK_API_KEY: 'sk-ds-0123456789' }, fetch);
    expect(retries[0]).toMatch(/other side closed/);
    expect(result).toMatchObject({ kind: 'answer', turn: { content: [{ type: 'thinking' }, { type: 'text', text: 'Whole.' }] } });
  });

  it('lists models from /models', async () => {
    const fetch: typeof globalThis.fetch = async (input) => {
      expect(String(input)).toBe('https://api.mistral.ai/v1/models');
      return new Response(JSON.stringify({ data: [{ id: 'mistral-b' }, { id: 'mistral-a' }] }), { status: 200 });
    };
    expect(await wireFor('mistral', { MISTRAL_API_KEY: 'mk-0123456789' }, fetch).listModels(new AbortController().signal)).toEqual(['mistral-a', 'mistral-b']);
  });
});

describe('the Anthropic-format adapter', () => {
  it('sends Anthropic’s own key as x-api-key, never as a Bearer token', async () => {
    const transport = fakeTransport([answer('Hi.', usage)]);
    const { result } = await turn('anthropic', 'claude-opus-5-5', { ANTHROPIC_API_KEY: 'sk-ant-0123456789' }, transport.fetch);
    expect(result.kind).toBe('answer');
    expect(transport.requests[0]?.url).toBe('https://api.anthropic.com/v1/messages');
    expect(transport.requests[0]?.headers.get('x-api-key')).toBe('sk-ant-0123456789');
    expect(transport.requests[0]?.headers.get('authorization')).toBeNull();
  });

  it('signs Bedrock requests with SigV4 for the region, through Anthropic’s Bedrock client', async () => {
    const transport = fakeTransport([answer('From Bedrock.', usage)]);
    const env = { AWS_REGION: 'us-east-1', AWS_ACCESS_KEY_ID: 'AKIAFAKE0123456789', AWS_SECRET_ACCESS_KEY: 'fake-secret-0123456789' };
    const { result } = await turn('bedrock', 'anthropic.claude-opus-5-5', env, transport.fetch);
    expect(result).toMatchObject({ kind: 'answer', turn: { content: [{ type: 'thinking' }, { type: 'text', text: 'From Bedrock.' }] } });
    const [request] = transport.requests;
    expect(request?.url).toBe('https://bedrock-mantle.us-east-1.api.aws/anthropic/v1/messages');
    expect(request?.headers.get('authorization')).toMatch(/^AWS4-HMAC-SHA256 Credential=AKIAFAKE0123456789\/\d{8}\/us-east-1\/bedrock-mantle\/aws4_request/);
    expect(JSON.stringify([...request!.headers])).not.toContain('fake-secret-0123456789');
    expect(request?.body).toMatchObject({ model: 'anthropic.claude-opus-5-5' });
    expect(() => wireFor('bedrock', {})).toThrow('AWS_REGION is not set');
  });

  it('sends Vertex requests to the project and region, with the access token, through Anthropic’s Vertex client', async () => {
    const transport = fakeTransport([answer('From Vertex.', usage)]);
    const env = { ANTHROPIC_VERTEX_PROJECT_ID: 'my-project', CLOUD_ML_REGION: 'us-east5', GCODE_VERTEX_ACCESS_TOKEN: 'ya29.fake-token-0123456789' };
    const { result } = await turn('vertex', 'claude-opus-5-5', env, transport.fetch);
    expect(result.kind).toBe('answer');
    const [request] = transport.requests;
    expect(request?.url).toBe('https://us-east5-aiplatform.googleapis.com/v1/projects/my-project/locations/us-east5/publishers/anthropic/models/claude-opus-5-5:streamRawPredict');
    expect(request?.headers.get('authorization')).toBe('Bearer ya29.fake-token-0123456789');
    expect(request?.body).toMatchObject({ anthropic_version: 'vertex-2023-10-16' });
    expect(() => wireFor('vertex', { CLOUD_ML_REGION: 'global' })).toThrow('ANTHROPIC_VERTEX_PROJECT_ID is not set');
  });
});
