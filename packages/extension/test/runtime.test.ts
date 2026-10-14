import { describe, expect, it } from 'vitest';
import { describeEngineRuntime, describeRuntime, engineEnv, engineEnvOf, readEngineRuntime, readModelRuntime, resumeEnvOf, sandboxEnvOf, searchSecretName, secretName, settingKey, setupProblem, unreachableNotice } from '../src/runtime.js';

/** Settings as the user set them; `workspace` holds what a workspace's settings.json says, which may differ. */
const settingsOf = (values: Record<string, unknown>, workspace: Record<string, unknown> = {}) => ({
  get: <T>(key: string, fallback: T): T => ((workspace[key] ?? values[key]) as T | undefined) ?? fallback,
  inspect: <T>(key: string) => ({ globalValue: values[key] as T | undefined, workspaceValue: workspace[key] as T | undefined }),
});
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

describe('every provider’s runtime', () => {
  it('keeps the existing secret names, and names one per extra secret field', () => {
    expect(secretName('modelstudio')).toBe('gcode.apiKey.modelstudio');
    expect(secretName('openai', 'apiKey')).toBe('gcode.apiKey.openai');
    expect(secretName('bedrock', 'secretAccessKey')).toBe('gcode.apiKey.bedrock.secretAccessKey');
    expect(settingKey('modelstudio', 'baseUrl')).toBe('gcode.baseUrl');
    expect(settingKey('bedrock', 'region')).toBe('gcode.providers');
  });

  it('hands the engine Bedrock’s keys from SecretStorage and its region from the user settings', async () => {
    const runtime = await readModelRuntime(
      settingsOf({ provider: 'bedrock', providers: { bedrock: { region: 'eu-west-1' } } }),
      secretsOf({ 'gcode.apiKey.bedrock.accessKeyId': 'AKIA-STORED', 'gcode.apiKey.bedrock.secretAccessKey': 'aws-secret-stored' }),
      { AWS_REGION: 'us-east-1' },
    );
    expect(setupProblem(runtime)).toBeUndefined();
    expect(engineEnv(runtime)).toEqual({
      GCODE_PROVIDER: 'bedrock',
      AWS_REGION: 'eu-west-1',
      AWS_ACCESS_KEY_ID: 'AKIA-STORED',
      AWS_SECRET_ACCESS_KEY: 'aws-secret-stored',
    });
    expect(describeRuntime(runtime)).not.toContain('aws-secret-stored');

    const regionless = await readModelRuntime(settingsOf({ provider: 'bedrock' }), secretsOf({}), {});
    expect(setupProblem(regionless)).toEqual({
      message: 'Geno needs your Amazon Bedrock region. Set it in Geno’s settings.',
      fix: { label: 'Open Geno Settings', command: 'gcode.chat.settings', args: [] },
    });
  });

  it('never takes a base URL from the workspace’s settings, which whoever wrote the repository chose', async () => {
    const runtime = await readModelRuntime(
      settingsOf(
        { provider: 'openai', providers: { openai: { baseUrl: 'https://mine.example.com/v1' } } },
        { providers: { openai: { baseUrl: 'https://attacker.example.com/v1' } }, baseUrl: 'https://attacker.example.com' },
      ),
      secretsOf({ 'gcode.apiKey.openai': 'sk-openai' }),
      {},
    );
    expect(engineEnv(runtime)).toEqual({ GCODE_PROVIDER: 'openai', OPENAI_API_KEY: 'sk-openai', GCODE_OPENAI_BASE_URL: 'https://mine.example.com/v1' });

    const modelstudio = await readModelRuntime(settingsOf({}, { baseUrl: 'https://attacker.example.com' }), secretsOf({ 'gcode.apiKey.modelstudio': STORED }), {});
    expect(modelstudio.baseUrl).toBeUndefined();
    expect(JSON.stringify(engineEnv(modelstudio))).not.toContain('attacker');
  });

  it('hands the engine every provider’s values the user set, so an older chat goes on running on its own provider', async () => {
    const settings = settingsOf({ provider: 'anthropic', model: 'claude-sonnet-5-5', baseUrl: URL, providers: { bedrock: { region: 'eu-west-1' } } });
    const secrets = secretsOf({ 'gcode.apiKey.anthropic': 'sk-ant-stored', 'gcode.apiKey.modelstudio': STORED, 'gcode.apiKey.openai': 'sk-openai-stored' });
    const engine = await readEngineRuntime(settings, secrets, {});
    expect(engineEnvOf(engine)).toEqual({
      GCODE_PROVIDER: 'anthropic',
      GCODE_MODEL: 'claude-sonnet-5-5',
      ANTHROPIC_API_KEY: 'sk-ant-stored',
      DASHSCOPE_API_KEY: STORED,
      DASHSCOPE_BASE_URL: URL,
      AWS_REGION: 'eu-west-1',
      OPENAI_API_KEY: 'sk-openai-stored',
    });
    const described = describeEngineRuntime(engine);
    expect(described).toBe(
      'anthropic, model claude-sonnet-5-5, key from secret-storage; also: modelstudio, apiKey from secret-storage, baseUrl from settings; also: bedrock, region from settings; also: openai, apiKey from secret-storage',
    );
    for (const secret of ['sk-ant-stored', STORED, 'sk-openai-stored']) expect(described).not.toContain(secret);
  });

  it('maps the classifier and explore roles to their own provider and model, with that provider’s key', async () => {
    const engine = await readEngineRuntime(
      settingsOf({ baseUrl: URL, roles: { classifier: { provider: 'openai', model: 'gpt-judge' }, explore: { provider: 'modelstudio', model: 'qwen3.7-plus' } } }),
      secretsOf({ 'gcode.apiKey.modelstudio': STORED, 'gcode.apiKey.openai': 'sk-openai-stored' }),
      {},
    );
    expect(engineEnvOf(engine)).toEqual({
      GCODE_PROVIDER: 'modelstudio',
      DASHSCOPE_API_KEY: STORED,
      DASHSCOPE_BASE_URL: URL,
      GCODE_CLASSIFIER_PROVIDER: 'openai',
      GCODE_CLASSIFIER_MODEL: 'gpt-judge',
      OPENAI_API_KEY: 'sk-openai-stored',
      GCODE_EXPLORE_PROVIDER: 'modelstudio',
      GCODE_EXPLORE_MODEL: 'qwen3.7-plus',
    });
    const described = describeEngineRuntime(engine);
    expect(described).toBe('modelstudio, model default, key from secret-storage; classifier: openai, model gpt-judge, key from secret-storage; explore: modelstudio, model qwen3.7-plus, key from secret-storage');
    expect(described).not.toContain('sk-openai-stored');
  });

  it('asks for a model when the provider has no default and none is set', async () => {
    const runtime = await readModelRuntime(settingsOf({ provider: 'openai' }), secretsOf({ 'gcode.apiKey.openai': 'sk-openai' }), {});
    expect(setupProblem(runtime)).toEqual({
      message: 'Geno needs a model for OpenAI. Choose one in Geno’s settings.',
      fix: { label: 'Open Geno Settings', command: 'gcode.chat.settings', args: [] },
    });
    expect(setupProblem(runtime, { GCODE_MODEL: 'gpt-x' })).toBeUndefined();
    expect(setupProblem({ ...runtime, model: 'gpt-x' })).toBeUndefined();
  });

  it('passes a search key from SecretStorage, else from the environment, and never names it', async () => {
    const settings = settingsOf({ baseUrl: URL });
    expect(searchSecretName('brave')).toBe('gcode.apiKey.search.brave');
    const stored = await readEngineRuntime(settings, secretsOf({ 'gcode.apiKey.modelstudio': STORED, 'gcode.apiKey.search.brave': 'brave-stored' }), { BRAVE_SEARCH_API_KEY: 'brave-env' });
    expect(engineEnvOf(stored)).toMatchObject({ BRAVE_SEARCH_API_KEY: 'brave-stored', GCODE_PROVIDER: 'modelstudio' });
    expect(describeEngineRuntime(stored)).toBe('modelstudio, model default, key from secret-storage; search: brave, key from secret-storage');
    const inherited = await readEngineRuntime(settings, secretsOf({ 'gcode.apiKey.modelstudio': STORED }), { BRAVE_SEARCH_API_KEY: 'brave-env' });
    expect(engineEnvOf(inherited)['BRAVE_SEARCH_API_KEY']).toBe('brave-env');
    const none = await readEngineRuntime(settings, secretsOf({ 'gcode.apiKey.modelstudio': STORED }), {});
    expect(Object.keys(engineEnvOf(none))).not.toContain('BRAVE_SEARCH_API_KEY');
  });

  it('refuses a role on a provider it does not know', async () => {
    await expect(readEngineRuntime(settingsOf({ roles: { classifier: { provider: 'nope' } } }), secretsOf({}), {})).rejects.toThrow('gcode.roles.classifier names nope');
  });
});

