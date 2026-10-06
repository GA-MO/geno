import type { HistoryHit, HistoryRow, HistoryScope } from './messages.js';

/** The rows the history last heard of, for its scope. */
export type Listing =
  | { readonly kind: 'loading' }
  | { readonly kind: 'loaded'; readonly rows: readonly HistoryRow[] }
  | { readonly kind: 'failed'; readonly message: string };

/** What the engine's search of the sessions' text answered for the query as typed, trimmed; `none` while the query is empty. */
export type Found =
  | { readonly kind: 'none' }
  | { readonly kind: 'searching'; readonly query: string }
  | { readonly kind: 'found'; readonly query: string; readonly hits: readonly HistoryHit[] }
  | { readonly kind: 'failed'; readonly query: string; readonly message: string };

/** At most one row at a time is being renamed or asks to confirm its deletion. */
export type RowMode = { readonly kind: 'browsing' } | { readonly kind: 'renaming'; readonly id: string } | { readonly kind: 'confirming'; readonly id: string };

/** The history list in the chat panel. While it is open it takes the transcript's place. */
export type HistoryState =
  | { readonly kind: 'closed' }
  | { readonly kind: 'open'; readonly scope: HistoryScope; readonly query: string; readonly listing: Listing; readonly found: Found; readonly row: RowMode };

export type HistoryEvent =
  | { readonly type: 'open' }
  | { readonly type: 'close' }
  | { readonly type: 'scope'; readonly scope: HistoryScope }
  | { readonly type: 'query'; readonly query: string }
  | { readonly type: 'listed'; readonly scope: HistoryScope; readonly rows: readonly HistoryRow[] }
  | { readonly type: 'failed'; readonly scope: HistoryScope; readonly message: string }
  | { readonly type: 'hits'; readonly scope: HistoryScope; readonly query: string; readonly hits: readonly HistoryHit[] }
  | { readonly type: 'hits-failed'; readonly scope: HistoryScope; readonly query: string; readonly message: string }
  | { readonly type: 'rename'; readonly id: string }
  | { readonly type: 'confirm'; readonly id: string }
  /** Leaves renaming or confirming, after the change is sent or given up. */
  | { readonly type: 'browse' };

export const CLOSED: HistoryState = { kind: 'closed' };

const BROWSING: RowMode = { kind: 'browsing' };
const NONE: Found = { kind: 'none' };

export const foundFor = (query: string): Found => (query.trim() === '' ? NONE : { kind: 'searching', query: query.trim() });

type EventOf<K extends HistoryEvent['type']> = Extract<HistoryEvent, { type: K }>;
type Open = Extract<HistoryState, { kind: 'open' }>;

/** Whether an answer is for the scope and the query the list shows now; a late answer to an older one is dropped. */
const current = (state: Open, scope: HistoryScope, query: string): boolean => scope === state.scope && query === state.query.trim();

/** Each event's effect on an open list; a closed one only opens. */
const ON_OPEN: { readonly [K in HistoryEvent['type']]: (state: Open, event: EventOf<K>) => HistoryState } = {
  open: (state) => state,
  close: () => CLOSED,
  scope: (state, { scope }) => (scope === state.scope ? state : { ...state, scope, listing: { kind: 'loading' }, found: foundFor(state.query), row: BROWSING }),
  query: (state, { query }) => ({ ...state, query, found: query.trim() === state.query.trim() ? state.found : foundFor(query), row: BROWSING }),
  // An answer for a scope the user has since left is dropped.
  listed: (state, { scope, rows }) => (scope === state.scope ? { ...state, listing: { kind: 'loaded', rows } } : state),
  failed: (state, { scope, message }) => (scope === state.scope ? { ...state, listing: { kind: 'failed', message } } : state),
  hits: (state, { scope, query, hits }) => (current(state, scope, query) ? { ...state, found: { kind: 'found', query, hits } } : state),
  'hits-failed': (state, { scope, query, message }) => (current(state, scope, query) ? { ...state, found: { kind: 'failed', query, message } } : state),
  rename: (state, { id }) => ({ ...state, row: { kind: 'renaming', id } }),
  confirm: (state, { id }) => ({ ...state, row: { kind: 'confirming', id } }),
  browse: (state) => (state.row.kind === 'browsing' ? state : { ...state, row: BROWSING }),
};

export function historyReduce(state: HistoryState, event: HistoryEvent): HistoryState {
  if (state.kind === 'closed') return event.type === 'open' ? { kind: 'open', scope: 'project', query: '', listing: { kind: 'loading' }, found: NONE, row: BROWSING } : state;
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

/** A row the list shows, with where the search found it when it did. */
export type ShownRow = { readonly row: HistoryRow; readonly hit: HistoryHit | undefined };

/**
 * The rows an open list shows: every row while the query is empty; else the sessions the search found, best first,
 * then those only the title or the project name matches. Until the search answers, the title matches show alone.
 */
export function shownRows(state: Open): ShownRow[] {
  const rows = state.listing.kind === 'loaded' ? state.listing.rows : [];
  if (state.query.trim() === '') return rows.map((row) => ({ row, hit: undefined }));
  const titled = matching(rows, state.query);
  if (state.found.kind !== 'found') return titled.map((row) => ({ row, hit: undefined }));
  const byId = new Map(rows.map((row) => [row.id, row]));
  const found = state.found.hits.flatMap((hit) => {
    const row = byId.get(hit.id);
    return row === undefined ? [] : [{ row, hit }];
  });
  const shown = new Set(found.map(({ row }) => row.id));
  return [...found, ...titled.filter((row) => !shown.has(row.id)).map((row) => ({ row, hit: undefined }))];
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
  return formatDay(at, now);
}

/** The day, with the year only when it is not this one. */
export function formatDay(at: number, now: number): string {
  const date = new Date(at);
  const sameYear = date.getFullYear() === new Date(now).getFullYear();
  return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric', ...(sameYear ? {} : { year: 'numeric' }) });
}

/** Where a search result points, as its row says it. */
export const hitPlace = (hit: HistoryHit, now: number): string =>
  hit.turn === null ? 'Title' : `Turn ${hit.turn.number} · ${formatDay(hit.turn.at, now)}${hit.matchingTurns > 1 ? ` · ${hit.matchingTurns} turns match` : ''}`;
