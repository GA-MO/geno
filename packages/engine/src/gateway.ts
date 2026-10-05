import { setTimeout as sleep } from 'node:timers/promises';
import Anthropic, { AnthropicError, APIError, APIUserAbortError } from '@anthropic-ai/sdk';
import type { Message, Tool } from '@anthropic-ai/sdk/resources/messages/messages';
import {
  buildRequest,
  classifyModelError,
  costOf,
  PROVIDER_ENV,
  RETRY_POLICY,
  retryDelayMs,
  TURN_ERROR_OF,
  type ModelFailure,
  type ModelRetry,
  type ProviderName,
  type RetryPolicy,
  type Session,
  type TokenUsage,
  type TurnEvent,
  type TurnResult,
} from '@g-code/core';
import { EngineError } from './errors.js';

export type TurnInput = {
  readonly session: Session;
  readonly events: readonly TurnEvent[];
  readonly tools: readonly Tool[];
  /** Replaces the agent's system prompt, for callers such as the apply harness that are not the agent. */
  readonly system?: string;
  readonly signal: AbortSignal;
  onText(delta: string): void;
  /** A transient failure about to be retried; the wait starts once this settles. */
  onRetry(retry: ModelRetry): void | Promise<void>;
};

/** One model round trip. A wire format other than Anthropic Messages would be another implementation. */
export type Gateway = { turn(input: TurnInput): Promise<TurnResult> };

type Env = Readonly<Record<string, string | undefined>>;

/** Providers that speak the Anthropic Messages wire format. */
type Provider = {
  readonly baseUrl: (env: Env) => string;
  readonly sessionHeaders: (session: Session) => Record<string, string>;
};

export const PROVIDER_TABLE: Readonly<Record<ProviderName, Provider>> = {
  openrouter: {
    baseUrl: () => 'https://openrouter.ai/api',
    // OpenRouter routes requests with the same session id to the same provider, so the cache it wrote is hit.
    sessionHeaders: (session) => ({ 'x-session-id': session.id }),
  },
  modelstudio: {
    // The URL embeds the workspace id and region, and keys only work in their own region.
    baseUrl: (env) => required(env, PROVIDER_ENV.modelstudio.baseUrl, 'your Model Studio Anthropic endpoint'),
    sessionHeaders: () => ({}),
  },
};

function required(env: Env, variable: string, what: string): string {
  const value = env[variable];
  if (!value) throw new EngineError(`${variable} is not set; put ${what} in it`);
  return value;
}

export const usageOf = ({ usage }: Message): TokenUsage => ({
  input: usage.input_tokens,
  cacheRead: usage.cache_read_input_tokens ?? 0,
  cacheWrite: usage.cache_creation_input_tokens ?? 0,
  output: usage.output_tokens,
});

function refusalMessage(message: Message): string {
  const text = message.content.flatMap((block) => (block.type === 'text' ? [block.text] : [])).join('');
  const details = message.stop_details;
  return details?.explanation ?? (text || `the model refused${details?.category ? ` (${details.category})` : ''}`);
}

const ABORTED: TurnResult = { kind: 'error', error: 'abort', message: 'interrupted by the user' };

// The SDK keeps the transport's own error as the cause, and that is what names a reset or a refused connection.
export const messagesOf = (error: unknown): string[] =>
  error instanceof Error ? [error.message, ...messagesOf(error.cause)] : error === undefined ? [] : [String(error)];

const failureOf = (error: AnthropicError): ModelFailure => ({
  status: error instanceof APIError ? error.status : undefined,
  message: messagesOf(error).join(': '),
});

function retryAfterMs(error: AnthropicError): number | undefined {
  const headers = error instanceof APIError ? error.headers : undefined;
  const ms = Number.parseFloat(headers?.get('retry-after-ms') ?? '');
  if (ms >= 0) return ms;
  const raw = headers?.get('retry-after');
  if (!raw) return undefined;
  const seconds = Number(raw);
  const wait = Number.isNaN(seconds) ? Date.parse(raw) - Date.now() : seconds * 1000;
  return Number.isNaN(wait) ? undefined : Math.max(0, Math.round(wait));
}

/** A Messages client for the provider. Throws an EngineError when its key or endpoint is not set. */
export function clientFor(providerName: ProviderName, env: Env, fetch?: typeof globalThis.fetch): Anthropic {
  const key = required(env, PROVIDER_ENV[providerName].key, `your ${providerName} API key`);
  // apiKey: null stops the SDK from also sending an ANTHROPIC_API_KEY found in the environment. Retries are
  // ours: the SDK's would retry an exhausted quota, unseen, and never a stream that fails after its headers.
  return new Anthropic({ baseURL: PROVIDER_TABLE[providerName].baseUrl(env), authToken: key, apiKey: null, maxRetries: 0, fetch });
}

export function gatewayFor(
  providerName: ProviderName,
  env: Env,
  fetch?: typeof globalThis.fetch,
  retry: RetryPolicy = RETRY_POLICY,
): Gateway {
  const provider = PROVIDER_TABLE[providerName];
  const client = clientFor(providerName, env, fetch);

  async function call({ session, events, tools, system, signal, onText }: TurnInput): Promise<TurnResult> {
    const started = performance.now();
    const stream = client.messages.stream(buildRequest(session, events, tools, system), {
      signal,
      headers: provider.sessionHeaders(session),
    });
    stream.on('text', onText);
    const message = await stream.finalMessage();
    if (message.stop_reason === 'refusal') {
      return { kind: 'error', error: 'refusal', message: refusalMessage(message) };
    }
    const usage = usageOf(message);
    return {
      kind: 'answer',
      turn: {
        content: message.content,
        stopReason: message.stop_reason,
        usage,
        costUsd: costOf(session.model, usage),
        latencyMs: Math.round(performance.now() - started),
        model: message.model,
      },
    };
  }

  return {
    async turn(input) {
      const { signal } = input;
      for (let attempt = 1; ; attempt++) {
        try {
          return await call(input);
        } catch (error) {
          if (error instanceof APIUserAbortError || signal.aborted) return ABORTED;
          if (!(error instanceof AnthropicError)) throw error;
          const failure = failureOf(error);
          const kind = classifyModelError(failure);
          const delayMs = kind === 'transient' ? retryDelayMs(retry, attempt, retryAfterMs(error)) : undefined;
          if (delayMs === undefined) return { kind: 'error', error: TURN_ERROR_OF[kind], message: failure.message };
          await input.onRetry({ attempt, delayMs, message: failure.message });
          try {
            await sleep(delayMs, undefined, { signal });
          } catch (sleepError) {
            if (signal.aborted) return ABORTED;
            throw sleepError;
          }
        }
      }
    },
  };
}
