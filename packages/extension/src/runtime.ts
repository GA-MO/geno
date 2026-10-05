import {
  isProviderName,
  missingField,
  ROLE_SPECS,
  specOf,
  type FieldId,
  type ProviderField,
  type ProviderName,
  type Role,
} from '@g-code/core';

export const SET_KEY_COMMAND = 'gcode.setApiKey';
export const SETTINGS_COMMAND = 'gcode.chat.settings';

export type KeySource = 'secret-storage' | 'environment' | 'settings';

/** A value and where it came from, so the output channel can say where without saying what. */
export type Supplied = { readonly source: KeySource; readonly value: string };

/** Which model the engine talks to and with what key, gathered from settings, SecretStorage and the environment. */
export type ModelRuntime = {
  readonly provider: ProviderName;
  /** Undefined for a provider with a fixed endpoint. */
  readonly baseUrl: string | undefined;
  /** Undefined leaves the choice to the engine: GCODE_MODEL, then the provider's default. */
  readonly model: string | undefined;
  readonly key: Supplied | undefined;
  /** The provider's other values, such as Bedrock's region and secret key; absent when none is set. */
  readonly more?: Readonly<Partial<Record<FieldId, Supplied>>>;
};

/** Where SecretStorage keeps a secret field; a provider's API key keeps the name it had before the registry. */
export const secretName = (provider: ProviderName, field: FieldId = 'apiKey'): string =>
  field === 'apiKey' ? `gcode.apiKey.${provider}` : `gcode.apiKey.${provider}.${field}`;

/** The setting a non-secret field lives in: Model Studio's endpoint keeps `gcode.baseUrl`, the rest share `gcode.providers`. */
export const settingKey = (provider: ProviderName, field: FieldId): string =>
  provider === 'modelstudio' && field === 'baseUrl' ? 'gcode.baseUrl' : 'gcode.providers';

type Env = Readonly<Record<string, string | undefined>>;
export type Settings = {
  get<T>(section: string, defaultValue: T): T;
  inspect<T>(section: string): { readonly globalValue?: T | undefined } | undefined;
};
type Secrets = { get(key: string): PromiseLike<string | undefined> };

export type ProviderSettings = Readonly<Partial<Record<ProviderName, Readonly<Partial<Record<FieldId, string>>>>>>;

/**
 * A non-secret field's value from the user's own settings. Workspace values are never read: a base URL from a
 * repository's settings.json would send the user's key wherever its author chose.
 */
function userValue(settings: Settings, provider: ProviderName, field: FieldId): string | undefined {
  const key = settingKey(provider, field).slice('gcode.'.length);
  if (key === 'baseUrl') return settings.inspect<string>(key)?.globalValue || undefined;
  const value = settings.inspect<ProviderSettings>(key)?.globalValue?.[provider]?.[field];
  return typeof value === 'string' && value !== '' ? value : undefined;
}

/** A secret in SecretStorage wins over one in the environment VS Code was started with; a setting wins likewise. */
async function supplied(provider: ProviderName, field: ProviderField, settings: Settings, secrets: Secrets, env: Env): Promise<Supplied | undefined> {
  const stored = field.secret ? await secrets.get(secretName(provider, field.id)) : userValue(settings, provider, field.id);
  if (stored) return { source: field.secret ? 'secret-storage' : 'settings', value: stored };
  const inherited = env[field.env];
  return inherited ? { source: 'environment', value: inherited } : undefined;
}

export async function providerRuntime(provider: ProviderName, model: string | undefined, settings: Settings, secrets: Secrets, env: Env): Promise<ModelRuntime> {
  const values: Partial<Record<FieldId, Supplied>> = {};
  for (const field of specOf(provider).fields) {
    const value = await supplied(provider, field, settings, secrets, env);
    if (value !== undefined) values[field.id] = value;
  }
  const { apiKey, baseUrl, ...more } = values;
  return { provider, baseUrl: baseUrl?.value, model, key: apiKey, ...(Object.keys(more).length === 0 ? {} : { more }) };
}

export function providerOf(settings: Settings): ProviderName {
  const provider = settings.get('provider', 'modelstudio');
  if (!isProviderName(provider)) throw new Error(`gcode.provider is ${provider}, which is not a provider Geno knows`);
  return provider;
}

/** The model a new session would use, named the way the engine chooses it: the setting, GCODE_MODEL, then the provider's default. */
export const modelLabel = (settings: Settings, env: Env): string =>
  settings.get('model', '') || env['GCODE_MODEL'] || specOf(providerOf(settings)).defaultModel || 'no model chosen';

/** The chat role's runtime: `gcode.provider` and `gcode.model`. */
export async function readModelRuntime(settings: Settings, secrets: Secrets, env: Env): Promise<ModelRuntime> {
  return providerRuntime(providerOf(settings), settings.get('model', '') || undefined, settings, secrets, env);
}

