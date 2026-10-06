import { describe, expect, it } from 'vitest';
import { CLOSED, formatAgo, hitPlace, historyReduce, matching, shownRows, type HistoryEvent, type HistoryState } from '../src/chat/history-state.js';
import type { HistoryHit, HistoryRow } from '../src/chat/messages.js';

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
    expect(run({ type: 'open' })).toEqual({ kind: 'open', scope: 'project', query: '', listing: { kind: 'loading' }, found: { kind: 'none' }, row: { kind: 'browsing' } });
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

  const hit = (id: string, turn: number | null = 2): HistoryHit => ({
    id,
    turn: turn === null ? null : { number: turn, seq: turn * 10, at: Date.parse('2026-10-03T08:00:00Z') },
    snippet: { text: `…found in ${id}`, marks: [[1, 6]] },
    matchingTurns: 1,
  });
  const open = (state: HistoryState) => {
    if (state.kind !== 'open') throw new Error('the list is closed');
    return state;
  };
  const shown = (state: HistoryState) => shownRows(open(state)).map(({ row, hit }) => `${row.id}${hit === undefined ? '' : `@${hit.turn?.number ?? 'title'}`}`);

  it('searches the text for the trimmed query, shows title matches until it answers, then the hits first and the title matches after', () => {
    const rows = [row('a', 'Fix the Parser'), row('b', 'Queue workers'), row('c', 'Parser tests')];
    const listed = run({ type: 'open' }, { type: 'listed', scope: 'project', rows });
    expect(shown(listed)).toEqual(['a', 'b', 'c']);
    const typed = historyReduce(listed, { type: 'query', query: ' parser ' });
    expect(open(typed).found).toEqual({ kind: 'searching', query: 'parser' });
    expect(shown(typed), 'the titles answer at once').toEqual(['a', 'c']);
    const answered = historyReduce(typed, { type: 'hits', scope: 'project', query: 'parser', hits: [hit('b', 3), hit('c'), hit('gone')] });
    expect(shown(answered), 'a hit for a session the list no longer has is dropped').toEqual(['b@3', 'c@2', 'a']);
    expect(historyReduce(answered, { type: 'query', query: 'parser  ' }), 'a space typed after the words keeps the answer').toMatchObject({ found: { kind: 'found' } });
    expect(shown(historyReduce(answered, { type: 'query', query: '' }))).toEqual(['a', 'b', 'c']);
  });

  it('drops a late answer to an older query or another scope, and searches again on a scope switch', () => {
    const typed = run({ type: 'open' }, { type: 'listed', scope: 'project', rows: [row('a', 'A')] }, { type: 'query', query: 'queue' });
    const late = historyReduce(typed, { type: 'hits', scope: 'project', query: 'que', hits: [hit('a')] });
    expect(late).toBe(typed);
    expect(historyReduce(typed, { type: 'hits', scope: 'all', query: 'queue', hits: [hit('a')] })).toBe(typed);
    const switched = historyReduce(typed, { type: 'scope', scope: 'all' });
    expect(switched).toMatchObject({ found: { kind: 'searching', query: 'queue' }, listing: { kind: 'loading' } });
    expect(historyReduce(switched, { type: 'hits-failed', scope: 'all', query: 'queue', message: 'engine down' })).toMatchObject({ found: { kind: 'failed', message: 'engine down' } });
  });

  it('says where a hit points: its turn and day, or the title', () => {
    const now = Date.parse('2026-10-05T12:00:00Z');
    expect(hitPlace(hit('a', 4), now)).toBe('Turn 4 · Oct 3');
    expect(hitPlace({ ...hit('a', 4), matchingTurns: 3 }, now)).toBe('Turn 4 · Oct 3 · 3 turns match');
    expect(hitPlace(hit('a', null), now)).toBe('Title');
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
