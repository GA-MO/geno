import type { HistoryRow, HistoryScope } from './messages.js';

/** The rows the history last heard of, for its scope. */
export type Listing =
  | { readonly kind: 'loading' }
  | { readonly kind: 'loaded'; readonly rows: readonly HistoryRow[] }
  | { readonly kind: 'failed'; readonly message: string };

/** At most one row at a time is being renamed or asks to confirm its deletion. */
export type RowMode = { readonly kind: 'browsing' } | { readonly kind: 'renaming'; readonly id: string } | { readonly kind: 'confirming'; readonly id: string };

/** The history list in the chat panel. While it is open it takes the transcript's place. */
export type HistoryState =
  | { readonly kind: 'closed' }
  | { readonly kind: 'open'; readonly scope: HistoryScope; readonly query: string; readonly listing: Listing; readonly row: RowMode };

export type HistoryEvent =
  | { readonly type: 'open' }
  | { readonly type: 'close' }
  | { readonly type: 'scope'; readonly scope: HistoryScope }
  | { readonly type: 'query'; readonly query: string }
  | { readonly type: 'listed'; readonly scope: HistoryScope; readonly rows: readonly HistoryRow[] }
  | { readonly type: 'failed'; readonly scope: HistoryScope; readonly message: string }
  | { readonly type: 'rename'; readonly id: string }
  | { readonly type: 'confirm'; readonly id: string }
  /** Leaves renaming or confirming, after the change is sent or given up. */
  | { readonly type: 'browse' };

export const CLOSED: HistoryState = { kind: 'closed' };

const BROWSING: RowMode = { kind: 'browsing' };

type EventOf<K extends HistoryEvent['type']> = Extract<HistoryEvent, { type: K }>;
type Open = Extract<HistoryState, { kind: 'open' }>;

/** Each event's effect on an open list; a closed one only opens. */
const ON_OPEN: { readonly [K in HistoryEvent['type']]: (state: Open, event: EventOf<K>) => HistoryState } = {
  open: (state) => state,
  close: () => CLOSED,
  scope: (state, { scope }) => (scope === state.scope ? state : { ...state, scope, listing: { kind: 'loading' }, row: BROWSING }),
  query: (state, { query }) => ({ ...state, query, row: BROWSING }),
  // An answer for a scope the user has since left is dropped.
  listed: (state, { scope, rows }) => (scope === state.scope ? { ...state, listing: { kind: 'loaded', rows } } : state),
  failed: (state, { scope, message }) => (scope === state.scope ? { ...state, listing: { kind: 'failed', message } } : state),
  rename: (state, { id }) => ({ ...state, row: { kind: 'renaming', id } }),
  confirm: (state, { id }) => ({ ...state, row: { kind: 'confirming', id } }),
  browse: (state) => (state.row.kind === 'browsing' ? state : { ...state, row: BROWSING }),
};

export function historyReduce(state: HistoryState, event: HistoryEvent): HistoryState {
  if (state.kind === 'closed') return event.type === 'open' ? { kind: 'open', scope: 'project', query: '', listing: { kind: 'loading' }, row: BROWSING } : state;
  return (ON_OPEN[event.type] as (s: Open, e: HistoryEvent) => HistoryState)(state, event);
}

/** The rows whose title or project holds every word of the query, in any case. */
export function matching(rows: readonly HistoryRow[], query: string): HistoryRow[] {
  const words = query.toLowerCase().split(/\s+/).filter((word) => word !== '');
  return rows.filter((row) => {
    const text = `${row.title} ${row.project}`.toLowerCase();
    return words.every((word) => text.includes(word));
  });
}

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/** How long ago, as a list row says it: minutes, hours and days, then the date. */
export function formatAgo(at: number, now: number): string {
  const ago = now - at;
  if (ago < MINUTE) return 'just now';
  if (ago < HOUR) return `${Math.floor(ago / MINUTE)}m ago`;
  if (ago < DAY) return `${Math.floor(ago / HOUR)}h ago`;
  if (ago < 7 * DAY) return `${Math.floor(ago / DAY)}d ago`;
  const date = new Date(at);
  const sameYear = date.getFullYear() === new Date(now).getFullYear();
  return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric', ...(sameYear ? {} : { year: 'numeric' }) });
}
