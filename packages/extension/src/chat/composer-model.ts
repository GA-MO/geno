import type { BackendId, BackendInfo, BackendShown, ContextUse, WaitKind } from '@g-code/core';
import { waitLabel } from '@g-code/core/waiting';
import { planCost } from './backend-model.js';
import { clockOf } from './format.js';
import { activityOf, NO_BACKGROUND, type ActivityView, type Background } from './activity-model.js';
import type { McpListing } from './mcp-model.js';
import type { Transcript } from './messages.js';
import { isRunning, workedMs } from './transcript.js';

/**
 * The composer's view model: a pure function from what the panel knows about the session to what each slot of the
 * composer shows. The webview bundles this file, so it imports only types and other pure webview modules.
 */

/** One value of a select session config option: an effort, or an external agent's model. */
export type SelectOption = { readonly value: string; readonly name: string };
export type SelectChoice = { readonly current: string; readonly options: readonly SelectOption[] };
/** The efforts the engine offers through ACP's `effort` session config option. */
export type EffortOption = SelectOption;
export type EffortChoice = SelectChoice;

/** A model the menu offers: a ready provider's default or priced model. */
export type ModelChoice = { readonly provider: string; readonly providerLabel: string; readonly model: string };

/** What the extension host knows for the composer, sent whole as a `composer` message whenever any of it changes. */
export type ComposerFacts = {
  /** The chat role's provider id. */
  readonly provider: string;
  /** Undefined until the engine offers the option. */
  readonly effort: EffortChoice | undefined;
  readonly models: readonly ModelChoice[];
  /** The external agents the engine knows and whether each is installed; empty until it answers. */
  readonly backends: readonly BackendInfo[];
  /** An external session's models, from its `model` config option; undefined for Geno's own loop. */
  readonly agentModels: SelectChoice | undefined;
  /** After the session's latest model call; undefined before any. */
  readonly context: ContextUse | undefined;
  /** The running turn's cost so far: undefined before its first call, null for a model with no price. */
  readonly turnCostUsd: number | null | undefined;
  /** `gcode.chat.bahtPerUsd`. */
  readonly bahtPerUsd: number;
};

/** What the extension tells the webview about the composer, and what the webview asks of it. */
export type ComposerToView = { readonly type: 'composer'; readonly facts: ComposerFacts };
export type ComposerFromView =
  | { readonly type: 'set-effort'; readonly value: string }
  | { readonly type: 'set-model'; readonly provider: string; readonly model: string }
  | { readonly type: 'set-agent-model'; readonly value: string }
  /** Starts a new chat on `backend`, which a session keeps for its life. */
  | { readonly type: 'set-backend'; readonly backend: BackendId }
  /** Opens the page the session's browser is at in the user's own browser. */
  | { readonly type: 'open-browser-page'; readonly href: string };

export const NO_FACTS: ComposerFacts = { provider: '', effort: undefined, models: [], backends: [], agentModels: undefined, context: undefined, turnCostUsd: undefined, bahtPerUsd: 0 };

export type ComposerInput = {
  readonly transcript: Transcript;
  readonly facts: ComposerFacts;
  /** The shown session's MCP servers, the built-in browser among them. */
  readonly mcp: McpListing;
  /** A follow-up typed while the turn runs, sent when it finishes. */
  readonly queued: string | undefined;
  readonly now: number;
  /** The engine's tasks, for the row's pill; none when left out. */
  readonly background?: Background | undefined;
};

/** `fraction` is undefined when the window is unknown; `high` from 80%. */
export type RingView = { readonly fraction: number | undefined; readonly high: boolean; readonly title: string; readonly compact: CompactOffer | undefined };

/**
 * The ring's Compact action, offered from 80% on Geno's own sessions; `held` says why it waits while a turn runs. Its
 * tooltip keeps the ring's numbers.
 */
export type CompactOffer = { readonly held: string | undefined; readonly title: string };

/** What Compact sends, exactly as if the user typed it. */
export const COMPACT_COMMAND = '/compact';

const COMPACT_HELD = 'A turn is running. Compact works between turns, and Geno compacts on its own as the context fills.';

/** A backend the menu offers. Any but the current one starts a new chat; a missing one is disabled, with its reason. */
export type BackendRow = {
  readonly id: BackendId;
  readonly label: string;
  readonly current: boolean;
  readonly disabled: boolean;
  /** The muted line under the name, and its tooltip in full. */
  readonly detail: string | undefined;
};

/** What choosing a model row does: Geno's chat role takes a provider's model, an external agent its own. */
export type ModelPick = { readonly kind: 'geno'; readonly provider: string; readonly model: string } | { readonly kind: 'agent'; readonly value: string };

