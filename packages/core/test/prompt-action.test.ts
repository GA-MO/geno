import type { StopReason } from '@anthropic-ai/sdk/resources/messages/messages';
import { describe, expect, it } from 'vitest';
import { asSessionId, GENO_NOTE, PROMPT_ACTIONS, replayMessages, userActionText, type PromptAction, type Session, type TurnEvent } from '../src/index.js';

const at = '2026-10-12T00:00:01.000Z';
const session: Session = { id: asSessionId('s1'), createdAt: at, workspace: '/tmp/ws', provider: 'modelstudio', model: 'qwen3.8-flash', effort: 'medium' };
const THAI = 'วางแผนเพิ่มปุ่มรีเซ็ตในเกม';
const said = (seq: number, text: string, stopReason: StopReason = 'end_turn'): TurnEvent => ({
  kind: 'assistant',
  seq,
  at,
  content: [{ type: 'text', text, citations: null }],
  stopReason,
  usage: { input: 1, cacheRead: 0, cacheWrite: 0, output: 1 },
  costUsd: 0.01,
  latencyMs: 1,
  model: 'qwen3.8-flash',
});
const pressed = (seq: number, action: PromptAction): TurnEvent => ({ kind: 'user', seq, at, content: PROMPT_ACTIONS[action], action });

/** The texts of the user's turns that are not Geno's: what the user wrote in their own words. */
const ownWords = (events: readonly TurnEvent[]): string[] =>
  replayMessages(events)
    .filter((message) => message.role === 'user')
    .flatMap((message) => (typeof message.content === 'string' ? [message.content] : message.content.flatMap((block) => (block.type === 'text' ? [block.text] : []))))
    .filter((text) => !text.startsWith(GENO_NOTE) && !text.startsWith('<'));

describe('a button that sends a prompt for the user', () => {
  it.each(['start-building', 'continue'] as const)('%s after a Thai conversation leaves the Thai message as the latest in the user\'s own words', (action) => {
    const events: TurnEvent[] = [{ kind: 'session-start', session }, { kind: 'user', seq: 1, at, content: THAI }, said(2, 'แผน: เพิ่มปุ่มใน game.html'), pressed(3, action)];
    expect(ownWords(events).at(-1)).toBe(THAI);
    const last = replayMessages(events).at(-1)!;
    expect(last.content).toEqual([{ type: 'text', text: userActionText(PROMPT_ACTIONS[action]) }]);
    expect(userActionText(PROMPT_ACTIONS[action])).toContain('language the user writes their own messages in');
  });

  it('reads as the user\'s own words when they type the same text', () => {
    const events: TurnEvent[] = [{ kind: 'session-start', session }, { kind: 'user', seq: 1, at, content: THAI }, said(2, 'แผน'), { kind: 'user', seq: 3, at, content: PROMPT_ACTIONS['start-building'] }];
    expect(ownWords(events).at(-1)).toBe(PROMPT_ACTIONS['start-building']);
  });
});