describe('the sandbox network setting', () => {
  it('B/B-87 passes the user\'s gcode.sandbox.allowedDomains to the engine, says nothing when it is empty, and ignores a workspace value', () => {
    expect(sandboxEnvOf(settingsOf({}))).toEqual({});
    expect(sandboxEnvOf(settingsOf({ 'sandbox.allowedDomains': [] }))).toEqual({});
    expect(sandboxEnvOf(settingsOf({ 'sandbox.allowedDomains': ['registry.npmjs.org', ' *.github.com ', 3, ''] }))).toEqual({ GCODE_SANDBOX_ALLOWED_DOMAINS: 'registry.npmjs.org,*.github.com' });
    expect(sandboxEnvOf(settingsOf({}, { 'sandbox.allowedDomains': ['evil.example'] }))).toEqual({});
  });
});

describe('the limit resume setting', () => {
  it('passes gcode.resume.afterLimit to the engine, short by default, and drops a value the engine would refuse', () => {
    expect(resumeEnvOf(settingsOf({}))).toEqual({ GCODE_RESUME_AFTER_LIMIT: 'short' });
    expect(resumeEnvOf(settingsOf({ 'resume.afterLimit': 'always' }))).toEqual({ GCODE_RESUME_AFTER_LIMIT: 'always' });
    expect(resumeEnvOf(settingsOf({ 'resume.afterLimit': 'sometimes' }))).toEqual({});
  });
});

