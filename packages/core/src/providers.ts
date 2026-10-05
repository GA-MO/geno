/**
 * Every model provider Geno can talk to, as one table: a new provider is a new row. The engine builds a client
 * from a row and the values its fields name; the editor builds its settings page and the engine's environment
 * from the same rows.
 */

export const PROVIDERS = [
  'openrouter',
  'modelstudio',
  'anthropic',
  'bedrock',
  'vertex',
  'openai',
  'azure-openai',
  'gemini',
  'deepseek',
  'groq',
  'cerebras',
  'xai',
  'mistral',
  'ollama',
  'lmstudio',
] as const;
export type ProviderName = (typeof PROVIDERS)[number];
export const isProviderName = (raw: string): raw is ProviderName => (PROVIDERS as readonly string[]).includes(raw);

/** The wire format: Anthropic Messages, or OpenAI Chat Completions. */
export const ADAPTERS = ['anthropic', 'openai'] as const;
export type Adapter = (typeof ADAPTERS)[number];

/**
 * How a request proves who sent it. `aws` signs with SigV4 through Anthropic's Bedrock client, and `google` uses
 * an access token or Google's application default credentials through Anthropic's Vertex client.
 */
export type KeyScheme =
  | { readonly kind: 'header'; readonly header: 'authorization'; readonly scheme: 'Bearer' }
  | { readonly kind: 'header'; readonly header: 'x-api-key' | 'api-key'; readonly scheme: undefined }
  | { readonly kind: 'aws' }
  | { readonly kind: 'google' };

export const FIELD_IDS = ['apiKey', 'baseUrl', 'region', 'profile', 'project', 'accessKeyId', 'secretAccessKey', 'sessionToken', 'accessToken'] as const;
export type FieldId = (typeof FIELD_IDS)[number];

/**
 * One value the user supplies. A secret lives only in VS Code's SecretStorage or the user's environment, and
 * never in settings, a log or the session log; the rest are user settings, never workspace ones. The engine
 * reads every field from `env`.
 */
export type ProviderField = {
  readonly id: FieldId;
  readonly env: string;
  readonly label: string;
  readonly secret: boolean;
  readonly required: boolean;
  /** What to put in it, for a placeholder or an error. */
  readonly hint: string;
};

export type ProviderSpec = {
  readonly id: ProviderName;
  readonly label: string;
  readonly adapter: Adapter;
  readonly key: KeyScheme;
  /** Undefined when the user must give one, or when the platform client derives it from the region. */
  readonly defaultBaseUrl: string | undefined;
  readonly fields: readonly ProviderField[];
  /** Whether the provider answers a model listing, for the settings page's picker. */
  readonly listsModels: boolean;
  /** Undefined when Geno cannot know which models the user has, so they pick one. */
  readonly defaultModel: string | undefined;
  /** A header carrying the session id, which OpenRouter uses to route a session to the provider holding its cache. */
  readonly sessionHeader: string | undefined;
};

const apiKey = (env: string, required = true): ProviderField => ({ id: 'apiKey', env, label: 'API key', secret: true, required, hint: 'your API key' });
const baseUrl = (env: string, hint: string, required = false): ProviderField => ({ id: 'baseUrl', env, label: 'Base URL', secret: false, required, hint });
const BEARER: KeyScheme = { kind: 'header', header: 'authorization', scheme: 'Bearer' };

/** An OpenAI-compatible provider: a Bearer key and a fixed endpoint that lists its models. */
function openaiCompatible<P extends ProviderName>(id: P, label: string, keyEnv: string, url: string, keyRequired = true): ProviderSpec & { readonly id: P } {
  return {
    id,
    label,
    adapter: 'openai',
    key: BEARER,
    defaultBaseUrl: url,
    fields: [apiKey(keyEnv, keyRequired), baseUrl(baseUrlEnv(id), url)],
    listsModels: true,
    defaultModel: undefined,
    sessionHeader: undefined,
  };
}

/** Where the CLI reads a provider's base URL override; Model Studio keeps the name it had before the registry. */
const baseUrlEnv = (id: ProviderName): string => `GCODE_${id.toUpperCase().replace(/-/g, '_')}_BASE_URL`;

