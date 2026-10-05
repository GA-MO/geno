import { describe, expect, it } from 'vitest';
import { branchOfHead } from '../src/git-branch.js';
import type { HistoryRow } from '../src/chat/messages.js';
import { gazeOf, peekState } from '../src/chat/peek-model.js';
import { recentSessions } from '../src/chat/recents.js';

const row = (id: string, updatedAt: number, over: Partial<HistoryRow> = {}): HistoryRow => ({
  id,
  title: id,
  workspace: '/w',
  project: 'w',
  here: true,
  updatedAt,
  turns: 2,
  costUsd: null,
  current: false,
  ...over,
});

describe('the start page', () => {
  it('continues from the three newest sessions of this project, leaving out the one shown and empty ones', () => {
    const rows = [
      row('old', 1),
      row('newest', 9),
      row('shown', 10, { current: true }),
      row('empty', 8, { turns: 0 }),
      row('other-project', 11, { here: false }),
      row('middle', 5),
      row('newer', 7),
    ];
    expect(recentSessions(rows).map((r) => r.id)).toEqual(['newest', 'newer', 'middle']);
    expect(recentSessions([])).toEqual([]);
  });

  it('names the branch from HEAD, or a short commit when detached', () => {
    expect(branchOfHead('ref: refs/heads/feature/dino\n')).toBe('feature/dino');
    expect(branchOfHead('3f2a9c1d0e8b7a6f5e4d3c2b1a0f9e8d7c6b5a49\n')).toBe('3f2a9c1');
    expect(branchOfHead('garbage')).toBeUndefined();
  });
});

describe('the peek over the composer', () => {
  const idle = { turns: 1, running: false, composerFocused: false, draft: '' };

  it('peeks once the chat is idle after a turn', () => {
    expect(peekState(idle)).toBe('up');
  });

  it('ducks while the composer has focus or holds text, and hides while a turn runs or before any turn', () => {
    expect(peekState({ ...idle, composerFocused: true })).toBe('ducked');
    expect(peekState({ ...idle, draft: 'fix it' })).toBe('ducked');
    expect(peekState({ ...idle, draft: '   ' })).toBe('up');
    expect(peekState({ ...idle, running: true })).toBe('away');
    expect(peekState({ ...idle, running: true, composerFocused: true })).toBe('away');
    expect(peekState({ ...idle, turns: 0 })).toBe('away');
  });

  it('looks left or right toward the pointer, and up when the pointer is well above the eye', () => {
    expect(gazeOf(-200, 0)).toBe('left');
    expect(gazeOf(30, 0)).toBe('open');
    expect(gazeOf(-200, -300)).toBe('upLeft');
    expect(gazeOf(30, -300)).toBe('up');
    expect(gazeOf(-200, -10)).toBe('left');
  });
});
