import { describe, expect, it } from 'vitest';
import { CLOSED, formatAgo, historyReduce, matching, type HistoryEvent, type HistoryState } from '../src/chat/history-state.js';
import type { HistoryRow } from '../src/chat/messages.js';

const row = (id: string, title: string, project = 'g-code'): HistoryRow => ({
  id,
  title,
  workspace: `/Users/me/${project}`,
  project,
  here: project === 'g-code',
  updatedAt: 0,
  turns: 1,
  costUsd: 0,
  current: false,
});

const run = (...events: HistoryEvent[]): HistoryState => events.reduce(historyReduce, CLOSED);

describe('the history list', () => {
  it('opens on this project, loading, and shows what the extension lists', () => {
    expect(run({ type: 'open' })).toEqual({ kind: 'open', scope: 'project', query: '', listing: { kind: 'loading' }, row: { kind: 'browsing' } });
    expect(run({ type: 'open' }, { type: 'listed', scope: 'project', rows: [row('a', 'A')] })).toMatchObject({ listing: { kind: 'loaded', rows: [{ id: 'a' }] } });
    expect(run({ type: 'listed', scope: 'project', rows: [] })).toBe(CLOSED);
  });

  it('drops an answer for the scope the user has left, and reloads on a switch', () => {
    const switched = run({ type: 'open' }, { type: 'scope', scope: 'all' }, { type: 'listed', scope: 'project', rows: [row('a', 'A')] });
    expect(switched).toMatchObject({ scope: 'all', listing: { kind: 'loading' } });
    expect(historyReduce(switched, { type: 'failed', scope: 'all', message: 'engine down' })).toMatchObject({ listing: { kind: 'failed', message: 'engine down' } });
  });

  it('renames or confirms one row at a time, and searching or switching leaves it', () => {
    const renaming = run({ type: 'open' }, { type: 'rename', id: 'a' });
    expect(renaming).toMatchObject({ row: { kind: 'renaming', id: 'a' } });
    expect(historyReduce(renaming, { type: 'confirm', id: 'b' })).toMatchObject({ row: { kind: 'confirming', id: 'b' } });
    expect(historyReduce(renaming, { type: 'query', query: 'x' })).toMatchObject({ row: { kind: 'browsing' } });
    expect(historyReduce(renaming, { type: 'close' })).toBe(CLOSED);
  });

  it('matches every word of the query against the title and the project, in any case', () => {
    const rows = [row('a', 'Fix the Parser'), row('b', 'Tidy README', 'docs'), row('c', 'Parser tests', 'docs')];
    expect(matching(rows, '').map((r) => r.id)).toEqual(['a', 'b', 'c']);
    expect(matching(rows, 'parser').map((r) => r.id)).toEqual(['a', 'c']);
    expect(matching(rows, 'PARSER docs').map((r) => r.id)).toEqual(['c']);
    expect(matching(rows, 'nothing')).toEqual([]);
  });

  it('says how long ago in minutes, hours and days, then by date', () => {
    const now = Date.parse('2026-10-05T12:00:00Z');
    expect(formatAgo(now - 30_000, now)).toBe('just now');
    expect(formatAgo(now - 5 * 60_000, now)).toBe('5m ago');
    expect(formatAgo(now - 3 * 3_600_000, now)).toBe('3h ago');
    expect(formatAgo(now - 2 * 86_400_000, now)).toBe('2d ago');
    expect(formatAgo(Date.parse('2026-09-01T12:00:00Z'), now)).toBe('Sep 1');
    expect(formatAgo(Date.parse('2025-09-01T12:00:00Z'), now)).toBe('Sep 1, 2025');
  });
});
