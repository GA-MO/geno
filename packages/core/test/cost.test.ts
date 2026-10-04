import { describe, expect, it } from 'vitest';
import { costOf } from '../src/index.js';

const million = { input: 1_000_000, cacheRead: 1_000_000, cacheWrite: 1_000_000, output: 1_000_000 };

describe('costOf', () => {
  it('prices each usage bucket at its own rate', () => {
    expect(costOf('anthropic/claude-opus-5.5', million)).toBeCloseTo(4 + 0.2 + 5 + 20);
    expect(costOf('anthropic/claude-sonnet-5.5', million)).toBeCloseTo(2 + 0.2 + 2.5 + 10);
    expect(
      costOf('anthropic/claude-opus-5.5', { input: 12, cacheRead: 3000, cacheWrite: 0, output: 40 }),
    ).toBeCloseTo((12 * 4 + 3000 * 0.2 + 40 * 20) / 1e6, 12);
  });

  it('returns null, not zero, for an unknown model', () => {
    expect(costOf('openai/gpt-x', million)).toBeNull();
    expect(costOf('toString', million)).toBeNull();
  });
});
