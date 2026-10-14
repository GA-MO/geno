import type { ProviderName } from './providers.js';
import type { TokenUsage } from './session.js';

export type Rates = { readonly [K in keyof TokenUsage]: number };

/**
 * USD per million tokens, per provider and the model name it takes, so a new provider row has to say what it
 * knows. A model missing here is priced as unknown, never as free. Bedrock and Vertex set their own prices for
 * Claude, and the OpenAI-compatible providers' prices are not checked yet, so they list none.
 */
export const PRICES: { readonly [P in ProviderName]: Readonly<Record<string, Rates>> } = {
  // From https://openrouter.ai/api/v1/models.
  openrouter: {
    'anthropic/claude-opus-5.5': { input: 4.0, output: 20.0, cacheRead: 0.2, cacheWrite: 5.0 },
    'anthropic/claude-sonnet-5.5': { input: 2.0, output: 10.0, cacheRead: 0.2, cacheWrite: 2.5 },
  },
  // Model Studio Singapore list price. It lists no cache rates, so cache reads bill at the full input rate
  // and writes at 1.25x input: both overstate the cost on purpose, so a budget never underestimates.
  modelstudio: {
    'qwen3.8-flash': { input: 0.15, output: 0.47, cacheRead: 0.15, cacheWrite: 0.1875 },
    'qwen3.7-plus': { input: 0.4, output: 1.6, cacheRead: 0.4, cacheWrite: 0.5 },
  },
  // Anthropic's list price. Geno writes this provider's cache entries for an hour (MODEL_CAPABILITIES), which bills at
  // 2x input; reads are listed per model.
  anthropic: {
    'claude-opus-5-5': { input: 4.0, output: 20.0, cacheRead: 0.2, cacheWrite: 8.0 },
    'claude-sonnet-5-5': { input: 2.0, output: 10.0, cacheRead: 0.2, cacheWrite: 4.0 },
    'claude-haiku-4-5': { input: 1.0, output: 5.0, cacheRead: 0.1, cacheWrite: 2.0 },
  },
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

export const isPriced = (provider: ProviderName, model: string): boolean => Object.hasOwn(PRICES[provider], model);

export const ratesOf = (provider: ProviderName, model: string): Rates | undefined => (isPriced(provider, model) ? PRICES[provider][model] : undefined);

/** Null without rates, so an unknown cost never reads as free. */
export function costAt(rates: Rates | undefined, usage: TokenUsage): number | null {
  if (rates === undefined) return null;
  const buckets = Object.keys(rates) as (keyof TokenUsage)[];
  return buckets.reduce((sum, k) => sum + usage[k] * rates[k], 0) / 1_000_000;
}

export const costOf = (provider: ProviderName, model: string, usage: TokenUsage): number | null => costAt(ratesOf(provider, model), usage);

/**
 * The model Geno's built-in dollar caps were sized on, and its mean model call: 1,209 calls of 143 archived runs of
 * docs/results/real-usecases (the 34 Claude Sonnet 5.5 runs' 144 calls have the same shape, each bucket within 15%).
 */
export const REFERENCE_MODEL = { provider: 'modelstudio', model: 'qwen3.8-flash' } as const satisfies { readonly provider: ProviderName; readonly model: string };
export const REFERENCE_CALL: TokenUsage = { input: 6, cacheRead: 10_854, cacheWrite: 1_024, output: 346 };

/**
 * A built-in default dollar cap, written as what it allows on the reference model. `capUsd` scales it to the model
 * that runs, so a cap buys the same number of typical calls on every model. A plain number is a cap a user set, and
 * holds as given.
 */
export type DefaultUsd = { readonly referenceUsd: number };
export type UsdCap = number | DefaultUsd;
export const defaultUsd = (referenceUsd: number): DefaultUsd => ({ referenceUsd });

/**
 * What one typical call costs on this model over what it costs on the reference model. A model with no price keeps
 * the reference dollars: its calls cost unknown, which a budget counts as free, so its turn cap is what stops it.
 */
export function priceFactor(provider: ProviderName, model: string): number {
  const here = costAt(ratesOf(provider, model), REFERENCE_CALL);
  return here === null ? 1 : here / costAt(ratesOf(REFERENCE_MODEL.provider, REFERENCE_MODEL.model), REFERENCE_CALL)!;
}

/** A cap in dollars on this model, to a tenth of a cent. */
export const capUsd = (cap: UsdCap, provider: ProviderName, model: string): number =>
  typeof cap === 'number' ? cap : Math.round(cap.referenceUsd * priceFactor(provider, model) * 1000) / 1000;
