import { describe, expect, it } from 'vitest';
import { capUsd } from '@g-code/core';
import { DEFAULT_TURN_USD, limitsOf } from '../src/agent.js';
import { limitsOn } from '../src/drive.js';

const sonnet = { provider: 'anthropic', model: 'claude-sonnet-5-5' } as const;
const flash = { provider: 'modelstudio', model: 'qwen3.8-flash' } as const;

describe("a prompt's default limits", () => {
  it('give a strong model five times the calls and the scaled dollars a cheap model gets', () => {
    expect(limitsOn(limitsOf({}), flash)).toEqual({ maxTurns: 40, maxCostUsd: capUsd(DEFAULT_TURN_USD, flash.provider, flash.model) });
    expect(limitsOn(limitsOf({}), sonnet)).toEqual({ maxTurns: 200, maxCostUsd: capUsd(DEFAULT_TURN_USD, sonnet.provider, sonnet.model) * 5 });
  });

  it('keep the limits the user set as they are', () => {
    expect(limitsOn(limitsOf({ 'max-turns': '30', 'max-cost': '2' }), sonnet)).toEqual({ maxTurns: 30, maxCostUsd: 2 });
    expect(limitsOn(limitsOf({ 'max-turns': '30' }), sonnet)).toEqual({ maxTurns: 30, maxCostUsd: capUsd(DEFAULT_TURN_USD, sonnet.provider, sonnet.model) });
  });
});
