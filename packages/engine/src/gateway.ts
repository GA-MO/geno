import { setTimeout as sleep } from 'node:timers/promises';
import { AnthropicError, APIError, APIUserAbortError } from '@anthropic-ai/sdk';
import type { Message, MessageStreamEvent, Tool } from '@anthropic-ai/sdk/resources/messages/messages';
import {
  buildRequest,
  classifyModelError,
  costOf,
  RETRY_POLICY,
  retryDelayMs,
  specOf,
  TURN_ERROR_OF,
  type ModelFailure,
  type ModelRetry,
  type ProviderName,
  type RetryPolicy,
  type Session,
  type StoredAttachments,
  type StreamMarks,
  type TokenUsage,
  type TurnEvent,
  type TurnResult,
} from '@g-code/core';
import { sharedSlots, type ModelSlots } from './model-slots.js';
import { wireFor } from './wire.js';

export type TurnInput = {
  readonly session: Session;
  readonly events: readonly TurnEvent[];
  readonly tools: readonly Tool[];
  /** Replaces the agent's system prompt, for callers such as the apply harness that are not the agent. */
  readonly system?: string;
  /** The bytes of the attachments the events reference; none when the conversation has no attachments. */
  readonly stored?: StoredAttachments;
  readonly signal: AbortSignal;
  onText(delta: string): void;
  /** A tool call as the model writes it, once when it starts and again with each piece of its input. */
  onToolInput?(draft: ToolInputDraft): void;
  /** A transient failure about to be retried; the wait starts once this settles. */
  onRetry(retry: ModelRetry): void | Promise<void>;
  /** When the attempt that produced the result reached each point of its stream; called once, before the result returns. */
  onMarks?(marks: StreamMarks): void;
};

/** A tool call still streaming: its id, its name and its input JSON so far. */
export type ToolInputDraft = { readonly id: string; readonly name: string; readonly json: string };

/** One model round trip, through the provider's adapter. */
export type Gateway = { turn(input: TurnInput): Promise<TurnResult> };

type Env = Readonly<Record<string, string | undefined>>;

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

const THINKING_BLOCKS: ReadonlySet<string> = new Set(['thinking', 'redacted_thinking']);

/** Notes when one attempt's stream sent its first content, its first answer content after any thinking, and its last. */
function streamClock() {
  const requestAt = Date.now();
  const thinkingBlocks = new Set<number>();
  let firstTokenAt: number | null = null;
  let firstAnswerAt: number | null = null;
  let lastTokenAt: number | null = null;
  return {
    observe(event: MessageStreamEvent) {
      if (event.type === 'content_block_start' && THINKING_BLOCKS.has(event.content_block.type)) thinkingBlocks.add(event.index);
      if (event.type !== 'content_block_start' && event.type !== 'content_block_delta') return;
      const now = Date.now();
      firstTokenAt ??= now;
      if (!thinkingBlocks.has(event.index)) firstAnswerAt ??= now;
      lastTokenAt = now;
    },
    marks: (): StreamMarks => ({ requestAt, firstTokenAt, firstAnswerAt, lastTokenAt, endAt: Date.now() }),
  };
}

type StreamClock = ReturnType<typeof streamClock>;

// The SDK keeps the transport's own error as the cause, and that is what names a reset or a refused connection.
export const messagesOf = (error: unknown): string[] =>
  error instanceof Error ? [error.message, ...messagesOf(error.cause)] : error === undefined ? [] : [String(error)];

const failureOf = (error: AnthropicError, redact: (text: string) => string): ModelFailure => ({
  status: error instanceof APIError ? error.status : undefined,
  message: redact(messagesOf(error).join(': ')),
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

export function gatewayFor(
  providerName: ProviderName,
  env: Env,
  fetch?: typeof globalThis.fetch,
  retry: RetryPolicy = RETRY_POLICY,
  slots: ModelSlots = sharedSlots(providerName, env),
): Gateway {
  const wire = wireFor(providerName, env, fetch);
  const sessionHeader = specOf(providerName).sessionHeader;

  async function call({ session, events, tools, system, stored, signal, onText, onToolInput }: TurnInput, clock: StreamClock): Promise<TurnResult> {
    const started = performance.now();
    const drafts = new Map<number, ToolInputDraft>();
    const draft = (index: number, next: ToolInputDraft) => {
      drafts.set(index, next);
      onToolInput?.(next);
    };
    const message = await wire.stream(buildRequest(session, events, tools, system, stored), {
      signal,
      headers: sessionHeader === undefined ? {} : { [sessionHeader]: session.id },
      onEvent: (event) => {
        clock.observe(event);
        if (event.type === 'content_block_delta' && event.delta.type === 'text_delta') onText(event.delta.text);
        if (event.type === 'content_block_start' && event.content_block.type === 'tool_use') draft(event.index, { id: event.content_block.id, name: event.content_block.name, json: '' });
        if (event.type === 'content_block_delta' && event.delta.type === 'input_json_delta') {
          const was = drafts.get(event.index);
          if (was !== undefined) draft(event.index, { ...was, json: was.json + event.delta.partial_json });
        }
      },
    });
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
        costUsd: costOf(session.provider, session.model, usage),
        latencyMs: Math.round(performance.now() - started),
        model: message.model,
      },
    };
  }

  return {
    async turn(input) {
      const { signal } = input;
      for (let attempt = 1; ; attempt++) {
        // The clock starts once the call has its slot, so a queued call does not read as a slow first token.
        let clock = streamClock();
        const settled = (result: TurnResult): TurnResult => {
          input.onMarks?.(clock.marks());
          return result;
        };
        try {
          return settled(
            await slots.run(() => {
              clock = streamClock();
              return call(input, clock);
            }, signal),
          );
        } catch (error) {
          if (error instanceof APIUserAbortError || signal.aborted) return settled(ABORTED);
          if (!(error instanceof AnthropicError)) throw error;
          const failure = failureOf(error, wire.redact);
          const kind = classifyModelError(failure);
          const delayMs = kind === 'transient' ? retryDelayMs(retry, attempt, retryAfterMs(error)) : undefined;
          if (delayMs !== undefined && error instanceof APIError && error.status === 429) slots.pause(delayMs);
          if (delayMs === undefined) return settled({ kind: 'error', error: TURN_ERROR_OF[kind], message: failure.message });
          await input.onRetry({ attempt, delayMs, message: failure.message });
          try {
            await sleep(delayMs, undefined, { signal });
          } catch (sleepError) {
            if (signal.aborted) return settled(ABORTED);
            throw sleepError;
          }
        }
      }
    },
  };
}
