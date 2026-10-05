import { spawn } from 'node:child_process';
import * as vscode from 'vscode';
import { isProviderName, missingField, PROVIDERS, ROLE_SPECS, ROLES, specOf, type FieldId, type ProviderField, type ProviderName } from '@g-code/core';
import {
  engineEnv,
  PROVIDER_ROLES,
  providerOf,
  providerRuntime,
  secretName,
  suppliedValues,
  userValue,
  type ProviderRole,
  type ProviderSettings,
  type RoleSettings,
} from '../runtime.js';
import type { FieldView, ProviderView, RoleView, SettingsFromView, SettingsListing, SettingsToView, TestState } from './settings-model.js';

/** Long enough for a cold model behind the engine's own 30 seconds. */
const CLI_TIMEOUT_MS = 40_000;

const TAB_SERVER = 'Local llama-server (gcode.tab.endpoint)';

const config = () => vscode.workspace.getConfiguration('gcode');

/** The provider and field a message names, when the provider has that field and it is (or is not) a secret. */
function fieldOf(rawProvider: string, rawField: string, secret: boolean): { readonly provider: ProviderName; readonly field: ProviderField } | undefined {
  if (!isProviderName(rawProvider)) return undefined;
  const field = specOf(rawProvider).fields.find((f) => f.id === rawField && f.secret === secret);
  return field === undefined ? undefined : { provider: rawProvider, field };
}

type CliReport = { readonly ok: boolean; readonly error?: string; readonly reply?: string; readonly latencyMs?: number; readonly models?: string[]; readonly model?: string };

/**
 * The extension's half of the settings page. Keys go from the page into SecretStorage and never back: the page
 * learns only whether each is set. Base URLs and other values go to the user's settings, never the workspace's.
 * Testing a connection and listing models run the bundled engine's `gcode providers`, which gets the key the
 * way the chat engine does, in its environment.
 */
export class SettingsPage implements vscode.Disposable {
  private shown = false;
  private readonly subscriptions: vscode.Disposable[];

  constructor(
    private readonly secrets: vscode.SecretStorage,
    private readonly cliPath: string,
    private readonly output: vscode.OutputChannel,
    private readonly post: (message: SettingsToView) => void,
  ) {
    this.subscriptions = [
      secrets.onDidChange(() => this.refresh()),
      vscode.workspace.onDidChangeConfiguration((event) => {
        if (event.affectsConfiguration('gcode')) this.refresh();
      }),
    ];
  }

  private refresh(): void {
    if (this.shown) void this.listing().then((listing) => this.post({ type: 'settings', listing }));
  }

  async listing(): Promise<SettingsListing> {
    const settings = config();
    const chat = providerOf(settings);
    const providers = await Promise.all(PROVIDERS.map((id) => this.providerView(id)));
    const mapped = settings.get<RoleSettings>('roles', {});
    const roles = ROLES.map((role): RoleView => {
      const label = ROLE_SPECS[role].label;
      if (role === 'tab') return { role, label, kind: 'fixed', text: TAB_SERVER };
      if (role === 'chat') return { role, label, kind: 'provider', provider: chat, model: settings.get('model', '') };
      const choice = mapped[role];
      const provider = typeof choice?.provider === 'string' && isProviderName(choice.provider) ? choice.provider : undefined;
      return { role, label, kind: 'provider', provider, model: typeof choice?.model === 'string' ? choice.model : '' };
    });
    return { providers, roles, chat };
  }

  private async providerView(id: ProviderName): Promise<ProviderView> {
    const spec = specOf(id);
    const settings = config();
    const values = await suppliedValues(id, settings, this.secrets, process.env);
    const fields = spec.fields.map((field): FieldView => {
      const common = { id: field.id, label: field.label, hint: field.hint, required: field.required };
      const value = values[field.id];
      if (field.secret) return { ...common, secret: true, set: value?.source === 'settings' ? undefined : value?.source };
      return { ...common, secret: false, value: userValue(settings, id, field.id) ?? '', fromEnv: value?.source === 'environment' };
    });
    const plain = Object.fromEntries(Object.entries(values).map(([key, value]) => [key, value.value]));
    return {
      id,
      label: spec.label,
      adapter: spec.adapter,
      listsModels: spec.listsModels,
      defaultModel: spec.defaultModel,
      fields,
      needs: missingField(spec, plain)?.label,
      touched: Object.keys(values).length > 0,
    };
  }

  readonly handlers: { readonly [K in SettingsFromView['type']]: (message: Extract<SettingsFromView, { type: K }>) => void } = {
    'settings-list': () => {
      this.shown = true;
      this.refresh();
    },
    'settings-secret': ({ provider, field, value }) => {
      const target = fieldOf(provider, field, true);
      if (target === undefined || value.trim() === '') return;
      void this.secrets.store(secretName(target.provider, target.field.id), value.trim()).then(
        () => this.output.appendLine(`settings: stored the ${specOf(target.provider).label} ${target.field.label.toLowerCase()}`),
        warn,
      );
    },
    'settings-clear': ({ provider, field }) => {
      const target = fieldOf(provider, field, true);
      if (target !== undefined) void this.secrets.delete(secretName(target.provider, target.field.id)).then(undefined, warn);
    },
    'settings-value': ({ provider, field, value }) => {
      const target = fieldOf(provider, field, false);
      if (target !== undefined) void setUserValue(target.provider, target.field.id, value.trim()).then(undefined, warn);
    },
    'settings-role': ({ role, provider, model }) => void setRole(role, provider, model.trim()).then(undefined, warn),
    'settings-test': ({ provider }) => {
      if (isProviderName(provider)) void this.test(provider);
    },
    'settings-list-models': ({ provider }) => {
      if (isProviderName(provider)) void this.models(provider);
    },
  };

