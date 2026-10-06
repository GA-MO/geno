import { describe, expect, it } from 'vitest';
import { compactAtOf } from '../src/compact.js';

const flash = { provider: 'modelstudio', model: 'qwen3.8-flash' } as const;

describe('where a session compacts on its own', () => {
  it("is 80% of the model's window by default", () => {
    expect(compactAtOf({}, flash)).toBe(800_000);
  });

  it('is never for a model whose window Geno does not know', () => {
    expect(compactAtOf({}, { provider: 'openrouter', model: 'some/model' })).toBeUndefined();
  });

  it('is GCODE_COMPACT_AT when set, for any model', () => {
    expect(compactAtOf({ GCODE_COMPACT_AT: '150000' }, flash)).toBe(150_000);
    expect(compactAtOf({ GCODE_COMPACT_AT: '64000' }, { provider: 'openrouter', model: 'some/model' })).toBe(64_000);
    expect(compactAtOf({ GCODE_COMPACT_AT: ' ' }, flash)).toBe(800_000);
  });

  it('refuses a setting that is not a whole number of tokens', () => {
    for (const raw of ['0', '-5', '0.5', '80%', 'lots']) expect(() => compactAtOf({ GCODE_COMPACT_AT: raw }, flash)).toThrow(/GCODE_COMPACT_AT must be a positive whole number/);
  });
});
