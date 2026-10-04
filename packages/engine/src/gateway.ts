import Anthropic, { AnthropicError, APIUserAbortError } from '@anthropic-ai/sdk';
import type { Message } from '@anthropic-ai/sdk/resources/messages/messages';
import {
  buildRequest,
  costOf,
  type AssistantTurn,
  type Session,
  type TokenUsage,
  type TurnErrorKind,
  type TurnEvent,
} from '@g-code/core';
import { EngineError } from './errors.js';

export type TurnInput = {
  readonly session: Session;
  readonly events: readonly TurnEvent[];
  readonly signal: AbortSignal;
  onText(delta: string): void;
};

export type TurnResult =
  | { readonly kind: 'answer'; readonly turn: AssistantTurn }
  | { readonly kind: 'error'; readonly error: TurnErrorKind; readonly message: string };

/** One model round trip. A wire format other than Anthropic Messages would be another implementation. */
export type Gateway = { turn(input: TurnInput): Promise<TurnResult> };

export const KEY_VARIABLE = 'OPENROUTER_API_KEY';
const OPENROUTER_ANTHROPIC_URL = 'https://openrouter.ai/api';

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

export function openRouterGateway(
  env: Readonly<Record<string, string | undefined>>,
  fetch?: typeof globalThis.fetch,
): Gateway {
  const key = env[KEY_VARIABLE];
  if (!key) throw new EngineError(`${KEY_VARIABLE} is not set; export your OpenRouter API key in it`);
  // apiKey: null stops the SDK from also sending an ANTHROPIC_API_KEY found in the environment.
  const client = new Anthropic({ baseURL: OPENROUTER_ANTHROPIC_URL, authToken: key, apiKey: null, fetch });

  return {
    async turn({ session, events, signal, onText }) {
      const started = performance.now();
      try {
        const stream = client.messages.stream(buildRequest(session, events), {
          signal,
          // OpenRouter routes requests with the same session id to the same provider, so the cache it wrote is hit.
          headers: { 'x-session-id': session.id },
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
