import type { ContextUse, WaitKind } from '@g-code/core';
import { waitLabel } from '@g-code/core/waiting';
import { clockOf } from './format.js';
import type { McpListing } from './mcp-model.js';
import type { Transcript } from './messages.js';
import { isRunning, runningChildren, workedMs } from './transcript.js';

/**
 * The composer's view model: a pure function from what the panel knows about the session to what each slot of the
 * composer shows. The webview bundles this file, so it imports only types and other pure webview modules.
 */

/** One effort the engine offers through ACP's `effort` session config option. */
export type EffortOption = { readonly value: string; readonly name: string };
export type EffortChoice = { readonly current: string; readonly options: readonly EffortOption[] };

/** A model the menu offers: a ready provider's default or priced model. */
export type ModelChoice = { readonly provider: string; readonly providerLabel: string; readonly model: string };

/** What the extension host knows for the composer, sent whole as a `composer` message whenever any of it changes. */
export type ComposerFacts = {
  /** The chat role's provider id. */
  readonly provider: string;
  /** Undefined until the engine offers the option. */
  readonly effort: EffortChoice | undefined;
  readonly models: readonly ModelChoice[];
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
  | { readonly type: 'set-model'; readonly provider: string; readonly model: string };

export const NO_FACTS: ComposerFacts = { provider: '', effort: undefined, models: [], context: undefined, turnCostUsd: undefined, bahtPerUsd: 0 };

export type ComposerInput = {
  readonly transcript: Transcript;
  readonly facts: ComposerFacts;
  /** The shown session's MCP servers, the built-in browser among them. */
  readonly mcp: McpListing;
  /** A follow-up typed while the turn runs, sent when it finishes. */
  readonly queued: string | undefined;
  readonly now: number;
};

/** `fraction` is undefined when the window is unknown; `high` from 80%. */
export type RingView = { readonly fraction: number | undefined; readonly high: boolean; readonly title: string };

export type ModelMenu = {
  readonly models: readonly (ModelChoice & { readonly current: boolean })[];
  readonly efforts: readonly (EffortOption & { readonly current: boolean })[];
  /** A muted line under the efforts. */
  readonly note: string | undefined;
};

/** A running subagent as the agents pill offers it. */
export type RunningChild = { readonly id: string; readonly role: string; readonly model: string; readonly elapsed: string };

/** A model call the turn waits on: "Offline, retrying in 12s" or "Limited until 14:05", with the failure as its title. */
export type WaitView = { readonly kind: WaitKind; readonly text: string; readonly title: string };

export type RunningView = {
  /** The time the turn has worked, its waits left out. */
  readonly elapsed: string;
  /** Undefined while no call waits. */
  readonly wait: WaitView | undefined;
  /** Undefined before the turn's first model call. */
  readonly cost: { readonly text: string; readonly title: string } | undefined;
  /** The pill for the turn's running subagents; undefined while none runs. */
  readonly agents: { readonly count: number; readonly noun: string; readonly title: string; readonly children: readonly RunningChild[] } | undefined;
};

export type ComposerView = {
  readonly placeholder: string;
  /** The tray's browser chip, while the session's browser runs. */
  readonly browser: { readonly label: string; readonly title: string } | undefined;
  readonly queued: string | undefined;
  readonly ring: RingView;
  readonly model: { readonly name: string; readonly effort: string | undefined };
  readonly menu: ModelMenu;
  readonly action: 'send' | 'stop';
  readonly running: RunningView | undefined;
};

/** From this fill the ring warns. */
export const HIGH_CONTEXT = 0.8;

/** U21 measured that Model Studio keeps one prompt cache per effort, so a change writes the history again. */
const EFFORT_NOTES: Readonly<Record<string, string>> = {
  modelstudio: 'A change mid-chat rewrites Model Studio’s cache once.',
};

/** The browser tools that open a URL, whose `url` argument says where the browser is. */
const NAVIGATIONS = new Set(['mcp__browser__navigate_page', 'mcp__browser__new_page']);

const count = (n: number): string => n.toLocaleString('en-US');

function ringOf(context: ContextUse | undefined): RingView {
  if (context === undefined) return { fraction: 0, high: false, title: 'Context: nothing yet' };
  const { used, window } = context;
  if (window === undefined) return { fraction: undefined, high: false, title: `Context: ${count(used)} tokens. Geno does not know this model’s window.` };
  const fraction = Math.min(1, used / window);
  const high = fraction >= HIGH_CONTEXT;
  const numbers = `Context: ${count(used)} of ${count(window)} tokens (${Math.floor((used / window) * 100)}%)`;
  // Geno has no compact action yet; the ring offers one here once it does.
  return { fraction, high, title: high ? `${numbers}. Start a new chat to free it; Geno cannot compact a chat yet.` : numbers };
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
  return url === undefined ? { label: 'Browser', title: 'The browser is running' } : { label: `Browser · ${url.host}`, title: `The browser is open at ${url.href}` };
}

export function formatElapsed(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const [h, m, s] = [Math.floor(total / 3600), Math.floor(total / 60) % 60, total % 60];
  const ss = String(s).padStart(2, '0');
  return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${ss}` : `${m}:${ss}`;
}

function agentsOf(transcript: Transcript, now: number): RunningView['agents'] {
  const children = runningChildren(transcript).map(({ id, role, model, startedAt }) => ({ id, role, model, elapsed: formatElapsed(now - startedAt) }));
  if (children.length === 0) return undefined;
  const noun = children.length === 1 ? 'agent' : 'agents';
  return { count: children.length, noun, title: `${children.length} ${noun} running: ${children.map((c) => c.role).join(', ')}`, children };
}

function costOf(usd: number | null | undefined, bahtPerUsd: number): RunningView['cost'] {
  if (usd === undefined) return undefined;
  if (usd === null) return { text: '฿ unknown', title: 'This model has no price in Geno’s table' };
  const baht = usd * bahtPerUsd;
  return { text: baht > 0 && baht < 0.01 ? '<฿0.01' : `฿${baht.toFixed(2)}`, title: `$${usd.toFixed(4)} at ฿${bahtPerUsd} to the US dollar` };
}

export function composerView({ transcript, facts, mcp, queued, now }: ComposerInput, clock: (ms: number) => string = clockOf): ComposerView {
  const running = isRunning(transcript);
  const turn = transcript.turns.at(-1);
  const name = transcript.model === '' ? 'Default model' : transcript.model;
  const effort = facts.effort;
  return {
    placeholder: running
      ? 'Queue a follow-up…'
      : transcript.turns.length === 0
        ? 'Describe the change you want, @ to add context, / for commands'
        : 'Ask a follow-up, @ to add context, / for commands',
    browser: browserChip(mcp, transcript),
    queued,
    ring: ringOf(facts.context),
    model: { name, effort: effort?.options.find((o) => o.value === effort.current)?.name },
    menu: {
      models: facts.models.map((m) => ({ ...m, current: m.provider === facts.provider && m.model === transcript.model })),
      efforts: (effort?.options ?? []).map((o) => ({ ...o, current: o.value === effort?.current })),
      note: EFFORT_NOTES[facts.provider],
    },
    action: running ? 'stop' : 'send',
    running:
      running && turn !== undefined
        ? {
            elapsed: formatElapsed(workedMs(turn, now)),
            wait: turn.waiting === undefined ? undefined : { kind: turn.waiting.kind, text: waitLabel(turn.waiting, now, clock), title: turn.waiting.message },
            cost: costOf(facts.turnCostUsd, facts.bahtPerUsd),
            agents: agentsOf(transcript, now),
          }
        : undefined,
  };
}
