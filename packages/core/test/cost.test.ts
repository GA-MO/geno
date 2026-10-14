import { describe, expect, it } from 'vitest';
import { capUsd, costOf, defaultUsd, priceFactor, REFERENCE_CALL, REFERENCE_MODEL } from '../src/index.js';

const million = { input: 1_000_000, cacheRead: 1_000_000, cacheWrite: 1_000_000, output: 1_000_000 };

describe('costOf', () => {
  it('prices each usage bucket at its own rate', () => {
    expect(costOf('openrouter', 'anthropic/claude-opus-5.5', million)).toBeCloseTo(4 + 0.2 + 5 + 20);
    expect(costOf('openrouter', 'anthropic/claude-sonnet-5.5', million)).toBeCloseTo(2 + 0.2 + 2.5 + 10);
    expect(costOf('modelstudio', 'qwen3.8-flash', million)).toBeCloseTo(0.15 + 0.15 + 0.1875 + 0.47);
    expect(
      costOf('openrouter', 'anthropic/claude-opus-5.5', { input: 12, cacheRead: 3000, cacheWrite: 0, output: 40 }),
    ).toBeCloseTo((12 * 4 + 3000 * 0.2 + 40 * 20) / 1e6, 12);
  });

  it('returns null, not zero, for an unknown model', () => {
    expect(costOf('openrouter', 'openai/gpt-x', million)).toBeNull();
    expect(costOf('openrouter', 'toString', million)).toBeNull();
  });
});

describe('the cap rule: a built-in dollar cap buys as many typical calls on every model', () => {
  it('leaves a cap on the reference model, qwen3.8-flash, as it was', () => {
    expect(REFERENCE_MODEL).toEqual({ provider: 'modelstudio', model: 'qwen3.8-flash' });
    expect(priceFactor('modelstudio', 'qwen3.8-flash')).toBe(1);
    for (const usd of [0.02, 0.032, 0.05, 0.2, 0.4, 0.5]) expect(capUsd(defaultUsd(usd), 'modelstudio', 'qwen3.8-flash')).toBe(usd);
  });

  it("scales a default by what the reference call costs on the model: Sonnet about 4.9 times, Opus about 8.7", () => {
    const ratio = (provider: 'anthropic', model: string) => costOf(provider, model, REFERENCE_CALL)! / costOf('modelstudio', 'qwen3.8-flash', REFERENCE_CALL)!;
    expect(priceFactor('anthropic', 'claude-sonnet-5-5')).toBeCloseTo(ratio('anthropic', 'claude-sonnet-5-5'));
    expect(priceFactor('anthropic', 'claude-sonnet-5-5')).toBeCloseTo(4.91, 2);
    expect(priceFactor('anthropic', 'claude-opus-5-5')).toBeCloseTo(8.725, 2);
    expect(capUsd(defaultUsd(0.4), 'anthropic', 'claude-sonnet-5-5')).toBe(1.964);
    expect(capUsd(defaultUsd(0.4), 'anthropic', 'claude-opus-5-5')).toBe(3.49);
    expect(capUsd(defaultUsd(0.05), 'anthropic', 'claude-sonnet-5-5')).toBe(0.245);
  });

  it('keeps a cap a user set as given, on any model', () => {
    expect(capUsd(0.4, 'anthropic', 'claude-opus-5-5')).toBe(0.4);
    expect(capUsd(0.05, 'modelstudio', 'qwen3.8-flash')).toBe(0.05);
  });

  it("keeps the reference dollars for a model with no price, whose spend a budget cannot see, so its turn cap holds", () => {
    expect(priceFactor('bedrock', 'anthropic.claude-sonnet-5-5')).toBe(1);
    expect(capUsd(defaultUsd(0.4), 'openai', 'gpt-x')).toBe(0.4);
  });
});
