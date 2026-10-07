import { describe, expect, it } from 'vitest';
import { capabilitiesOf, MODEL_CAPABILITIES, PAGE_MAX_CHARS, PRICES, PROVIDERS, PROVIDER_SPECS, UNKNOWN_MODEL, type ProviderName } from '../src/index.js';

const rows = PROVIDERS.flatMap((provider) => Object.entries(MODEL_CAPABILITIES[provider]).map(([model, caps]) => ({ provider, model, caps })));

describe('the model capability table', () => {
  it('has a row for every default model and every priced model', () => {
    const defaults = PROVIDERS.flatMap((provider) => (PROVIDER_SPECS[provider].defaultModel === undefined ? [] : [[provider, PROVIDER_SPECS[provider].defaultModel!] as const]));
    const priced = PROVIDERS.flatMap((provider) => Object.keys(PRICES[provider]).map((model) => [provider, model] as const));
    for (const [provider, model] of [...defaults, ...priced]) expect(capabilitiesOf(provider, model), `${provider} ${model}`).not.toBe(UNKNOWN_MODEL);
  });

  it('keeps every row self-consistent: output and the compaction point inside the window, and a read page, its notice and a rule under the spill limit', () => {
    for (const { provider, model, caps } of rows) {
      const name = `${provider} ${model}`;
      expect(caps.window, name).toBeGreaterThan(0);
      expect(caps.maxOutput, name).toBeLessThan(caps.window!);
      expect(caps.compactAt, name).toBeLessThan(caps.window!);
      expect(caps.spillChars, name).toBeGreaterThanOrEqual(PAGE_MAX_CHARS + 4_000);
      expect(caps.source, name).toMatch(/^https:\/\//);
    }
    expect(UNKNOWN_MODEL.spillChars).toBeGreaterThanOrEqual(PAGE_MAX_CHARS + 4_000);
  });

  it('gives the windows and output limits the providers document', () => {
    expect(capabilitiesOf('modelstudio', 'qwen3.8-flash')).toMatchObject({ window: 1_000_000, maxOutput: 131_072, compactAt: 200_000 });
    expect(capabilitiesOf('modelstudio', 'qwen3.7-plus').compactAt).toBe(800_000);
    expect(capabilitiesOf('modelstudio', 'qwen3.6-flash')).toMatchObject({ window: 1_000_000, maxOutput: 65_536 });
    expect(capabilitiesOf('anthropic', 'claude-opus-5-5')).toMatchObject({ window: 1_000_000, maxOutput: 128_000 });
    expect(capabilitiesOf('anthropic', 'claude-haiku-4-5')).toMatchObject({ window: 200_000, maxOutput: 64_000, compactAt: 160_000 });
  });

  it('caches for an hour only on the wires that take a 1 h TTL, and keeps the default elsewhere', () => {
    expect(capabilitiesOf('anthropic', 'claude-opus-5-5').cacheTtl).toBe('1h');
    expect(capabilitiesOf('bedrock', 'anthropic.claude-opus-5-5').cacheTtl).toBe('1h');
    expect(capabilitiesOf('vertex', 'claude-opus-5-5').cacheTtl).toBe('1h');
    expect(capabilitiesOf('modelstudio', 'qwen3.8-flash').cacheTtl).toBe('5m');
    expect(capabilitiesOf('openrouter', 'anthropic/claude-opus-5.5').cacheTtl).toBe('5m');
  });

  it("prices a Claude cache write at the rate of the TTL Geno asks for: 2x input for 1 h, 1.25x for 5 min", () => {
    for (const provider of ['anthropic', 'openrouter'] as const) {
      for (const [model, rates] of Object.entries(PRICES[provider])) {
        expect(rates.cacheWrite / rates.input, `${provider} ${model}`).toBe(capabilitiesOf(provider, model).cacheTtl === '1h' ? 2 : 1.25);
      }
    }
  });

  it('asks for adaptive thinking only from models that take it', () => {
    expect(capabilitiesOf('anthropic', 'claude-opus-5-5').thinking).toBe('adaptive');
    expect(capabilitiesOf('anthropic', 'claude-haiku-4-5').thinking).toBe('omit');
    expect(capabilitiesOf('modelstudio', 'qwen3.8-flash').thinking).toBe('omit');
  });

  it('sends effort to every model that takes it, and never to Haiku 4.5', () => {
    expect(capabilitiesOf('anthropic', 'claude-haiku-4-5').effort).toBe(false);
    for (const { provider, model, caps } of rows) if (model !== 'claude-haiku-4-5') expect(caps.effort, `${provider} ${model}`).toBe(true);
  });

  it('puts strong models on the principles tier and cheap ones on the rules tier', () => {
    expect(capabilitiesOf('anthropic', 'claude-opus-5-5').promptTier).toBe('principles');
    expect(capabilitiesOf('anthropic', 'claude-haiku-4-5').promptTier).toBe('rules');
    expect(capabilitiesOf('modelstudio', 'qwen3.8-flash').promptTier).toBe('rules');
  });
});

describe('capabilitiesOf an unknown model', () => {
  it('falls back to no window, no auto compaction, no thinking or effort field, the default TTL and the rules tier', () => {
    for (const [provider, model] of [
      ['openrouter', 'qwen3.8-flash'],
      ['modelstudio', 'toString'],
      ['azure-openai', 'my-deployment'],
      ['ollama', 'llama3'],
    ] as const satisfies readonly (readonly [ProviderName, string])[]) {
      expect(capabilitiesOf(provider, model), `${provider} ${model}`).toEqual(UNKNOWN_MODEL);
    }
    expect(UNKNOWN_MODEL).toMatchObject({ window: undefined, compactAt: undefined, thinking: 'omit', effort: false, cacheTtl: '5m', promptTier: 'rules', maxOutput: 64_000 });
  });
});
