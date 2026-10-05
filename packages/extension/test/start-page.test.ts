import { describe, expect, it } from 'vitest';
import { branchOfHead } from '../src/git-branch.js';
import type { HistoryRow } from '../src/chat/messages.js';
import { motionOf } from '../src/chat/motion.js';
import { gazeOf, HIDDEN, peekNext, type Peek, type PeekEvent } from '../src/chat/peek-model.js';
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
  const run = (events: readonly PeekEvent[], from: Peek = HIDDEN): Peek => events.reduce(peekNext, from);
  const typed = (draft: string): PeekEvent => ({ kind: 'typed', draft });
  const up: Peek = { act: 'typing', waved: true, blocked: false };

  it('climbs once the composer holds a few typed characters, and waves the first time only', () => {
    expect(run([typed('f'), typed('fi')]).act).toBe('away');
    expect(run([typed('fix')]).act).toBe('climb');
    expect(run([typed('fix'), { kind: 'played' }])).toEqual({ act: 'wave', waved: true, blocked: false });
    expect(run([typed('fix'), { kind: 'played' }, { kind: 'played' }]).act).toBe('typing');
    expect(run([typed('fix'), { kind: 'played' }], { ...HIDDEN, waved: true }).act).toBe('typing');
  });

  it('climbs once per message, not per keystroke', () => {
    expect(run([typed('fix'), typed('fix '), typed('fix i')]).act).toBe('climb');
    expect(run([typed('fix it'), typed('fix it now')], up).act).toBe('typing');
  });

  it('plays one move after a pause in typing, then waits again; typing cuts a move short', () => {
    expect(run([{ kind: 'quiet', random: 0 }], up).act).toBe('drum');
    expect(run([{ kind: 'quiet', random: 0.9 }], up).act).toBe('lookAround');
    expect(run([{ kind: 'quiet', random: 0 }, { kind: 'played' }], up).act).toBe('typing');
    expect(run([{ kind: 'quiet', random: 0 }, typed('fix it!')], up).act).toBe('typing');
    expect(run([{ kind: 'quiet', random: 0 }], { ...up, act: 'climb' }).act).toBe('climb');
  });

  it('ducks the moment the message is sent or the composer is emptied, then is away', () => {
    expect(run([{ kind: 'sent' }], up).act).toBe('duck');
    expect(run([typed('')], up).act).toBe('duck');
    expect(run([typed('   ')], up).act).toBe('duck');
    expect(run([{ kind: 'sent' }, { kind: 'played' }], up).act).toBe('away');
    expect(run([{ kind: 'sent' }]).act).toBe('away');
  });

  it('stays hidden while a turn runs, even while the user types a follow-up, and while the chat is idle', () => {
    expect(run([{ kind: 'blocked', on: true }], up).act).toBe('duck');
    expect(run([{ kind: 'blocked', on: true }, typed('and then this')]).act).toBe('away');
    expect(run([{ kind: 'blocked', on: true }, { kind: 'blocked', on: false }]).act).toBe('away');
    expect(run([{ kind: 'quiet', random: 0 }]).act).toBe('away');
    expect(run([{ kind: 'blocked', on: true }, { kind: 'blocked', on: false }, typed('next one')]).act).toBe('climb');
  });

  it('looks left or right toward the pointer, and up when the pointer is well above the eye', () => {
    expect(gazeOf(-200, 0)).toBe('left');
    expect(gazeOf(30, 0)).toBe('open');
    expect(gazeOf(-200, -300)).toBe('upLeft');
    expect(gazeOf(30, -300)).toBe('up');
    expect(gazeOf(-200, -10)).toBe('left');
  });
});

describe('the motion budget', () => {
  const all = { shown: true, visible: true, focused: true, reducedMotion: false, highContrast: false };

  it('moves only while the start page is shown, the panel visible and the window focused', () => {
    expect(motionOf(all)).toBe('moving');
    expect(motionOf({ ...all, shown: false })).toBe('paused');
    expect(motionOf({ ...all, visible: false })).toBe('paused');
    expect(motionOf({ ...all, focused: false })).toBe('paused');
  });

  it('stands still under reduced motion and in high contrast, whatever else holds', () => {
    expect(motionOf({ ...all, reducedMotion: true })).toBe('still');
    expect(motionOf({ ...all, highContrast: true })).toBe('still');
    expect(motionOf({ ...all, focused: false, highContrast: true })).toBe('still');
  });
});