export type ModelRow = {
  /** Unique in the menu; the keyboard's place survives a redraw by it. */
  readonly key: string;
  readonly label: string;
  readonly detail: string | undefined;
  readonly current: boolean;
  readonly pick: ModelPick;
};

export type ModelMenu = {
  /** Empty until the engine lists its backends. */
  readonly backends: readonly BackendRow[];
  readonly models: readonly ModelRow[];
  readonly efforts: readonly (EffortOption & { readonly current: boolean })[];
  /** A muted line under the efforts. */
  readonly note: string | undefined;
};

/** A model call the turn waits on: "Offline, retrying in 12s" or "Limited until 14:05", with the failure as its title. */
export type WaitView = { readonly kind: WaitKind; readonly text: string; readonly title: string };

export type RunningView = {
  /** The time the turn has worked, its waits left out. */
  readonly elapsed: string;
  /** Undefined while no call waits. */
  readonly wait: WaitView | undefined;
  /** Undefined before the turn's first model call. */
  readonly cost: { readonly text: string; readonly title: string } | undefined;
};

export type ComposerView = {
  readonly placeholder: string;
  /** The tray's browser chip, while the session's browser runs; `href` is the web page a click opens in the user's browser. */
  readonly browser: { readonly label: string; readonly title: string; readonly href: string | undefined } | undefined;
  readonly queued: string | undefined;
  readonly ring: RingView;
  /** `backend` names the external agent the session runs on. */
  readonly model: { readonly name: string; readonly effort: string | undefined; readonly backend: string | undefined };
  readonly menu: ModelMenu;
  readonly action: 'send' | 'stop';
  readonly running: RunningView | undefined;
  /** The pill and label for work beside this chat and tasks that need the user, whether or not this chat runs. */
  readonly activity: ActivityView | undefined;
};

/** From this fill the ring warns. */
export const HIGH_CONTEXT = 0.8;

/** U21 measured that Model Studio keeps one prompt cache per effort, so a change writes the history again. */
const EFFORT_NOTES: Readonly<Record<string, string>> = {
  modelstudio: 'A change mid-chat rewrites Model Studio’s cache once.',
};

/** The browser tools that open a URL, whose `url` argument says where the browser is. */
const NAVIGATIONS = new Set(['mcp__browser__navigate_page', 'mcp__browser__new_page']);

/** The pages a click on the browser chip may open: a file: or data: page stays in the session's browser. */
export const WEB = new Set(['http:', 'https:']);

const count = (n: number): string => n.toLocaleString('en-US');

/** An external agent keeps its own context, so only Geno's own loop offers Compact. */
function ringOf(context: ContextUse | undefined, running: boolean, backend: BackendShown | undefined): RingView {
  if (context === undefined) return { fraction: 0, high: false, title: 'Context: nothing yet', compact: undefined };
  const { used, window } = context;
  if (window === undefined) return { fraction: undefined, high: false, title: `Context: ${count(used)} tokens. Geno does not know this model’s window.`, compact: undefined };
  const fraction = Math.min(1, used / window);
  const high = fraction >= HIGH_CONTEXT;
  const numbers = `Context: ${count(used)} of ${count(window)} tokens (${Math.floor((used / window) * 100)}%)`;
  if (!high || backend !== undefined) return { fraction, high, title: numbers, compact: undefined };
  const title = `${numbers}. Compact summarizes the older turns to free it.`;
  return { fraction, high, title, compact: running ? { held: COMPACT_HELD, title: `${numbers}. ${COMPACT_HELD}` } : { held: undefined, title } };
}

/** Where the browser last went: the URL of the latest navigation in the transcript. */
function browserUrl(transcript: Transcript): URL | undefined {
  for (const turn of [...transcript.turns].reverse()) {
    for (const block of [...turn.blocks].reverse()) {
      if (block.kind !== 'tool' || !NAVIGATIONS.has(block.name)) continue;
      try {
        const url: unknown = (JSON.parse(block.target) as { url?: unknown }).url;
        if (typeof url === 'string') return new URL(url);
      } catch {
        // A target that is not the call's JSON arguments names no page.
      }
    }
  }
  return undefined;
}

function browserChip(mcp: McpListing, transcript: Transcript): ComposerView['browser'] {
  const server = mcp.kind === 'loaded' ? mcp.servers.find((s) => s.name === 'browser') : undefined;
  if (server?.state.status !== 'ready') return undefined;
  const url = browserUrl(transcript);
  if (url === undefined) return { label: 'Browser', title: 'The browser is running', href: undefined };
  const web = WEB.has(url.protocol);
  return { label: `Browser · ${url.host}`, title: web ? `Open ${url.href} in your browser` : `The browser is open at ${url.href}`, href: web ? url.href : undefined };
}

