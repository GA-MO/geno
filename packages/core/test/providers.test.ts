import { describe, expect, it } from 'vitest';
import {
  baseUrlOf,
  classifierChoiceOf,
  costOf,
  missingField,
  PRICES,
  PROVIDER_SPECS,
  PROVIDERS,
  providerValues,
  ROLE_SPECS,
  SECRET_ENV_NAMES,
  specOf,
} from '../src/index.js';

const million = { input: 1_000_000, cacheRead: 1_000_000, cacheWrite: 1_000_000, output: 1_000_000 };

describe('the provider registry', () => {
  it('has one row per provider, each keyed by its own id', () => {
    expect(Object.keys(PROVIDER_SPECS).sort()).toEqual([...PROVIDERS].sort());
    for (const id of PROVIDERS) expect(specOf(id).id).toBe(id);
  });

  it('covers the Anthropic-format and OpenAI-compatible providers the brief names', () => {
    const byAdapter = (adapter: string) => PROVIDERS.filter((id) => specOf(id).adapter === adapter);
    expect(byAdapter('anthropic')).toEqual(['openrouter', 'modelstudio', 'anthropic', 'bedrock', 'vertex']);
    expect(byAdapter('openai')).toEqual(['openai', 'azure-openai', 'gemini', 'deepseek', 'groq', 'cerebras', 'xai', 'mistral', 'ollama', 'lmstudio']);
  });

  it('keeps today’s variable names, so existing keys and endpoints still work', () => {
    expect(specOf('modelstudio').fields.map((f) => [f.id, f.env])).toEqual([
      ['apiKey', 'DASHSCOPE_API_KEY'],
      ['baseUrl', 'DASHSCOPE_BASE_URL'],
    ]);
    expect(specOf('openrouter').fields.find((f) => f.id === 'apiKey')?.env).toBe('OPENROUTER_API_KEY');
    expect(ROLE_SPECS.chat.env).toEqual({ provider: 'GCODE_PROVIDER', model: 'GCODE_MODEL' });
    expect(ROLE_SPECS.classifier.env).toEqual({ provider: 'GCODE_CLASSIFIER_PROVIDER', model: 'GCODE_CLASSIFIER_MODEL' });
    expect(specOf('modelstudio').defaultModel).toBe('qwen3.8-flash');
    expect(specOf('openrouter').defaultModel).toBe('anthropic/claude-opus-5.5');
  });

  it('gives every row exactly one base URL field, required when there is no default', () => {
    for (const id of PROVIDERS) {
      const spec = specOf(id);
      const urls = spec.fields.filter((f) => f.id === 'baseUrl');
      expect(urls, id).toHaveLength(1);
      expect(urls[0]!.secret, id).toBe(false);
      if (spec.key.kind === 'header') expect(urls[0]!.required, id).toBe(spec.defaultBaseUrl === undefined);
    }
  });

  it('supplies a header key as an apiKey field, AWS with a region, and Google with a project and region', () => {
    for (const id of PROVIDERS) {
      const spec = specOf(id);
      const ids = spec.fields.map((f) => f.id);
      if (spec.key.kind === 'header') expect(ids, id).toContain('apiKey');
      if (spec.key.kind === 'aws') expect(ids, id).toEqual(expect.arrayContaining(['region', 'accessKeyId', 'secretAccessKey', 'profile']));
      if (spec.key.kind === 'google') expect(ids, id).toEqual(expect.arrayContaining(['project', 'region']));
      expect(new Set(spec.fields.map((f) => f.env)).size, id).toBe(spec.fields.length);
    }
    expect(specOf('anthropic').key).toEqual({ kind: 'header', header: 'x-api-key', scheme: undefined });
    expect(specOf('azure-openai').key).toEqual({ kind: 'header', header: 'api-key', scheme: undefined });
    expect(specOf('openai').key).toEqual({ kind: 'header', header: 'authorization', scheme: 'Bearer' });
  });

  it('lists every secret variable, and no setting among them', () => {
    expect(SECRET_ENV_NAMES).toEqual(
      expect.arrayContaining(['DASHSCOPE_API_KEY', 'OPENROUTER_API_KEY', 'ANTHROPIC_API_KEY', 'AWS_SECRET_ACCESS_KEY', 'AWS_SESSION_TOKEN', 'OPENAI_API_KEY', 'GCODE_VERTEX_ACCESS_TOKEN']),
    );
    expect(SECRET_ENV_NAMES).not.toContain('AWS_REGION');
    expect(SECRET_ENV_NAMES).not.toContain('DASHSCOPE_BASE_URL');
  });

  it('reads values from the environment, treats empty as unset, and names the first missing required field', () => {
    const spec = specOf('modelstudio');
    const values = providerValues(spec, { DASHSCOPE_API_KEY: 'sk-1', DASHSCOPE_BASE_URL: '', OPENAI_API_KEY: 'other' });
    expect(values).toEqual({ apiKey: 'sk-1' });
    expect(missingField(spec, values)?.env).toBe('DASHSCOPE_BASE_URL');
    expect(baseUrlOf(spec, values)).toBeUndefined();
    expect(missingField(specOf('ollama'), {})).toBeUndefined();
    expect(baseUrlOf(specOf('ollama'), {})).toBe('http://127.0.0.1:11434/v1');
    expect(baseUrlOf(specOf('openai'), { baseUrl: 'http://127.0.0.1:9/v1' })).toBe('http://127.0.0.1:9/v1');
  });

  it('has a price table for every provider, so a new row has to say what it knows', () => {
    expect(Object.keys(PRICES).sort()).toEqual([...PROVIDERS].sort());
  });
});

