import type { SessionSpend } from '@g-code/core';
import { sessionSpendView, turnSpendView, type SessionSpendView, type TurnSpendView } from '@g-code/core/spend-view';

export type UsageTab = 'turn' | 'session';

export type UsageFromView = { readonly type: 'usage'; readonly turn: string };

export type UsageToView =
  | { readonly type: 'usage-spend'; readonly turn: string; readonly spend: SessionSpend }
  | { readonly type: 'usage-failed'; readonly turn: string; readonly message: string };

/** The one open breakdown, under the turn whose usage line opened it. */
export type UsageOpen = {
  readonly turn: string;
  readonly tab: UsageTab;
  readonly spend: { readonly kind: 'loading' } | { readonly kind: 'shown'; readonly spend: SessionSpend } | { readonly kind: 'failed'; readonly message: string };
};

export type UsageCard =
  | { readonly kind: 'loading' }
  | { readonly kind: 'failed'; readonly message: string }
  | { readonly kind: 'turn'; readonly view: TurnSpendView }
  | { readonly kind: 'session'; readonly view: SessionSpendView };

/** What the card shows for the open tab: the turn's own breakdown is found by the event number of its prompt. */
export function usageCard(open: UsageOpen, seq: number | undefined, bahtPerUsd: number): UsageCard {
  if (open.spend.kind !== 'shown') return open.spend;
  const { spend } = open.spend;
  if (open.tab === 'session') return { kind: 'session', view: sessionSpendView(spend, bahtPerUsd) };
  const turn = spend.turns.find((t) => t.seq === seq);
  return turn === undefined ? { kind: 'failed', message: 'This turn is not in the session log yet.' } : { kind: 'turn', view: turnSpendView(turn, bahtPerUsd) };
}
