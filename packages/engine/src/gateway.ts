import Anthropic, { AnthropicError, APIUserAbortError } from '@anthropic-ai/sdk';
import type { Message, Tool } from '@anthropic-ai/sdk/resources/messages/messages';
import {
  buildRequest,
  costOf,
  PROVIDER_ENV,
  type ProviderName,
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
};

/** One model round trip. A wire format other than Anthropic Messages would be another implementation. */
export type Gateway = { turn(input: TurnInput): Promise<TurnResult> };

type Env = Readonly<Record<string, string | undefined>>;

/** Providers that speak the Anthropic Messages wire format. */
type Provider = {
  readonly baseUrl: (env: Env) => string;
  readonly defaultModel: string;
  readonly sessionHeaders: (session: Session) => Record<string, string>;
};

export const PROVIDER_TABLE: Readonly<Record<ProviderName, Provider>> = {
  openrouter: {
    baseUrl: () => 'https://openrouter.ai/api',
    defaultModel: 'anthropic/claude-opus-5.5',
    // OpenRouter routes requests with the same session id to the same provider, so the cache it wrote is hit.
    sessionHeaders: (session) => ({ 'x-session-id': session.id }),
  },
  modelstudio: {
    // The URL embeds the workspace id and region, and keys only work in their own region.
    baseUrl: (env) => required(env, PROVIDER_ENV.modelstudio.baseUrl, 'your Model Studio Anthropic endpoint'),
    defaultModel: 'qwen3.8-flash',
    sessionHeaders: () => ({}),
  },
};

function required(env: Env, variable: string, what: string): string {
  const value = env[variable];
  if (!value) throw new EngineError(`${variable} is not set; put ${what} in it`);
  return value;
}

const usageOf = ({ usage }: Message): TokenUsage => ({
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

export function gatewayFor(providerName: ProviderName, env: Env, fetch?: typeof globalThis.fetch): Gateway {
  const provider = PROVIDER_TABLE[providerName];
  const key = required(env, PROVIDER_ENV[providerName].key, `your ${providerName} API key`);
  // apiKey: null stops the SDK from also sending an ANTHROPIC_API_KEY found in the environment.
  const client = new Anthropic({ baseURL: provider.baseUrl(env), authToken: key, apiKey: null, fetch });

  return {
    async turn({ session, events, tools, system, signal, onText }) {
      const started = performance.now();
      try {
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
      } catch (error) {
        if (error instanceof APIUserAbortError || signal.aborted) {
          return { kind: 'error', error: 'abort', message: 'interrupted by the user' };
        }
        if (error instanceof AnthropicError) return { kind: 'error', error: 'transport', message: error.message };
        throw error;
      }
    },
  };
}