describe('a chat whose provider has no key here', () => {
  it('names the chat’s provider and model, what a new chat would use, and offers a new chat or the key', () => {
    expect(unreachableNotice({ reason: 'no-credentials', provider: 'modelstudio', model: 'qwen3.8-flash', field: 'apiKey' }, { provider: 'anthropic', model: 'claude-sonnet-5-5' })).toEqual({
      message: 'This chat ran on Model Studio · qwen3.8-flash, and Geno has no Model Studio key. Start a new chat to use Anthropic · claude-sonnet-5-5, or set the Model Studio key.',
      fixes: [
        { label: 'New chat', fix: 'new-chat' },
        { label: 'Set key', fix: 'set-key', provider: 'modelstudio', field: 'apiKey' },
      ],
    });
  });

  it('sends a missing setting, such as the endpoint, to the settings', () => {
    const notice = unreachableNotice({ reason: 'no-credentials', provider: 'modelstudio', model: 'qwen3.8-flash', field: 'baseUrl' }, { provider: 'anthropic', model: 'claude-sonnet-5-5' });
    expect(notice.message).toBe('This chat ran on Model Studio · qwen3.8-flash, and Geno has no Model Studio base URL. Start a new chat to use Anthropic · claude-sonnet-5-5, or set the Model Studio base URL.');
    expect(notice.fixes[1]).toEqual({ label: 'Open settings', fix: 'open-settings' });
  });
});
