import { DEFAULT_MODELS, isProviderName, PROVIDER_ENV, type ProviderName } from '@g-code/core';

export const SET_KEY_COMMAND = 'gcode.setApiKey';

export type KeySource = 'secret-storage' | 'environment';

/** Which model the engine talks to and with what key, gathered from settings, SecretStorage and the environment. */
export type ModelRuntime = {
  readonly provider: ProviderName;
  /** Undefined for a provider with a fixed endpoint. */
  readonly baseUrl: string | undefined;
  /** Undefined leaves the choice to the engine: GCODE_MODEL, then the provider's default. */
  readonly model: string | undefined;
  readonly key: { readonly source: KeySource; readonly value: string } | undefined;
};

export const PROVIDER_LABELS: Readonly<Record<ProviderName, string>> = { modelstudio: 'Model Studio', openrouter: 'OpenRouter' };

export const secretName = (provider: ProviderName): string => `gcode.apiKey.${provider}`;

type Env = Readonly<Record<string, string | undefined>>;
type Settings = { get<T>(section: string, defaultValue: T): T };
type Secrets = { get(key: string): PromiseLike<string | undefined> };

export function providerOf(settings: Settings): ProviderName {
  const provider = settings.get('provider', 'modelstudio');
  if (!isProviderName(provider)) throw new Error(`gcode.provider is ${provider}, which is not a provider Geno knows`);
  return provider;
}

/** The model a new session would use, named the way the engine chooses it: the setting, GCODE_MODEL, then the provider's default. */
export const modelLabel = (settings: Settings, env: Env): string =>
  settings.get('model', '') || env['GCODE_MODEL'] || DEFAULT_MODELS[providerOf(settings)];

/** A key in SecretStorage wins; one in the environment VS Code was started with is the fallback. */
export async function readModelRuntime(settings: Settings, secrets: Secrets, env: Env): Promise<ModelRuntime> {
  const provider = providerOf(settings);
  const names = PROVIDER_ENV[provider];
  const stored = await secrets.get(secretName(provider));
  const fromEnv = env[names.key];
  const key = stored ? { source: 'secret-storage' as const, value: stored } : fromEnv ? { source: 'environment' as const, value: fromEnv } : undefined;
  const baseUrl = names.baseUrl === undefined ? undefined : settings.get('baseUrl', '') || env[names.baseUrl] || undefined;
  return { provider, baseUrl, model: settings.get('model', '') || undefined, key };
}

/** What stops the engine from reaching the model, and the command that fixes it. */
export type SetupProblem = { readonly message: string; readonly fix: { readonly label: string; readonly command: string; readonly args: unknown[] } };

export function setupProblem(runtime: ModelRuntime): SetupProblem | undefined {
  const label = PROVIDER_LABELS[runtime.provider];
  if (runtime.key === undefined) {
    return { message: `Geno has no ${label} API key. Run Geno: Set API Key.`, fix: { label: 'Set API Key', command: SET_KEY_COMMAND, args: [] } };
  }
  if (PROVIDER_ENV[runtime.provider].baseUrl !== undefined && runtime.baseUrl === undefined) {
    return {
      message: `Geno needs your ${label} endpoint in the gcode.baseUrl setting.`,
      fix: { label: 'Open Settings', command: 'workbench.action.openSettings', args: ['gcode.baseUrl'] },
    };
  }
  return undefined;
}

/** The variables the engine reads; anything left undefined falls through to the environment it inherits. */
export function engineEnv(runtime: ModelRuntime): Record<string, string> {
  const names = PROVIDER_ENV[runtime.provider];
  const values: Record<string, string | undefined> = {
    GCODE_PROVIDER: runtime.provider,
    GCODE_MODEL: runtime.model,
    [names.key]: runtime.key?.value,
    ...(names.baseUrl === undefined ? {} : { [names.baseUrl]: runtime.baseUrl }),
  };
  return Object.fromEntries(Object.entries(values).filter((entry): entry is [string, string] => entry[1] !== undefined));
}

/** For the output channel: everything about the runtime except the key itself. */
export const describeRuntime = (runtime: ModelRuntime): string =>
  `${runtime.provider}, model ${runtime.model ?? 'default'}, key from ${runtime.key?.source ?? 'nowhere'}`;