export const PROVIDER_SPECS: { readonly [P in ProviderName]: ProviderSpec & { readonly id: P } } = {
  openrouter: {
    id: 'openrouter',
    label: 'OpenRouter',
    adapter: 'anthropic',
    key: BEARER,
    defaultBaseUrl: 'https://openrouter.ai/api',
    fields: [apiKey('OPENROUTER_API_KEY'), baseUrl(baseUrlEnv('openrouter'), 'https://openrouter.ai/api')],
    listsModels: true,
    defaultModel: 'anthropic/claude-opus-5.5',
    sessionHeader: 'x-session-id',
  },
  modelstudio: {
    id: 'modelstudio',
    label: 'Model Studio',
    adapter: 'anthropic',
    key: BEARER,
    // The URL embeds the workspace id and region, and keys only work in their own region.
    defaultBaseUrl: undefined,
    fields: [apiKey('DASHSCOPE_API_KEY'), baseUrl('DASHSCOPE_BASE_URL', 'your Model Studio Anthropic endpoint', true)],
    listsModels: false,
    defaultModel: 'qwen3.8-flash',
    sessionHeader: undefined,
  },
  anthropic: {
    id: 'anthropic',
    label: 'Anthropic',
    adapter: 'anthropic',
    key: { kind: 'header', header: 'x-api-key', scheme: undefined },
    defaultBaseUrl: 'https://api.anthropic.com',
    fields: [apiKey('ANTHROPIC_API_KEY'), baseUrl(baseUrlEnv('anthropic'), 'https://api.anthropic.com')],
    listsModels: true,
    defaultModel: 'claude-opus-5-5',
    sessionHeader: undefined,
  },
  bedrock: {
    id: 'bedrock',
    label: 'Amazon Bedrock',
    adapter: 'anthropic',
    key: { kind: 'aws' },
    defaultBaseUrl: undefined,
    // With neither keys nor a profile, the AWS client falls back to its default credential chain.
    fields: [
      { id: 'region', env: 'AWS_REGION', label: 'Region', secret: false, required: true, hint: 'us-east-1' },
      { id: 'accessKeyId', env: 'AWS_ACCESS_KEY_ID', label: 'Access key ID', secret: true, required: false, hint: 'or leave empty and name a profile' },
      { id: 'secretAccessKey', env: 'AWS_SECRET_ACCESS_KEY', label: 'Secret access key', secret: true, required: false, hint: 'with the access key ID' },
      { id: 'sessionToken', env: 'AWS_SESSION_TOKEN', label: 'Session token', secret: true, required: false, hint: 'for temporary credentials' },
      { id: 'profile', env: 'AWS_PROFILE', label: 'Profile', secret: false, required: false, hint: 'a profile in ~/.aws/config' },
      baseUrl(baseUrlEnv('bedrock'), 'https://bedrock-mantle.<region>.api.aws/anthropic'),
    ],
    listsModels: false,
    defaultModel: 'anthropic.claude-opus-5-5',
    sessionHeader: undefined,
  },
  vertex: {
    id: 'vertex',
    label: 'Google Vertex AI',
    adapter: 'anthropic',
    key: { kind: 'google' },
    defaultBaseUrl: undefined,
    // With no access token, the Vertex client uses Google's application default credentials.
    fields: [
      { id: 'project', env: 'ANTHROPIC_VERTEX_PROJECT_ID', label: 'Project ID', secret: false, required: true, hint: 'your Google Cloud project' },
      { id: 'region', env: 'CLOUD_ML_REGION', label: 'Region', secret: false, required: true, hint: 'global' },
      { id: 'accessToken', env: 'GCODE_VERTEX_ACCESS_TOKEN', label: 'Access token', secret: true, required: false, hint: 'or leave empty to use gcloud application default credentials' },
      baseUrl(baseUrlEnv('vertex'), 'https://<region>-aiplatform.googleapis.com/v1'),
    ],
    listsModels: false,
    defaultModel: 'claude-opus-5-5',
    sessionHeader: undefined,
  },
  openai: openaiCompatible('openai', 'OpenAI', 'OPENAI_API_KEY', 'https://api.openai.com/v1'),
  'azure-openai': {
    id: 'azure-openai',
    label: 'Azure OpenAI',
    adapter: 'openai',
    key: { kind: 'header', header: 'api-key', scheme: undefined },
    defaultBaseUrl: undefined,
    fields: [apiKey('AZURE_OPENAI_API_KEY'), baseUrl(baseUrlEnv('azure-openai'), 'https://<resource>.openai.azure.com/openai/v1', true)],
    listsModels: true,
    defaultModel: undefined,
    sessionHeader: undefined,
  },
  gemini: openaiCompatible('gemini', 'Google Gemini', 'GEMINI_API_KEY', 'https://generativelanguage.googleapis.com/v1beta/openai'),
  deepseek: openaiCompatible('deepseek', 'DeepSeek', 'DEEPSEEK_API_KEY', 'https://api.deepseek.com/v1'),
  groq: openaiCompatible('groq', 'Groq', 'GROQ_API_KEY', 'https://api.groq.com/openai/v1'),
  cerebras: openaiCompatible('cerebras', 'Cerebras', 'CEREBRAS_API_KEY', 'https://api.cerebras.ai/v1'),
  xai: openaiCompatible('xai', 'xAI', 'XAI_API_KEY', 'https://api.x.ai/v1'),
  mistral: openaiCompatible('mistral', 'Mistral', 'MISTRAL_API_KEY', 'https://api.mistral.ai/v1'),
  // Local servers take no key unless the user put one in front of them.
  ollama: openaiCompatible('ollama', 'Ollama', 'OLLAMA_API_KEY', 'http://127.0.0.1:11434/v1', false),
  lmstudio: openaiCompatible('lmstudio', 'LM Studio', 'LMSTUDIO_API_KEY', 'http://127.0.0.1:1234/v1', false),
};

