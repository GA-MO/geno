import { describe, expect, it } from 'vitest';
import { asSessionId, sessionSpend, ZERO_USAGE, type Session, type TurnEvent } from '@g-code/core';
import { usageCard, type UsageOpen } from '../src/chat/usage-model.js';

const at = '2026-10-07T00:00:00.000Z';
const session: Session = { id: asSessionId('s1'), createdAt: at, workspace: '/w', provider: 'modelstudio', model: 'qwen3.8-flash', effort: 'medium', backend: { id: 'cursor' } };
const cursor: TurnEvent[] = [
  { kind: 'session-start', session },
  { kind: 'user', seq: 1, at, content: 'fix it' },
  { kind: 'assistant', seq: 2, at, content: [{ type: 'text', text: 'done', citations: null }], stopReason: 'end_turn', usage: ZERO_USAGE, costUsd: null, latencyMs: 1, model: 'cursor' },
];
const shown = (tab: UsageOpen['tab']): UsageOpen => ({ turn: 't1', tab, spend: { kind: 'shown', spend: sessionSpend(cursor) } });

describe('usageCard', () => {
  it('says an external agent turn has no token data, in the turn and the session', () => {
    expect(usageCard(shown('turn'), 1, 33)).toEqual({ kind: 'turn', view: { kind: 'external', text: 'Cursor plan, no token data', cost: undefined } });
    const card = usageCard(shown('session'), 1, 33);
    expect(card.kind === 'session' && card.view.external).toBe('Cursor plan, no token data');
    expect(card.kind === 'session' && card.view.breakdown).toBeUndefined();
  });

  it('waits while the engine reads the log, and says so when the turn is not in it yet', () => {
    expect(usageCard({ turn: 't1', tab: 'turn', spend: { kind: 'loading' } }, 1, 33)).toEqual({ kind: 'loading' });
    expect(usageCard(shown('turn'), 9, 33)).toEqual({ kind: 'failed', message: 'This turn is not in the session log yet.' });
  });
});
