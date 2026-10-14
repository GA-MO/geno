import { addBreakdowns, EMPTY_BREAKDOWN, requestBreakdown } from './breakdown.js';
import { inputOf, tokensOf, type Breakdown } from './parts.js';
import { EXTERNAL_BACKENDS } from './backends.js';
import { ratesOf } from './cost.js';
import type { ProviderName } from './providers.js';
import type { CompactEvent } from './compact.js';
import { classifierCostOf, helperCostOf, type TurnEvent } from './session.js';
import { startsTurn } from './steer.js';
import { childRunKey, childrenOf } from './subagent.js';

/** A subagent a turn started, and what it spent in its own session. */
export type ChildSpend = { readonly child: string; readonly role: string; readonly turns: number; readonly costUsd: number | null };

/**
 * One turn's spend. A turn on an external agent has no token data: the agent's plan pays, and only a cost it
 * reported is known.
 */
export type TurnSpend =
  | {
      readonly kind: 'model';
      /** The event number of the turn's prompt, as the panel names the turn. */
      readonly seq: number;
      readonly prompt: string;
      readonly breakdown: Breakdown;
      readonly children: readonly ChildSpend[];
      /** What the Auto classifier's calls cost in this turn; absent is none. */
      readonly classifierCostUsd?: number | undefined;
      /** What the tools' own model calls cost in this turn, such as web_search's searches; absent is none. */
      readonly helperCostUsd?: number | undefined;
      /** The requests, the children, the classifier and the tools' calls together. */
      readonly costUsd: number | null;
    }
  | { readonly kind: 'external'; readonly seq: number; readonly prompt: string; readonly plan: string; readonly costUsd: number | null };

export type SessionSpend = {
  readonly sessionId: string;
  readonly provider: ProviderName;
  readonly model: string;
  /** Every model request of the session, summed. */
  readonly breakdown: Breakdown;
  readonly children: readonly ChildSpend[];
  readonly childrenCostUsd: number | null;
  /** The Auto classifier's calls, which run outside any model request of the session; absent is none. */
  readonly classifierCostUsd?: number | undefined;
  /** The tools' own model calls, such as web_search's searches; absent is none. */
  readonly helperCostUsd?: number | undefined;
  readonly costUsd: number | null;
  readonly turns: readonly TurnSpend[];
  /** The seqs of the costliest turns, at most TOP_TURNS, costliest first. */
  readonly top: readonly number[];
};

export const TOP_TURNS = 5;

const addCost = (a: number | null, b: number | null): number | null => (a === null || b === null ? null : a + b);
const sumCost = (costs: readonly (number | null)[]): number | null => costs.reduce<number | null>(addCost, 0);

/** A turn's tokens, for ranking when nothing is priced. */
const weightOf = (turn: TurnSpend): number => (turn.kind === 'model' ? tokensOf(turn.breakdown.total.usage) : 0);

/**
 * Each run of each child, with the seq of the start that began it, so a run counts in the turn that started it. A
 * child that a message resumed runs more than once; a run still going has reported nothing yet.
 */
function childRuns(events: readonly TurnEvent[]): (ChildSpend & { readonly seq: number })[] {
  const runs: (ChildSpend & { readonly seq: number })[] = [];
  const open = new Map<string, number>();
  for (const event of events) {
    if (event.kind === 'child-start') open.set(childRunKey(event), runs.push({ seq: event.seq, child: event.child, role: event.role, turns: 0, costUsd: 0 }) - 1);
    if (event.kind !== 'child-end') continue;
    const at = open.get(childRunKey(event));
    if (at === undefined) continue;
    open.delete(childRunKey(event));
    runs[at] = { ...runs[at]!, turns: event.turns, costUsd: event.costUsd };
  }
  return runs;
}

/** A turn as the panel draws it: a prompt, or a /compact between turns, whose summary call is its only request. */
const turnStartOf = (event: TurnEvent): { readonly seq: number; readonly prompt: string }[] => {
  if (startsTurn(event)) return [{ seq: event.seq, prompt: event.content }];
  if (event.kind === 'compact' && event.trigger === 'manual') return [{ seq: event.seq, prompt: event.focus === undefined ? '/compact' : `/compact ${event.focus}` }];
  return [];
};