describe('costOf per provider', () => {
  it('prices Anthropic’s own models at its list price, cache writes at 2x input for the 1 h entries Geno writes', () => {
    expect(costOf('anthropic', 'claude-opus-5-5', million)).toBeCloseTo(4 + 0.2 + 8 + 20);
    expect(costOf('anthropic', 'claude-sonnet-5-5', million)).toBeCloseTo(2 + 0.2 + 4 + 10);
    expect(costOf('anthropic', 'claude-haiku-4-5', million)).toBeCloseTo(1 + 0.1 + 2 + 5);
  });

  it('keeps a model’s price to the provider that charges it', () => {
    expect(costOf('modelstudio', 'qwen3.8-flash', million)).toBeCloseTo(0.15 + 0.15 + 0.1875 + 0.47);
    expect(costOf('openai', 'qwen3.8-flash', million)).toBeNull();
    expect(costOf('anthropic', 'anthropic/claude-opus-5.5', million)).toBeNull();
    expect(costOf('bedrock', 'anthropic.claude-opus-5-5', million)).toBeNull();
  });
});

describe('the classifier choice', () => {
  const anthropicDefault = specOf('anthropic').classifierModel;
  const CASES: readonly (readonly [string, Record<string, string>, { provider: string; model: string | undefined }])[] = [
    ['follows the default provider when nothing is set', {}, { provider: 'modelstudio', model: 'qwen3.8-flash' }],
    ['keeps Model Studio on its flash model whatever the chat model', { GCODE_PROVIDER: 'modelstudio', GCODE_MODEL: 'qwen3.7-plus' }, { provider: 'modelstudio', model: 'qwen3.8-flash' }],
    ['follows chat to Anthropic, on Anthropic’s classifier default', { GCODE_PROVIDER: 'anthropic', GCODE_MODEL: 'claude-sonnet-5-5' }, { provider: 'anthropic', model: anthropicDefault }],
    ['takes a role provider without a model to that provider’s default', { GCODE_PROVIDER: 'modelstudio', GCODE_CLASSIFIER_PROVIDER: 'anthropic' }, { provider: 'anthropic', model: anthropicDefault }],
    ['uses the chat model on a provider with no classifier default', { GCODE_PROVIDER: 'openai', GCODE_MODEL: 'gpt-judge' }, { provider: 'openai', model: 'gpt-judge' }],
    ['never takes the chat model to another provider', { GCODE_PROVIDER: 'anthropic', GCODE_MODEL: 'claude-sonnet-5-5', GCODE_CLASSIFIER_PROVIDER: 'openrouter' }, { provider: 'openrouter', model: 'anthropic/claude-opus-5.5' }],
    ['leaves the model unnamed when nothing names one', { GCODE_PROVIDER: 'anthropic', GCODE_CLASSIFIER_PROVIDER: 'openai' }, { provider: 'openai', model: undefined }],
    ['lets the role’s own settings win', { GCODE_PROVIDER: 'anthropic', GCODE_CLASSIFIER_PROVIDER: 'openai', GCODE_CLASSIFIER_MODEL: 'gpt-x' }, { provider: 'openai', model: 'gpt-x' }],
    ['pairs a named model with the chat provider', { GCODE_PROVIDER: 'anthropic', GCODE_CLASSIFIER_MODEL: 'claude-sonnet-5-5' }, { provider: 'anthropic', model: 'claude-sonnet-5-5' }],
    ['keeps off as off', { GCODE_PROVIDER: 'anthropic', GCODE_CLASSIFIER_MODEL: 'off' }, { provider: 'anthropic', model: 'off' }],
  ];

  it.each(CASES)('%s', (_name, env, choice) => {
    expect(classifierChoiceOf(env)).toEqual(choice);
  });

  it('never sends a Qwen model to Anthropic', () => {
    for (const env of [{ GCODE_PROVIDER: 'anthropic' }, { GCODE_CLASSIFIER_PROVIDER: 'anthropic' }, { GCODE_PROVIDER: 'modelstudio', GCODE_CLASSIFIER_PROVIDER: 'anthropic' }]) {
      expect(classifierChoiceOf(env).model, JSON.stringify(env)).toMatch(/^claude-/);
    }
  });

  it('names a classifier default only from the provider’s own priced models', () => {
    for (const id of PROVIDERS) {
      const model = specOf(id).classifierModel;
      if (model !== undefined) expect(PRICES[id][model], `${id} ${model}`).toBeDefined();
    }
  });
});