export const specOf = (provider: ProviderName): ProviderSpec => PROVIDER_SPECS[provider];

export type ProviderValues = Readonly<Partial<Record<FieldId, string>>>;

/** The provider's values as `env` holds them; an empty variable counts as unset. */
export function providerValues(spec: ProviderSpec, env: Readonly<Record<string, string | undefined>>): ProviderValues {
  return Object.fromEntries(spec.fields.flatMap((field) => (env[field.env] ? [[field.id, env[field.env]!]] : [])));
}

/** The first required field without a value, which names what the user still has to set. */
export const missingField = (spec: ProviderSpec, values: ProviderValues): ProviderField | undefined =>
  spec.fields.find((field) => field.required && values[field.id] === undefined);

export const fieldOf = (spec: ProviderSpec, id: FieldId): ProviderField | undefined => spec.fields.find((field) => field.id === id);

export const baseUrlOf = (spec: ProviderSpec, values: ProviderValues): string | undefined => values.baseUrl ?? spec.defaultBaseUrl;

/** Every variable that holds a provider credential, so nothing hands one to a child process or an MCP server. */
export const SECRET_ENV_NAMES: readonly string[] = [
  ...new Set(PROVIDERS.flatMap((id) => PROVIDER_SPECS[id].fields.filter((field) => field.secret).map((field) => field.env))),
];

/**
 * What each part of Geno runs on. A role with `env` takes a provider and model; Tab runs on the local llama-server
 * its own `gcode.tab.*` settings name, since it needs a fill-in-the-middle model rather than a chat one.
 */
export const ROLES = ['chat', 'classifier', 'explore', 'tab'] as const;
export type Role = (typeof ROLES)[number];

export type RoleSpec = {
  readonly label: string;
  readonly env: { readonly provider: string; readonly model: string } | undefined;
};

export const ROLE_SPECS: { readonly [R in Role]: RoleSpec } = {
  chat: { label: 'Chat', env: { provider: 'GCODE_PROVIDER', model: 'GCODE_MODEL' } },
  classifier: { label: 'Auto-mode classifier', env: { provider: 'GCODE_CLASSIFIER_PROVIDER', model: 'GCODE_CLASSIFIER_MODEL' } },
  // Read by the explore helper once it exists; until then nothing reads it.
  explore: { label: 'Explore helper', env: { provider: 'GCODE_EXPLORE_PROVIDER', model: 'GCODE_EXPLORE_MODEL' } },
  tab: { label: 'Tab', env: undefined },
};

export type RoleChoice = { readonly provider: ProviderName; readonly model: string | undefined };
