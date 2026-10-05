import { describe, expect, it } from 'vitest';
import { contextUseOf, contextWindowOf, lastContextUse, type TurnEvent } from '../src/index.js';

const usage = { input: 1200, cacheRead: 30_000, cacheWrite: 800, output: 400 };
const answer = (seq: number, model: string, tokens = usage): TurnEvent => ({
  kind: 'assistant',
  seq,
  at: '2026-10-06T00:00:00.000Z',
  content: [],
  stopReason: 'end_turn',
  usage: tokens,
  costUsd: 0.001,
  latencyMs: 10,
  model,
});

describe('contextWindowOf', () => {
  it('knows the windows Model Studio documents for its Qwen models', () => {
    expect(contextWindowOf('modelstudio', 'qwen3.8-flash')).toBe(1_000_000);
    expect(contextWindowOf('modelstudio', 'qwen3.7-plus')).toBe(1_000_000);
  });

  it('says undefined, never a guess, for a model it has no row for', () => {
    expect(contextWindowOf('openrouter', 'qwen3.8-flash')).toBeUndefined();
    expect(contextWindowOf('modelstudio', 'toString')).toBeUndefined();
  });
});

describe('contextUseOf', () => {
  it('counts what the call read and what it wrote, which the next call reads again', () => {
    expect(contextUseOf('modelstudio', 'qwen3.8-flash', usage)).toEqual({ used: 1200 + 30_000 + 800 + 400, window: 1_000_000 });
  });
});

describe('lastContextUse', () => {
  it('is the latest model call of the log, sized by the session\'s model even when the answer names a snapshot', () => {
    const events = [answer(1, 'qwen3.8-flash', { input: 10, cacheRead: 0, cacheWrite: 0, output: 5 }), answer(2, 'qwen3.8-flash-2026-09-01')];
    expect(lastContextUse({ provider: 'modelstudio', model: 'qwen3.8-flash' }, events)).toEqual({ used: 32_400, window: 1_000_000 });
  });

  it('is undefined before any model call', () => {
    expect(lastContextUse({ provider: 'modelstudio', model: 'qwen3.8-flash' }, [])).toBeUndefined();
  });
});