/** Where a session's tokens went, turn by turn, from its log. A compaction's summary call counts in the turn it ran in. */
export function sessionSpend(events: readonly TurnEvent[]): SessionSpend {
  const start = events.find((e) => e.kind === 'session-start');
  if (start === undefined) throw new Error('the log has no session-start');
  const { session } = start;
  const rates = ratesOf(session.provider, session.model);
  const children = childrenOf(events);
  const runs = childRuns(events);
  const starts = events.flatMap(turnStartOf);
  const turns = starts.map((start, i): TurnSpend => {
    const end = starts[i + 1]?.seq ?? Infinity;
    const within = (seq: number | undefined) => seq !== undefined && seq >= start.seq && seq < end;
    const calls = events.filter((e): e is Extract<TurnEvent, { kind: 'assistant' }> => e.kind === 'assistant' && within(e.seq));
    const compactions = events.filter((e): e is CompactEvent => e.kind === 'compact' && within(e.seq));
    if (session.backend !== undefined) {
      const reported = calls.flatMap((c) => (c.costUsd === null ? [] : [c.costUsd]));
      return { kind: 'external', seq: start.seq, prompt: start.prompt, plan: EXTERNAL_BACKENDS[session.backend.id].plan, costUsd: reported.length === 0 ? null : reported.reduce((a, b) => a + b, 0) };
    }
    const breakdown = [...calls.map((c) => requestBreakdown(c.promptParts, c.usage, rates)), ...compactions.map((c) => requestBreakdown([['compaction', inputOf(c.usage)]], c.usage, rates))].reduce(addBreakdowns, EMPTY_BREAKDOWN);
    const own = runs.filter((run) => within(run.seq)).map(({ seq: _, ...spend }): ChildSpend => spend);
    const sideOf = (cost: (e: TurnEvent) => number) => events.reduce((sum, e) => sum + ('seq' in e && within(e.seq) ? cost(e) : 0), 0);
    const classifierCostUsd = sideOf(classifierCostOf);
    const helperCostUsd = sideOf(helperCostOf);
    return {
      kind: 'model',
      seq: start.seq,
      prompt: start.prompt,
      breakdown,
      children: own,
      ...(classifierCostUsd > 0 ? { classifierCostUsd } : {}),
      ...(helperCostUsd > 0 ? { helperCostUsd } : {}),
      costUsd: addCost(addCost(breakdown.total.costUsd, sumCost(own.map((c) => c.costUsd))), classifierCostUsd + helperCostUsd),
    };
  });
  const breakdown = turns.reduce((sum, t) => (t.kind === 'model' ? addBreakdowns(sum, t.breakdown) : sum), EMPTY_BREAKDOWN);
  const spent = children.map((c): ChildSpend => ({ child: c.child, role: c.role, turns: c.turns, costUsd: c.costUsd }));
  const childrenCostUsd = sumCost(spent.map((c) => c.costUsd));
  const top = turns
    .filter((t) => (t.costUsd ?? 0) > 0 || weightOf(t) > 0)
    .toSorted((a, b) => (b.costUsd ?? 0) - (a.costUsd ?? 0) || weightOf(b) - weightOf(a) || a.seq - b.seq)
    .slice(0, TOP_TURNS)
    .map((t) => t.seq);
  const classifierCostUsd = turns.reduce((sum, t) => sum + (t.kind === 'model' ? (t.classifierCostUsd ?? 0) : 0), 0);
  const helperCostUsd = turns.reduce((sum, t) => sum + (t.kind === 'model' ? (t.helperCostUsd ?? 0) : 0), 0);
  const external = turns.flatMap((t) => (t.kind === 'external' ? [t.costUsd] : []));
  const externalCost = external.length === 0 ? 0 : external.some((c) => c !== null) ? external.reduce<number>((a, c) => a + (c ?? 0), 0) : null;
  return {
    sessionId: session.id,
    provider: session.provider,
    model: session.model,
    breakdown,
    children: spent,
    childrenCostUsd,
    ...(classifierCostUsd > 0 ? { classifierCostUsd } : {}),
    ...(helperCostUsd > 0 ? { helperCostUsd } : {}),
    costUsd: sumCost([breakdown.total.costUsd, childrenCostUsd, externalCost, classifierCostUsd, helperCostUsd]),
    turns,
    top,
  };
}
