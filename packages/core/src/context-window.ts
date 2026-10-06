import type { ProviderName } from './providers.js';
import type { Session, TokenUsage, TurnEvent } from './session.js';

/**
 * Context window sizes in tokens, per provider and the model name it takes, as PRICES is keyed. A model missing here
 * has an unknown window, never a guessed one.
 */
export const CONTEXT_WINDOWS: { readonly [P in ProviderName]: Readonly<Record<string, number>> } = {
  openrouter: {},
  // https://www.alibabacloud.com/help/en/model-studio/qwen3-8-flash and .../qwen3-7-plus, "Context length".
  modelstudio: { 'qwen3.8-flash': 1_000_000, 'qwen3.7-plus': 1_000_000 },
  anthropic: {},
  bedrock: {},
  vertex: {},
  openai: {},
  'azure-openai': {},
  gemini: {},
  deepseek: {},
  groq: {},
  cerebras: {},
  xai: {},
  mistral: {},
  ollama: {},
  lmstudio: {},
};

export const contextWindowOf = (provider: ProviderName, model: string): number | undefined =>
  Object.hasOwn(CONTEXT_WINDOWS[provider], model) ? CONTEXT_WINDOWS[provider][model] : undefined;

/** How full the context is: tokens in it, and the model's window, undefined when unknown. */
export type ContextUse = { readonly used: number; readonly window: number | undefined };

/** The context after a model call: everything it read, plus its answer, which the next call reads again. */
export const contextUseOf = (provider: ProviderName, model: string, usage: TokenUsage): ContextUse => ({
  used: usage.input + usage.cacheRead + usage.cacheWrite + usage.output,
  window: contextWindowOf(provider, model),
});

/**
 * After the session's latest model call, or its latest compaction's estimate when that came later. The window is the
 * session's model's, the one Geno asked for and prices.
 */
export function lastContextUse({ provider, model }: Pick<Session, 'provider' | 'model'>, events: readonly TurnEvent[]): ContextUse | undefined {
  const last = events.findLast((e) => e.kind === 'assistant' || e.kind === 'compact');
  if (last?.kind === 'compact') return { used: last.tokensAfter, window: contextWindowOf(provider, model) };
  return last === undefined ? undefined : contextUseOf(provider, model, last.usage);
}

/** Measured on Model Studio qwen3.8-flash over Geno's own and the browser's definitions by scripts/prefix-tokens.ts. */
export const CHARS_PER_TOKEN = 3.5;

/** An estimate for text the API has not counted yet. */
export const textTokens = (text: string): number => Math.ceil(text.length / CHARS_PER_TOKEN);
