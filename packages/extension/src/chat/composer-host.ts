import * as acp from '@agentclientprotocol/sdk';
import * as vscode from 'vscode';
import { PRICES, TURN_USAGE_META, type ContextUse, type ProviderName } from '@g-code/core';
import { z } from 'zod';
import type { ComposerFacts, ComposerFromView, ComposerToView, EffortChoice, ModelChoice } from './composer-model.js';
import type { Connection } from './engine.js';
import type { SettingsListing } from './settings-model.js';

/** The rate the composer shows a turn's cost at; USD stays in its tooltip. */
export const BAHT_SETTING = 'gcode.chat.bahtPerUsd';
const DEFAULT_BAHT_PER_USD = 33;

/** U21's session config option for the effort. */
export const EFFORT_CONFIG_ID = 'effort';

const effortOption = z.object({
  id: z.literal(EFFORT_CONFIG_ID),
  type: z.literal('select'),
  currentValue: z.string(),
  options: z.array(z.object({ value: z.string(), name: z.string() })),
});

/** The effort among a session's config options; undefined when the engine offers none. */
export function effortOf(options: readonly unknown[] | null | undefined): EffortChoice | undefined {
  for (const option of options ?? []) {
    const parsed = effortOption.safeParse(option);
    if (parsed.success) return { current: parsed.data.currentValue, options: parsed.data.options.map(({ value, name }) => ({ value, name })) };
  }
  return undefined;
}

const turnUsage = z.object({ costUsd: z.number().nullable() });

/** Each ready provider's default and priced models, the chat provider's first and the current model among them. */
export function modelChoices(listing: SettingsListing, current: string): ModelChoice[] {
  const ready = listing.providers.filter((p) => p.needs === undefined || p.id === listing.chat);
  const ordered = [...ready.filter((p) => p.id === listing.chat), ...ready.filter((p) => p.id !== listing.chat)];
  return ordered.flatMap((p) => {
    const names = [...(p.id === listing.chat && current !== '' ? [current] : []), ...(p.defaultModel === undefined ? [] : [p.defaultModel]), ...Object.keys(PRICES[p.id])];
    return [...new Set(names)].map((model) => ({ provider: p.id, providerLabel: p.label, model }));
  });
}

type Link = { readonly connection: Connection; readonly sessionId: string };

/**
 * The extension's half of the composer: the shown session's effort, context and running cost, the models the user can
 * switch to, and the baht rate, sent to the webview whole whenever one changes.
 */
export class ComposerHost implements vscode.Disposable {
  private facts: ComposerFacts;
  /** Each session's context after its latest call; a load reports it before the session is shown. */
  private readonly contexts = new Map<string, ContextUse>();
  private shown: string | undefined;
  private readonly subscription: vscode.Disposable;

  constructor(
    private readonly link: () => Promise<Link>,
    private readonly post: (message: ComposerToView) => void,
    private readonly listing: () => Promise<SettingsListing>,
    private readonly model: () => string,
    /** Writes the chat role's provider and model, as the settings page does. */
    private readonly chooseModel: (provider: ProviderName, model: string) => Promise<void>,
  ) {
    this.facts = { provider: '', effort: undefined, models: [], context: undefined, turnCostUsd: undefined, bahtPerUsd: rate() };
    this.subscription = vscode.workspace.onDidChangeConfiguration((event) => {
      if (event.affectsConfiguration(BAHT_SETTING)) this.set({ bahtPerUsd: rate() });
    });
  }

  current(): ComposerFacts {
    return this.facts;
  }

  private set(next: Partial<ComposerFacts>): void {
    this.facts = { ...this.facts, ...next };
    this.post({ type: 'composer', facts: this.facts });
  }

  /** Asks the settings for the providers again, after a key, provider or model changed. */
  refreshModels(): void {
    void this.listing().then(
      (listing) => this.set({ provider: listing.chat, models: modelChoices(listing, this.model()) }),
      () => {},
    );
  }

  /** A session was shown: a new chat, or one resumed or loaded, with the options its response gave. */
  switched(sessionId: string, options: readonly unknown[] | null | undefined): void {
    this.shown = sessionId;
    this.set({ effort: effortOf(options), context: this.contexts.get(sessionId), turnCostUsd: undefined });
  }

  turnStarted(): void {
    this.set({ turnCostUsd: undefined });
  }

  /** Takes a usage or config option update; false for any other. */
  updated(sessionId: string, update: acp.SessionUpdate): boolean {
    if (update.sessionUpdate === 'config_option_update') {
      if (sessionId === this.shown) this.set({ effort: effortOf(update.configOptions) });
      return true;
    }
    if (update.sessionUpdate !== 'usage_update') return false;
    // ACP requires a size; the engine sends 0 for a window it does not know.
    const context = { used: update.used, window: update.size > 0 ? update.size : undefined };
    this.contexts.set(sessionId, context);
    if (sessionId !== this.shown) return true;
    const turn = turnUsage.safeParse(update._meta?.[TURN_USAGE_META]);
    this.set(turn.success ? { context, turnCostUsd: turn.data.costUsd } : { context });
    return true;
  }

  readonly handlers: { readonly [K in ComposerFromView['type']]: (message: Extract<ComposerFromView, { type: K }>) => void } = {
    'set-effort': ({ value }) => void this.setEffort(value).catch(warn),
    'set-model': ({ provider, model }) => {
      const known = this.facts.models.find((m) => m.provider === provider && m.model === model);
      if (known !== undefined) void this.chooseModel(known.provider as ProviderName, known.model).catch(warn);
    },
  };

  private async setEffort(value: string): Promise<void> {
    const { connection, sessionId } = await this.link();
    const { configOptions } = await connection.agent.request(acp.methods.agent.session.setConfigOption, { sessionId, configId: EFFORT_CONFIG_ID, value });
    this.set({ effort: effortOf(configOptions) });
  }

  dispose(): void {
    this.subscription.dispose();
  }
}

function rate(): number {
  const value = vscode.workspace.getConfiguration().get<number>(BAHT_SETTING, DEFAULT_BAHT_PER_USD);
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : DEFAULT_BAHT_PER_USD;
}

const warn = (error: unknown) => void vscode.window.showWarningMessage(error instanceof Error ? error.message : String(error));
