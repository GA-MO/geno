import type { TokenUsage } from './session.js';

type Rates = { readonly [K in keyof TokenUsage]: number };

/** USD per million tokens, keyed by OpenRouter slug, from https://openrouter.ai/api/v1/models. */
export const PRICES: Readonly<Record<string, Rates>> = {
  'anthropic/claude-opus-5.5': { input: 4.0, output: 20.0, cacheRead: 0.2, cacheWrite: 5.0 },
  'anthropic/claude-sonnet-5.5': { input: 2.0, output: 10.0, cacheRead: 0.2, cacheWrite: 2.5 },
};

/** Null for an unpriced model, so an unknown cost never reads as free. */
export function costOf(model: string, usage: TokenUsage): number | null {
  if (!Object.hasOwn(PRICES, model)) return null;
  const rates = PRICES[model]!;
  const buckets = Object.keys(rates) as (keyof TokenUsage)[];
  return buckets.reduce((sum, k) => sum + usage[k] * rates[k], 0) / 1_000_000;
}
