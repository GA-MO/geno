import type { TokenUsage } from './session.js';

type Rates = { readonly [K in keyof TokenUsage]: number };

/** USD per million tokens, keyed by the model name each provider takes. */
export const PRICES: Readonly<Record<string, Rates>> = {
  // OpenRouter, from https://openrouter.ai/api/v1/models.
  'anthropic/claude-opus-5.5': { input: 4.0, output: 20.0, cacheRead: 0.2, cacheWrite: 5.0 },
  'anthropic/claude-sonnet-5.5': { input: 2.0, output: 10.0, cacheRead: 0.2, cacheWrite: 2.5 },
  // Model Studio Singapore list price. It lists no cache rates, so cache reads bill at the full input rate
  // and writes at 1.25x input: both overstate the cost on purpose, so a budget never underestimates.
  'qwen3.8-flash': { input: 0.15, output: 0.47, cacheRead: 0.15, cacheWrite: 0.1875 },
  'qwen3.7-plus': { input: 0.4, output: 1.6, cacheRead: 0.4, cacheWrite: 0.5 },
};

/** Null for an unpriced model, so an unknown cost never reads as free. */
export function costOf(model: string, usage: TokenUsage): number | null {
  if (!Object.hasOwn(PRICES, model)) return null;
  const rates = PRICES[model]!;
  const buckets = Object.keys(rates) as (keyof TokenUsage)[];
  return buckets.reduce((sum, k) => sum + usage[k] * rates[k], 0) / 1_000_000;
}
