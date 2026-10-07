import { capabilitiesOf } from './model-capabilities.js';
import type { ProviderName } from './providers.js';
import type { Session, TokenUsage, TurnEvent } from './session.js';

/** How full the context is: tokens in it, and the model's window, undefined when unknown. */
export type ContextUse = { readonly used: number; readonly window: number | undefined };

/** The context after a model call: everything it read, plus its answer, which the next call reads again. */
export const contextUseOf = (provider: ProviderName, model: string, usage: TokenUsage): ContextUse => ({
  used: usage.input + usage.cacheRead + usage.cacheWrite + usage.output,
  window: capabilitiesOf(provider, model).window,
});

/**
 * After the session's latest model call, or its latest compaction's estimate when that came later. The window is the
 * session's model's, the one Geno asked for and prices.
 */
export function lastContextUse({ provider, model }: Pick<Session, 'provider' | 'model'>, events: readonly TurnEvent[]): ContextUse | undefined {
  const last = events.findLast((e) => e.kind === 'assistant' || e.kind === 'compact');
  if (last?.kind === 'compact') return { used: last.tokensAfter, window: capabilitiesOf(provider, model).window };
  return last === undefined ? undefined : contextUseOf(provider, model, last.usage);
}

/** Measured on Model Studio qwen3.8-flash over Geno's own and the browser's definitions by scripts/prefix-tokens.ts. */
export const CHARS_PER_TOKEN = 3.5;

/** An estimate for text the API has not counted yet. */
export const textTokens = (text: string): number => Math.ceil(text.length / CHARS_PER_TOKEN);
