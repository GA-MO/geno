import { setTimeout as sleep } from 'node:timers/promises';
import { AnthropicError, APIError, APIUserAbortError } from '@anthropic-ai/sdk';
import type { Message, MessageStreamEvent, MessageStreamParams, Tool } from '@anthropic-ai/sdk/resources/messages/messages';
import {
  buildRequest,
  classifyFailure,
  costOf,
  planWait,
  requestRuns,
  RETRY_POLICY,
  retryDelayMs,
  specOf,
  TURN_ERROR_OF,
  type CallProgress,
  type ModelFailure,
  type ModelRetry,
  type ProviderName,
  type ResumeAfterLimit,
  type RetryPolicy,
  type WaitKind,
  type Waiting,
  type WaitPolicy,
  type Session,
  type StoredAttachments,
  type StreamMarks,
  type TokenUsage,
  type TurnEvent,
  type TurnResult,
} from '@g-code/core';
import { sharedSlots, type ModelSlots } from './model-slots.js';
import { StreamStalled, streamLimitsOf, watchStream, type StreamLimits } from './stream-watch.js';
import { nap, resumeAfterLimitOf, waitPolicyOf, type Wake } from './waits.js';
import { wireFor } from './wire.js';

export type TurnInput = {
  readonly session: Session;
  readonly events: readonly TurnEvent[];
  readonly tools: readonly Tool[];
  /** Replaces the agent's system prompt, for callers such as the apply harness that are not the agent. */
  readonly system?: string;
  /** The one tool the model must call. */
  readonly forced?: string | undefined;
  /** The bytes of the attachments the events reference; none when the conversation has no attachments. */
  readonly stored?: StoredAttachments;
  readonly signal: AbortSignal;
  onText(delta: string): void;
  /** A tool call as the model writes it, once when it starts and again with each piece of its input. */
  onToolInput?(draft: ToolInputDraft): void;
  /** A transient failure about to be retried; the wait starts once this settles. */
  onRetry(retry: ModelRetry): void | Promise<void>;
  /** The call waits offline or for a rate limit, or its next try moved; null once the wait is over. The wait starts once this settles. */
  onWait?(wait: Waiting | null): void | Promise<void>;
  /** The wait the session's log ended in, left by an engine that stopped; the call waits it out before its first try. */
  readonly waiting?: Waiting | undefined;
  /** Retry now: cuts a wait short. */
  readonly wake?: Wake | undefined;
  /** Each try's progress as it streams: once as it goes out, then a few times a second while bytes arrive. */
  onProgress?(progress: CallProgress): void;
  /** When the attempt that produced the result reached each point of its stream; called once, before the result returns. */
  onMarks?(marks: StreamMarks): void;
  /** Keeps the request's snapshot before it goes out, and names it, for the turn to record. */
  snapshot?(request: MessageStreamParams): Promise<string>;
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
  let streamed = false;
  let firstTokenAt: number | null = null;
  let firstAnswerAt: number | null = null;
  let lastTokenAt: number | null = null;
  return {
    answered() {
      streamed = true;
    },
    observe(event: MessageStreamEvent) {
      streamed = true;
      if (event.type === 'content_block_start' && THINKING_BLOCKS.has(event.content_block.type)) thinkingBlocks.add(event.index);
      if (event.type !== 'content_block_start' && event.type !== 'content_block_delta') return;
      const now = Date.now();
      firstTokenAt ??= now;
      if (!thinkingBlocks.has(event.index)) firstAnswerAt ??= now;
      lastTokenAt = now;
    },
    marks: (): StreamMarks => ({ requestAt, firstTokenAt, firstAnswerAt, lastTokenAt, endAt: Date.now() }),
    streamed: () => streamed,
  };
}

type StreamClock = ReturnType<typeof streamClock>;

// The SDK keeps the transport's own error as the cause, and that is what names a reset or a refused connection.
export const messagesOf = (error: unknown): string[] =>
  error instanceof Error ? [error.message, ...messagesOf(error.cause)] : error === undefined ? [] : [String(error)];

