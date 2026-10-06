import type { Adapter, FieldId, ProviderName, Role } from '@g-code/core';
import type { AgentsFromView, AgentsToView } from './agents-model.js';

/**
 * A field as the page shows it. A secret carries only whether it is set and where; its value never leaves the
 * extension host. A setting carries the user's own value.
 */
export type FieldView = {
  readonly id: FieldId;
  readonly label: string;
  readonly hint: string;
  readonly required: boolean;
} & ({ readonly secret: true; readonly set: 'secret-storage' | 'environment' | undefined } | { readonly secret: false; readonly value: string; readonly fromEnv: boolean });

export type ProviderView = {
  readonly id: ProviderName;
  readonly label: string;
  readonly adapter: Adapter;
  readonly listsModels: boolean;
  readonly defaultModel: string | undefined;
  readonly fields: readonly FieldView[];
  /** The first required field without a value; none means the provider can be called. */
  readonly needs: string | undefined;
  /** Whether any field has a value, so an untouched provider reads as not set up rather than broken. */
  readonly touched: boolean;
};

/** A role with a provider and model, or Tab, which runs on its own server. */
export type RoleView =
  | { readonly role: Role; readonly label: string; readonly kind: 'provider'; readonly provider: ProviderName | undefined; readonly model: string }
  | { readonly role: Role; readonly label: string; readonly kind: 'fixed'; readonly text: string };

export type SettingsListing = { readonly providers: readonly ProviderView[]; readonly roles: readonly RoleView[]; readonly chat: ProviderName };

export type TestState =
  | { readonly kind: 'running' }
  | { readonly kind: 'ok'; readonly text: string }
  | { readonly kind: 'failed'; readonly text: string };

export type ModelsState = { readonly kind: 'loading' } | { readonly kind: 'loaded'; readonly models: readonly string[] } | { readonly kind: 'failed'; readonly text: string };

export type SettingsToView =
  | { readonly type: 'settings'; readonly listing: SettingsListing }
  | { readonly type: 'show-settings' }
  | { readonly type: 'settings-tested'; readonly provider: ProviderName; readonly state: TestState }
  | { readonly type: 'settings-models'; readonly provider: ProviderName; readonly state: ModelsState }
  | AgentsToView;

/** What the page asks of the extension; each change is answered with a fresh listing. */
export type SettingsFromView =
  | { readonly type: 'settings-list' }
  /** The only message that carries a secret, toward SecretStorage and never back. */
  | { readonly type: 'settings-secret'; readonly provider: string; readonly field: string; readonly value: string }
  | { readonly type: 'settings-clear'; readonly provider: string; readonly field: string }
  | { readonly type: 'settings-value'; readonly provider: string; readonly field: string; readonly value: string }
  | { readonly type: 'settings-role'; readonly role: string; readonly provider: string; readonly model: string }
  | { readonly type: 'settings-test'; readonly provider: string }
  | { readonly type: 'settings-list-models'; readonly provider: string }
  | AgentsFromView;

/** How a provider's state reads on its card. */
export function providerBadge(provider: ProviderView): { readonly label: string; readonly tone: 'ok' | 'wait' | 'quiet'; readonly state: 'ready' | 'needs' } {
  if (provider.needs === undefined) return { label: 'Ready', tone: 'ok', state: 'ready' };
  return { label: `Needs ${provider.needs.toLowerCase().replace(/\b(id|url|api)\b/g, (word) => word.toUpperCase())}`, tone: provider.touched ? 'wait' : 'quiet', state: 'needs' };
}