const valuesOf = (runtime: ModelRuntime): Partial<Record<FieldId, Supplied>> => ({
  ...(runtime.key === undefined ? {} : { apiKey: runtime.key }),
  ...(runtime.baseUrl === undefined ? {} : { baseUrl: { source: 'settings' as const, value: runtime.baseUrl } }),
  ...runtime.more,
});

/** What stops the engine from reaching the model, and the command that fixes it. */
export type SetupProblem = { readonly message: string; readonly fix: { readonly label: string; readonly command: string; readonly args: unknown[] } };

export function setupProblem(runtime: ModelRuntime): SetupProblem | undefined {
  const spec = specOf(runtime.provider);
  const values = Object.fromEntries(Object.entries(valuesOf(runtime)).map(([id, value]) => [id, value.value]));
  const missing = missingField(spec, values);
  if (missing === undefined) return undefined;
  if (missing.id === 'apiKey') {
    return { message: `Geno has no ${spec.label} API key. Run Geno: Set API Key.`, fix: { label: 'Set API Key', command: SET_KEY_COMMAND, args: [] } };
  }
  if (runtime.provider === 'modelstudio' && missing.id === 'baseUrl') {
    return {
      message: `Geno needs your ${spec.label} endpoint in the gcode.baseUrl setting.`,
      fix: { label: 'Open Settings', command: 'workbench.action.openSettings', args: ['gcode.baseUrl'] },
    };
  }
  return {
    message: `Geno needs your ${spec.label} ${missing.label.toLowerCase().replace(/\b(id|url)\b/g, (word) => word.toUpperCase())}. Set it in Geno’s settings.`,
    fix: { label: 'Open Geno Settings', command: SETTINGS_COMMAND, args: [] },
  };
}

/** The variables the engine reads; anything left undefined falls through to the environment it inherits. */
export function engineEnv(runtime: ModelRuntime): Record<string, string> {
  const spec = specOf(runtime.provider);
  const env: Record<string, string> = { GCODE_PROVIDER: runtime.provider };
  if (runtime.model !== undefined) env['GCODE_MODEL'] = runtime.model;
  for (const [id, value] of Object.entries(valuesOf(runtime))) env[spec.fields.find((field) => field.id === id)!.env] = value.value;
  return env;
}

/** For the output channel: everything about the runtime except the key itself. */
export const describeRuntime = (runtime: ModelRuntime): string =>
  `${runtime.provider}, model ${runtime.model ?? 'default'}, key from ${runtime.key?.source ?? 'nowhere'}`;

/** The roles a setting can move to another provider; chat stays on `gcode.provider`, and Tab on its own llama-server. */
export const PROVIDER_ROLES = ['classifier', 'explore'] as const satisfies readonly Role[];
export type ProviderRole = (typeof PROVIDER_ROLES)[number];

export type RoleSettings = Readonly<Partial<Record<ProviderRole, { readonly provider?: unknown; readonly model?: unknown }>>>;

export type EngineRuntime = {
  readonly chat: ModelRuntime;
  readonly roles: readonly { readonly role: ProviderRole; readonly runtime: ModelRuntime }[];
};

/** The chat runtime, and one for each role `gcode.roles` maps; a role it leaves out keeps the engine's default. */
export async function readEngineRuntime(settings: Settings, secrets: Secrets, env: Env): Promise<EngineRuntime> {
  const chat = await readModelRuntime(settings, secrets, env);
  const mapped = settings.get<RoleSettings>('roles', {});
  const roles: { role: ProviderRole; runtime: ModelRuntime }[] = [];
  for (const role of PROVIDER_ROLES) {
    const choice = mapped[role];
    if (choice === undefined) continue;
    const provider = String(choice.provider);
    if (!isProviderName(provider)) throw new Error(`gcode.roles.${role} names ${provider}, which is not a provider Geno knows`);
    const model = typeof choice.model === 'string' && choice.model !== '' ? choice.model : undefined;
    roles.push({ role, runtime: await providerRuntime(provider, model, settings, secrets, env) });
  }
  return { chat, roles };
}

/** The engine's variables for every role: each role's provider values, its provider and model, then chat's. */
export function engineEnvOf({ chat, roles }: EngineRuntime): Record<string, string> {
  const env: Record<string, string> = {};
  for (const { role, runtime } of roles) {
    const { GCODE_PROVIDER: _provider, GCODE_MODEL: _model, ...values } = engineEnv(runtime);
    const names = ROLE_SPECS[role].env!;
    Object.assign(env, values, { [names.provider]: runtime.provider }, runtime.model === undefined ? {} : { [names.model]: runtime.model });
  }
  return { ...env, ...engineEnv(chat) };
}

export const describeEngineRuntime = ({ chat, roles }: EngineRuntime): string =>
  [describeRuntime(chat), ...roles.map(({ role, runtime }) => `${role}: ${describeRuntime(runtime)}`)].join('; ');