export function formatElapsed(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const [h, m, s] = [Math.floor(total / 3600), Math.floor(total / 60) % 60, total % 60];
  const ss = String(s).padStart(2, '0');
  return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${ss}` : `${m}:${ss}`;
}

function costOf(usd: number | null | undefined, bahtPerUsd: number, backend: BackendShown | undefined): RunningView['cost'] {
  if (usd == null && backend !== undefined) return planCost(backend);
  if (usd === undefined) return undefined;
  if (usd === null) return { text: '฿ unknown', title: 'This model has no price in Geno’s table' };
  const baht = usd * bahtPerUsd;
  return { text: baht > 0 && baht < 0.01 ? '<฿0.01' : `฿${baht.toFixed(2)}`, title: `$${usd.toFixed(4)} at ฿${bahtPerUsd} to the US dollar` };
}

export const STARTS_NEW_CHAT = 'Starts a new chat';

/** Geno's own loop first, then each external agent the engine knows; nothing until it answered. */
function backendRows(backends: readonly BackendInfo[], shown: BackendShown | undefined): BackendRow[] {
  if (backends.length === 0) return [];
  const current: BackendId = shown?.id ?? 'geno';
  const geno: BackendRow = { id: 'geno', label: 'Geno', current: current === 'geno', disabled: false, detail: current === 'geno' ? undefined : STARTS_NEW_CHAT };
  return [
    geno,
    ...backends.map(({ id, label, availability }): BackendRow => {
      if (id === current) return { id, label, current: true, disabled: false, detail: undefined };
      return availability.kind === 'missing' ? { id, label, current: false, disabled: true, detail: availability.reason } : { id, label, current: false, disabled: false, detail: STARTS_NEW_CHAT };
    }),
  ];
}

/** An external session lists its agent's models; Geno's lists each ready provider's. */
function modelRows(facts: ComposerFacts, transcript: Transcript): ModelRow[] {
  const agent = facts.agentModels;
  if (transcript.backend !== undefined) {
    return (agent?.options ?? []).map((o) => ({ key: `agent:${o.value}`, label: o.name, detail: undefined, current: o.value === agent?.current, pick: { kind: 'agent', value: o.value } }));
  }
  return facts.models.map((m) => ({
    key: `${m.provider}/${m.model}`,
    label: m.model,
    detail: m.providerLabel,
    current: m.provider === facts.provider && m.model === transcript.model,
    pick: { kind: 'geno', provider: m.provider, model: m.model },
  }));
}

export function composerView({ transcript, facts, mcp, queued, now, background = NO_BACKGROUND }: ComposerInput, clock: (ms: number) => string = clockOf): ComposerView {
  const running = isRunning(transcript);
  const turn = transcript.turns.at(-1);
  const backend = transcript.backend;
  const agentModel = facts.agentModels?.options.find((o) => o.value === facts.agentModels?.current)?.name;
  const name = backend !== undefined ? (agentModel ?? 'Default model') : transcript.model === '' ? 'Default model' : transcript.model;
  const effort = facts.effort;
  return {
    placeholder: running
      ? 'Queue a follow-up…'
      : transcript.turns.length === 0
        ? 'Describe the change you want, @ to add context, / for commands'
        : 'Ask a follow-up, @ to add context, / for commands',
    browser: browserChip(mcp, transcript),
    queued,
    ring: ringOf(facts.context, running, backend),
    model: { name, effort: effort?.options.find((o) => o.value === effort.current)?.name, backend: backend?.label },
    menu: {
      backends: backendRows(facts.backends, backend),
      models: modelRows(facts, transcript),
      efforts: (effort?.options ?? []).map((o) => ({ ...o, current: o.value === effort?.current })),
      note: backend === undefined ? EFFORT_NOTES[facts.provider] : undefined,
    },
    action: running ? 'stop' : 'send',
    running:
      running && turn !== undefined
        ? {
            elapsed: formatElapsed(workedMs(turn, now)),
            wait: turn.waiting === undefined ? undefined : { kind: turn.waiting.kind, text: waitLabel(turn.waiting, now, clock), title: turn.waiting.message },
            cost: costOf(facts.turnCostUsd, facts.bahtPerUsd, backend),
          }
        : undefined,
    activity: activityOf(transcript, background),
  };
}
