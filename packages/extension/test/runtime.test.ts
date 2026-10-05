import { describe, expect, it } from 'vitest';
import { describeRuntime, engineEnv, readModelRuntime, setupProblem } from '../src/runtime.js';

const settingsOf = (values: Record<string, unknown>) => ({ get: <T>(key: string, fallback: T): T => (values[key] as T | undefined) ?? fallback });
const secretsOf = (values: Record<string, string>) => ({ get: async (key: string) => values[key] });

const STORED = 'sk-stored-in-secret-storage';
const INHERITED = 'sk-from-the-environment';
const URL = 'https://ws-1.example.com/apps/anthropic';

describe('the model runtime', () => {
  it('takes the key from SecretStorage over the environment, and hands the engine provider, endpoint, model and key', async () => {
    const runtime = await readModelRuntime(
      settingsOf({ baseUrl: URL, model: 'qwen3.8-flash' }),
      secretsOf({ 'gcode.apiKey.modelstudio': STORED }),
      { DASHSCOPE_API_KEY: INHERITED, DASHSCOPE_BASE_URL: 'https://stale.example.com' },
    );

    expect(runtime.key).toEqual({ source: 'secret-storage', value: STORED });
    expect(setupProblem(runtime)).toBeUndefined();
    expect(engineEnv(runtime)).toEqual({
      GCODE_PROVIDER: 'modelstudio',
      GCODE_MODEL: 'qwen3.8-flash',
      DASHSCOPE_API_KEY: STORED,
      DASHSCOPE_BASE_URL: URL,
    });
    expect(describeRuntime(runtime)).toBe('modelstudio, model qwen3.8-flash, key from secret-storage');
  });

  it('falls back to the environment, and leaves the model to the engine when the setting is empty', async () => {
    const runtime = await readModelRuntime(settingsOf({}), secretsOf({}), { DASHSCOPE_API_KEY: INHERITED, DASHSCOPE_BASE_URL: URL });

    expect(runtime).toEqual({ provider: 'modelstudio', baseUrl: URL, model: undefined, key: { source: 'environment', value: INHERITED } });
    expect(engineEnv(runtime)).not.toHaveProperty('GCODE_MODEL');
  });

  it('names the fix for a missing key, then for a missing Model Studio endpoint', async () => {
    const keyless = await readModelRuntime(settingsOf({ baseUrl: URL }), secretsOf({}), {});
    expect(setupProblem(keyless)).toEqual({
      message: 'Geno has no Model Studio API key. Run Geno: Set API Key.',
      fix: { label: 'Set API Key', command: 'gcode.setApiKey', args: [] },
    });
    expect(describeRuntime(keyless)).toBe('modelstudio, model default, key from nowhere');

    const endpointless = await readModelRuntime(settingsOf({}), secretsOf({ 'gcode.apiKey.modelstudio': STORED }), {});
    expect(setupProblem(endpointless)?.fix.args).toEqual(['gcode.baseUrl']);
  });

  it('keeps each provider’s key apart, and ignores the endpoint for OpenRouter', async () => {
    const runtime = await readModelRuntime(
      settingsOf({ provider: 'openrouter', baseUrl: URL }),
      secretsOf({ 'gcode.apiKey.modelstudio': STORED, 'gcode.apiKey.openrouter': 'sk-or' }),
      {},
    );

    expect(setupProblem(runtime)).toBeUndefined();
    expect(engineEnv(runtime)).toEqual({ GCODE_PROVIDER: 'openrouter', OPENROUTER_API_KEY: 'sk-or' });
  });

  it('refuses a provider it does not know', async () => {
    await expect(readModelRuntime(settingsOf({ provider: 'nope' }), secretsOf({}), {})).rejects.toThrow('gcode.provider is nope');
  });
});
