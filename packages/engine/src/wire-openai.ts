import { AnthropicError, APIConnectionError, APIError, APIUserAbortError } from '@anthropic-ai/sdk';
import { chatStream, toChatRequest, type ChatChunk } from '@g-code/core';
import { redactor, type Wire, type WireConfig } from './wire.js';

/** The headers that carry the key, as the row says; a local server with no key gets none. */
function authHeaders({ spec, values }: WireConfig): Record<string, string> {
  const key = values.apiKey;
  if (key === undefined || spec.key.kind !== 'header') return {};
  return { [spec.key.header]: spec.key.scheme === undefined ? key : `${spec.key.scheme} ${key}` };
}

const endpoint = (config: WireConfig, path: string): string => `${config.baseUrl!.replace(/\/+$/, '')}/${path}`;

async function send(config: WireConfig, path: string, init: RequestInit & { signal: AbortSignal }): Promise<Response> {
  const fetch = config.fetch ?? globalThis.fetch;
  let response: Response;
  try {
    response = await fetch(endpoint(config, path), { ...init, headers: { ...authHeaders(config), ...init.headers } });
  } catch (error) {
    if (init.signal.aborted) throw new APIUserAbortError();
    throw new APIConnectionError({ cause: error instanceof Error ? error : new Error(String(error)) });
  }
  if (!response.ok) {
    const text = await response.text().catch(() => '');
    let body: unknown;
    try {
      body = JSON.parse(text);
    } catch {
      body = undefined;
    }
    // OpenAI-style bodies are `{ error: { message } }`, some proxies answer with a bare array or plain text.
    const error = Array.isArray(body) ? body[0] : body;
    throw APIError.generate(response.status, (error ?? undefined) as object | undefined, text || response.statusText, response.headers);
  }
  return response;
}

/** The `data:` payloads of a server-sent-events body, one per event, up to `[DONE]`. */
async function* sseData(body: ReadableStream<Uint8Array>): AsyncGenerator<string> {
  const decoder = new TextDecoder();
  let buffer = '';
  let data: string[] = [];
  for await (const bytes of body) {
    buffer += decoder.decode(bytes, { stream: true });
    let newline: number;
    while ((newline = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, newline).replace(/\r$/, '');
      buffer = buffer.slice(newline + 1);
      if (line === '') {
        if (data.length > 0) yield data.join('\n');
        data = [];
      } else if (line.startsWith('data:')) {
        data.push(line.slice(5).replace(/^ /, ''));
      }
    }
  }
  if (data.length > 0) yield data.join('\n');
}

export function openaiWire(config: WireConfig): Wire {
  return {
    async stream(params, { signal, headers, onEvent }) {
      const response = await send(config, 'chat/completions', {
        method: 'POST',
        signal,
        headers: { 'content-type': 'application/json', accept: 'text/event-stream', ...headers },
        body: JSON.stringify(toChatRequest(params)),
      });
      const translator = chatStream();
      let finished = false;
      try {
        for await (const data of sseData(response.body!)) {
          if (data === '[DONE]') {
            finished = true;
            break;
          }
          const chunk = JSON.parse(data) as ChatChunk & { error?: { message?: string } };
          if (chunk.error !== undefined) throw APIError.generate(undefined, chunk.error, chunk.error.message, undefined);
          if (chunk.choices.some((choice) => choice.finish_reason)) finished = true;
          for (const event of translator.push(chunk)) onEvent(event);
        }
      } catch (error) {
        if (signal.aborted) throw new APIUserAbortError();
        if (error instanceof AnthropicError) throw error;
        throw new APIConnectionError({ cause: error instanceof Error ? error : new Error(String(error)) });
      }
      if (signal.aborted) throw new APIUserAbortError();
      if (!finished) throw new AnthropicError('stream ended without a finish reason');
      const { events, message } = translator.finish();
      for (const event of events) onEvent(event);
      return message;
    },

    async listModels(signal) {
      const response = await send(config, 'models', { method: 'GET', signal });
      const body = (await response.json()) as { data?: { id?: unknown }[] };
      return (body.data ?? []).map((model) => model.id).filter((id): id is string => typeof id === 'string').sort();
    },

    redact: redactor(config),
  };
}