const failureOf = (error: AnthropicError, redact: (text: string) => string, streamed: boolean): ModelFailure => ({
  status: error instanceof APIError ? error.status : undefined,
  message: redact(messagesOf(error).join(': ')),
  streamed,
  ...(error instanceof APIError && error.headers !== undefined ? { headers: Object.fromEntries(error.headers) } : {}),
  ...(error instanceof APIError ? { body: error.error } : {}),
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

/** How a gateway waits: its schedules, the limit setting, and the jitter source, which tests fix. */
export type WaitOptions = { readonly policy: WaitPolicy; readonly resume: ResumeAfterLimit; readonly random: () => number };

export const waitOptionsOf = (env: Env): WaitOptions => ({ policy: waitPolicyOf(env), resume: resumeAfterLimitOf(env), random: Math.random });

// Claude Code retries a call that got no response once, not out of its whole budget (its StreamNoResponseError).
const STALL_RETRIES = 1;

type Held = { readonly kind: 'go' } | { readonly kind: 'aborted' } | { readonly kind: 'give-up'; readonly message: string };

export function gatewayFor(
  providerName: ProviderName,
  env: Env,
  fetch?: typeof globalThis.fetch,
  retry: RetryPolicy = RETRY_POLICY,
  slots: ModelSlots = sharedSlots(providerName, env),
  waits: WaitOptions = waitOptionsOf(env),
  limits: StreamLimits = streamLimitsOf(env),
): Gateway {
  const wire = wireFor(providerName, env, fetch);
  const { sessionHeader, adapter } = specOf(providerName);

  // A try whose response goes silent past its limit is aborted and thrown as StreamStalled.
  async function call({ session, events, tools, system, stored, forced, signal, onText, onToolInput, onProgress, snapshot }: TurnInput, clock: StreamClock): Promise<TurnResult> {
    const started = performance.now();
    const drafts = new Map<number, ToolInputDraft>();
    const draft = (index: number, next: ToolInputDraft) => {
      drafts.set(index, next);
      onToolInput?.(next);
    };
    const request = buildRequest(session, events, tools, system, stored, forced);
    const kept = await snapshot?.(request);
    const watch = watchStream(limits, onProgress ?? (() => {}));
    const message = await wire.stream(request, {
      signal: AbortSignal.any([signal, watch.signal]),
      headers: sessionHeader === undefined ? {} : { [sessionHeader]: session.id },
      onAnswered: () => clock.answered(),
      onBytes: watch.bytes,
      onEvent: (event) => {
        watch.event(event);
        clock.observe(event);
        if (event.type === 'content_block_delta' && event.delta.type === 'text_delta') onText(event.delta.text);
        if (event.type === 'content_block_start' && event.content_block.type === 'tool_use') draft(event.index, { id: event.content_block.id, name: event.content_block.name, json: '' });
        if (event.type === 'content_block_delta' && event.delta.type === 'input_json_delta') {
          const was = drafts.get(event.index);
          if (was !== undefined) draft(event.index, { ...was, json: was.json + event.delta.partial_json });
        }
      },
    })
      .catch((error: unknown) => {
        throw watch.stalled() ?? error;
      })
      .finally(watch.stop);
    if (message.stop_reason === 'refusal') {
      return { kind: 'error', error: 'refusal', message: refusalMessage(message) };
    }
    // The answer stopped because the conversation filled the window, so it takes the too-long path: compact, then send again.
    if (message.stop_reason === 'model_context_window_exceeded') {
      return { kind: 'error', error: 'overflow', message: 'the conversation filled the model’s context window' };
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
        promptParts: requestRuns(request, events, adapter),
        ...(kept === undefined ? {} : { snapshot: kept }),
      },
    };
  }

  return {
    async turn(input) {
      const { signal } = input;
      let waiting: Waiting | undefined;
      // Failed tries within the current wait, which its schedule backs off by.
      let tries = 0;
      let stalls = 0;
      let waitedMs = 0;
      let clock = streamClock();
      const settled = (result: TurnResult): TurnResult => {
        input.onMarks?.({ ...clock.marks(), ...(waitedMs > 0 ? { waitMs: waitedMs } : {}) });
        return result;
      };
      const endWait = async () => {
        if (waiting === undefined) return;
        waiting = undefined;
        tries = 0;
        await input.onWait?.(null);
      };
      const plan = (kind: WaitKind, since: number, resetAt: number | null) =>
        planWait(waits.policy, { kind, since, tries, resetAt }, Date.now(), waits.resume, waits.random());

      // Sleeps to the wait's next try. Offline, a probe of the host decides whether the call goes out, and one that
      // finds nothing schedules the next. Retry now sends the call at once.
      const holdOn = async (): Promise<Held> => {
        for (;;) {
          const wait = waiting!;
          await input.onWait?.(wait);
          const began = Date.now();
          const woke = await nap(wait.retryAt === null ? Infinity : wait.retryAt - began, signal, input.wake);
          waitedMs += Date.now() - began;
          if (woke === 'aborted') return { kind: 'aborted' };
          if (woke === 'woken' || wait.kind === 'limited') return { kind: 'go' };
          const probing = Date.now();
          const up = await wire.probe(signal);
          waitedMs += Date.now() - probing;
          if (signal.aborted) return { kind: 'aborted' };
          if (up) return { kind: 'go' };
          tries++;
          const next = plan('offline', wait.since, null);
          if (next.kind === 'give-up') return next;
          waiting = { ...wait, retryAt: next.kind === 'at' ? next.at : null };
        }
      };
      // False when the user stopped the turn during the wait.
      const backOff = async (delayMs: number): Promise<boolean> => {
        try {
          await sleep(delayMs, undefined, { signal });
          return true;
        } catch (sleepError) {
          if (signal.aborted) return false;
          throw sleepError;
        }
      };
      // Undefined when the call should go out; otherwise how the turn ends.
      const waitOut = async (): Promise<TurnResult | undefined> => {
        const outcome = await holdOn();
        if (outcome.kind === 'go') return undefined;
        const message = outcome.kind === 'aborted' ? undefined : `${waiting!.message} (${outcome.message})`;
        await endWait();
        return settled(message === undefined ? ABORTED : { kind: 'error', error: 'transport', message });
      };

      if (input.waiting !== undefined) {
        // An offline wait from an engine that stopped probes at once; a limit keeps the time it was to resume at.
        waiting = input.waiting.kind === 'offline' ? { ...input.waiting, retryAt: Date.now() } : input.waiting;
        const ended = await waitOut();
        if (ended !== undefined) return ended;
      }
      for (let attempt = 1; ; ) {
        try {
          // The clock starts once the call has its slot, so a queued call does not read as a slow first token.
          const result = await slots.run(() => {
            clock = streamClock();
            return call(input, clock);
          }, signal);
          await endWait();
          return settled(result);
        } catch (error) {
          if (error instanceof APIUserAbortError || signal.aborted) {
            await endWait();
            return settled(ABORTED);
          }
          if (error instanceof StreamStalled) {
            await endWait();
            const delayMs = ++stalls > STALL_RETRIES ? undefined : retryDelayMs(retry, attempt, undefined);
            if (delayMs === undefined) return settled({ kind: 'error', error: 'transport', message: error.giveUp });
            await input.onRetry({ attempt, delayMs, message: error.message });
            attempt++;
            if (!(await backOff(delayMs))) return settled(ABORTED);
            continue;
          }
          if (!(error instanceof AnthropicError)) throw error;
          const failure = failureOf(error, wire.redact, clock.streamed());
          const failed = classifyFailure(failure, Date.now());
          if (failed.kind === 'offline' || failed.kind === 'limited') {
            const same = waiting?.kind === failed.kind;
            tries = same ? tries + 1 : 0;
            const since = same ? waiting!.since : Date.now();
            const resetAt = failed.kind === 'limited' ? (failed.resetAt ?? null) : null;
            const next = plan(failed.kind, since, resetAt);
            if (next.kind === 'give-up') {
              await endWait();
              return settled({ kind: 'error', error: 'transport', message: `${failure.message} (${next.message})` });
            }
            waiting = { kind: failed.kind, since, retryAt: next.kind === 'at' ? next.at : null, resetAt, message: failure.message };
            // A short limit holds back the other sessions' calls as well, as U26's shared pause did before limits waited.
            const pauseMs = (waiting.retryAt === null ? Infinity : (resetAt ?? waiting.retryAt)) - Date.now();
            if (failed.kind === 'limited' && pauseMs <= retry.maxDelayMs) slots.pause(pauseMs);
            const ended = await waitOut();
            if (ended !== undefined) return ended;
            continue;
          }
          await endWait();
          const delayMs = failed.kind === 'transient' ? retryDelayMs(retry, attempt, retryAfterMs(error)) : undefined;
          if (delayMs === undefined) return settled({ kind: 'error', error: TURN_ERROR_OF[failed.kind], message: failure.message });
          await input.onRetry({ attempt, delayMs, message: failure.message });
          attempt++;
          if (!(await backOff(delayMs))) return settled(ABORTED);
        }
      }
    },
  };
}
