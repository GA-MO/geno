import { FIM_TOKENS, type FimPrompt } from './prompt.js';
import { ZETA_TOKENS, type NextEditPrompt } from './zeta.js';

export const DEFAULT_N_PREDICT = 64;

/** A llama-server /completion body. The prompt already carries Qwen's FIM tokens, so /infill's own layout is not used. */
export const fimRequestBody = (prompt: FimPrompt, nPredict: number = DEFAULT_N_PREDICT) => ({
  prompt: prompt.prompt,
  n_predict: nPredict,
  temperature: 0,
  stream: true,
  cache_prompt: true,
  stop: [FIM_TOKENS.file, FIM_TOKENS.prefix, FIM_TOKENS.repo, ...(prompt.singleLine ? ['\n'] : [])],
});

/** Zeta rewrites a whole span of up to 16 lines between markers, so it needs far more room than FIM. */
export const DEFAULT_NEXT_EDIT_N_PREDICT = 768;

/** llama-server does not add Seed-Coder's BOS token, and without it Zeta answers "no edit" to the card's sample. */
export const nextEditRequestBody = (prompt: NextEditPrompt, nPredict: number = DEFAULT_NEXT_EDIT_N_PREDICT) => ({
  prompt: ZETA_TOKENS.bos + prompt.prompt,
  n_predict: nPredict,
  temperature: 0,
  stream: true,
  cache_prompt: true,
});

export type ServerTimings = {
  readonly promptTokens: number;
  readonly promptMs: number;
  readonly predictedTokens: number;
  readonly predictedMs: number;
};

export type FimResult = {
  readonly text: string;
  readonly model: string | null;
  readonly ttftMs: number | null;
  readonly latencyMs: number;
  /** All prompt tokens, including any the server reused from its cache. */
  readonly promptTokens: number | null;
  readonly timings: ServerTimings | null;
};

type ServerCall = {
  readonly fetch: typeof globalThis.fetch;
  readonly endpoint: string;
  readonly signal?: AbortSignal;
  readonly now: () => number;
  readonly nPredict?: number;
};

export type FimCall = ServerCall & { readonly prompt: FimPrompt };
export type NextEditCall = ServerCall & { readonly prompt: NextEditPrompt };

type Chunk = {
  content?: unknown;
  model?: unknown;
  tokens_evaluated?: unknown;
  timings?: { prompt_n?: unknown; prompt_ms?: unknown; predicted_n?: unknown; predicted_ms?: unknown };
};

const num = (raw: unknown): number | null => (typeof raw === 'number' ? raw : null);

function timingsOf({ timings: t }: Chunk): ServerTimings | null {
  const [promptTokens, promptMs, predictedTokens, predictedMs] = [
    t?.prompt_n,
    t?.prompt_ms,
    t?.predicted_n,
    t?.predicted_ms,
  ].map(num);
  if (promptTokens == null || promptMs == null || predictedTokens == null || predictedMs == null) return null;
  return { promptTokens, promptMs, predictedTokens, predictedMs };
}

export class FimServerError extends Error {}

export const streamFim = (call: FimCall): Promise<FimResult> =>
  streamCompletion(call, fimRequestBody(call.prompt, call.nPredict));

export const streamNextEdit = (call: NextEditCall): Promise<FimResult> =>
  streamCompletion(call, nextEditRequestBody(call.prompt, call.nPredict));

/** Streams one completion; time to first token is when the first non-empty piece of text arrives. */
async function streamCompletion(call: ServerCall, body: object): Promise<FimResult> {
  const sentAt = call.now();
  const init: RequestInit = {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  };
  if (call.signal !== undefined) init.signal = call.signal;
  const response = await call.fetch(new URL('/completion', call.endpoint), init);
  if (!response.ok || response.body === null) {
    throw new FimServerError(`${response.status} ${response.statusText}: ${await response.text()}`);
  }
  let text = '';
  let ttftMs: number | null = null;
  let last: Chunk = {};
  let buffered = '';
  const decoder = new TextDecoder();
  for await (const bytes of response.body) {
    buffered += decoder.decode(bytes, { stream: true });
    const lines = buffered.split('\n');
    buffered = lines.pop()!;
    for (const line of lines) {
      if (!line.startsWith('data: ')) continue;
      last = JSON.parse(line.slice('data: '.length)) as Chunk;
      if (typeof last.content !== 'string' || last.content === '') continue;
      ttftMs ??= call.now() - sentAt;
      text += last.content;
    }
  }
  return {
    text,
    model: typeof last.model === 'string' ? last.model : null,
    ttftMs,
    latencyMs: call.now() - sentAt,
    promptTokens: num(last.tokens_evaluated),
    timings: timingsOf(last),
  };
}
