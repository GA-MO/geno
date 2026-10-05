import type { HistoryRow } from './messages.js';

/** How many sessions the start page offers to continue. */
export const RECENT_COUNT = 3;

/** This project's newest sessions with something in them, other than the one the panel shows. */
export const recentSessions = (rows: readonly HistoryRow[]): HistoryRow[] =>
  rows
    .filter((row) => row.here && !row.current && row.turns > 0)
    .sort((a, b) => b.updatedAt - a.updatedAt)
    .slice(0, RECENT_COUNT);