  /** The model a test uses: the one a role runs on this provider, else the provider's default. */
  private modelFor(provider: ProviderName): string | undefined {
    const settings = config();
    if (providerOf(settings) === provider && settings.get('model', '')) return settings.get('model', '');
    const mapped = settings.get<RoleSettings>('roles', {});
    const role = PROVIDER_ROLES.map((r) => mapped[r]).find((choice) => choice?.provider === provider && typeof choice.model === 'string' && choice.model !== '');
    return (role?.model as string | undefined) ?? specOf(provider).defaultModel;
  }

  /** One tiny call through the engine. A provider with no model to call but a model listing is tested by listing. */
  private async test(provider: ProviderName): Promise<void> {
    this.post({ type: 'settings-tested', provider, state: { kind: 'running' } });
    const model = this.modelFor(provider);
    let state: TestState;
    if (model === undefined && specOf(provider).listsModels) {
      const report = await this.cli(provider, ['providers', 'models', provider, '--json']);
      state = report.ok ? { kind: 'ok', text: `Connected: ${report.models?.length ?? 0} models` } : { kind: 'failed', text: report.error ?? 'failed' };
    } else if (model === undefined) {
      state = { kind: 'failed', text: `Choose a ${specOf(provider).label} model in Roles first.` };
    } else {
      const report = await this.cli(provider, ['providers', 'test', provider, '--model', model, '--json']);
      state = report.ok
        ? { kind: 'ok', text: `Connected to ${model} in ${report.latencyMs} ms${report.reply ? `: “${report.reply}”` : ''}` }
        : { kind: 'failed', text: report.error ?? 'failed' };
    }
    this.output.appendLine(`settings: tested ${provider}: ${state.kind}`);
    this.post({ type: 'settings-tested', provider, state });
  }

  private async models(provider: ProviderName): Promise<void> {
    this.post({ type: 'settings-models', provider, state: { kind: 'loading' } });
    const report = await this.cli(provider, ['providers', 'models', provider, '--json']);
    this.post({ type: 'settings-models', provider, state: report.ok ? { kind: 'loaded', models: report.models ?? [] } : { kind: 'failed', text: report.error ?? 'failed' } });
  }

  /** Runs the bundled engine's CLI with this provider's values in its environment, and reads its JSON report. */
  private async cli(provider: ProviderName, args: readonly string[]): Promise<CliReport> {
    const { GCODE_PROVIDER: _provider, GCODE_MODEL: _model, ...values } = engineEnv(await providerRuntime(provider, undefined, config(), this.secrets, process.env));
    return new Promise((resolve) => {
      const child = spawn(process.execPath, [this.cliPath, ...args], {
        env: { ...process.env, ...values, ELECTRON_RUN_AS_NODE: '1' },
        stdio: ['ignore', 'pipe', 'pipe'],
        timeout: CLI_TIMEOUT_MS,
      });
      let stdout = '';
      child.stdout.setEncoding('utf8').on('data', (chunk: string) => (stdout += chunk));
      child.stderr.setEncoding('utf8').on('data', (chunk: string) => this.output.append(chunk));
      child.on('error', (error) => resolve({ ok: false, error: error.message }));
      child.on('close', () => {
        try {
          resolve(JSON.parse(stdout.trim().split('\n').at(-1) ?? '') as CliReport);
        } catch {
          resolve({ ok: false, error: 'the engine gave no answer' });
        }
      });
    });
  }

  dispose(): void {
    for (const subscription of this.subscriptions) subscription.dispose();
  }
}

const warn = (error: unknown) => void vscode.window.showWarningMessage(error instanceof Error ? error.message : String(error));

/** Writes a non-secret field to the user's settings; an empty value removes it. */
async function setUserValue(provider: ProviderName, field: FieldId, value: string): Promise<void> {
  if (provider === 'modelstudio' && field === 'baseUrl') return config().update('baseUrl', value === '' ? undefined : value, vscode.ConfigurationTarget.Global);
  const current = config().inspect<ProviderSettings>('providers')?.globalValue ?? {};
  const { [field]: _old, ...rest } = current[provider] ?? {};
  const next = value === '' ? rest : { ...rest, [field]: value };
  const { [provider]: _was, ...others } = current;
  await config().update('providers', Object.keys(next).length === 0 ? others : { ...others, [provider]: next }, vscode.ConfigurationTarget.Global);
}

/** Chat is `gcode.provider` and `gcode.model`; the other roles live in `gcode.roles`. An empty provider unmaps a role. */
async function setRole(role: string, provider: string, model: string): Promise<void> {
  if (role === 'chat') {
    if (!isProviderName(provider)) return;
    await config().update('provider', provider, vscode.ConfigurationTarget.Global);
    await config().update('model', model === '' ? undefined : model, vscode.ConfigurationTarget.Global);
    return;
  }
  if (!(PROVIDER_ROLES as readonly string[]).includes(role)) return;
  const current = config().inspect<RoleSettings>('roles')?.globalValue ?? {};
  const { [role as ProviderRole]: _was, ...others } = current;
  const next = isProviderName(provider) ? { ...others, [role]: model === '' ? { provider } : { provider, model } } : others;
  await config().update('roles', Object.keys(next).length === 0 ? undefined : next, vscode.ConfigurationTarget.Global);
}
