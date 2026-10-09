import { describe, expect, it } from 'vitest';
import {
  asSessionId,
  EMPTY_KEPT,
  hasPendingPrompt,
  MEMORY_PREAMBLE,
  MODE_NOTICES,
  noticeFor,
  NOT_USER_LINE,
  replayMessages,
  type MemoryEntry,
  type Notice,
  type Session,
  type TurnEvent,
  USER_PROMPT_FOLLOWS,
} from '../src/index.js';

const session: Session = { id: asSessionId('s-1'), createdAt: '2026-10-08T03:00:00.000Z', workspace: '/ws', provider: 'modelstudio', model: 'qwen3.8-flash', effort: 'medium' };
const at = '2026-10-08T03:00:01.000Z';
const note = (id: string, text: string): MemoryEntry => ({ id, text, scope: 'project', createdAt: `2026-10-0${id}T10:00:00Z`, sessionId: null });
const usage = { input: 1, cacheRead: 0, cacheWrite: 0, output: 1 };

const start = (memory?: readonly MemoryEntry[]): TurnEvent => ({ kind: 'session-start', session, ...(memory === undefined ? {} : { memory }) });
const prompt = (seq: number, content: string): TurnEvent => ({ kind: 'user', seq, at, content });
const reply = (seq: number, text: string): TurnEvent => ({ kind: 'assistant', seq, at, content: [{ type: 'text', text, citations: null }], stopReason: 'end_turn', usage, costUsd: 0, latencyMs: 1, model: 'm' });
const notice = (seq: number, body: Notice): TurnEvent => ({ kind: 'notice', seq, at, ...body });

const texts = (events: readonly TurnEvent[], index: number): string[] => {
  const content = replayMessages(events)[index]!.content;
  return typeof content === 'string' ? [content] : content.flatMap((block) => (block.type === 'text' ? [block.text] : block.type === 'tool_result' ? ['(result)'] : []));
};

describe('noticeFor', () => {
  const one = note('1', 'Use pnpm.');
  const two = note('2', 'Prefer named exports.');

  it('says nothing while the mode and the notes are what the session opened with', () => {
    expect(noticeFor([start([one]), prompt(1, 'Hi.')], { mode: 'ask', memory: [one] })).toBeUndefined();
    expect(noticeFor([start(), prompt(1, 'Hi.')], { mode: undefined, memory: [] }), 'a run nobody can switch').toBeUndefined();
  });

  it('tells a switch and a note added, deleted or edited since', () => {
    const events = [start([one]), prompt(1, 'Hi.')];
    expect(noticeFor(events, { mode: 'plan', memory: [one] })).toEqual({ mode: 'plan' });
    expect(noticeFor(events, { mode: 'ask', memory: [one, two] })).toEqual({ memory: { added: [two], removed: [] } });
    expect(noticeFor(events, { mode: 'ask', memory: [] })).toEqual({ memory: { added: [], removed: [one] } });
    const edited = { ...one, text: 'Use pnpm 11.' };
    expect(noticeFor(events, { mode: 'ask', memory: [edited] })).toEqual({ memory: { added: [edited], removed: [one] } });
  });

  it('says it once: the logged notice is what the model knows from then on', () => {
    const events = [start([one]), prompt(1, 'Hi.'), notice(2, { mode: 'plan', memory: { added: [two], removed: [] } })];
    expect(noticeFor(events, { mode: 'plan', memory: [one, two] })).toBeUndefined();
    expect(noticeFor(events, { mode: 'ask', memory: [two] })).toEqual({ mode: 'ask', memory: { added: [], removed: [one] } });
  });

  it('tells again what a compaction dropped', () => {
    const events: TurnEvent[] = [
      start([one]),
      prompt(1, 'Hi.'),
      notice(2, { mode: 'plan', memory: { added: [two], removed: [] } }),
      reply(3, 'Hello.'),
      prompt(4, 'Next.'),
      { kind: 'compact', seq: 5, at, trigger: 'manual', keptFrom: 4, summary: 'Said hello.', kept: EMPTY_KEPT, tokensBefore: 10, tokensAfter: 5, usage, costUsd: 0, model: 'm' },
    ];
    expect(noticeFor(events, { mode: 'plan', memory: [one, two] })).toEqual({ mode: 'plan', memory: { added: [two], removed: [] } });
  });
});

describe('a notice in the conversation', () => {
  const snapshot = [note('1', 'Use pnpm.')];

  it('opens the first message with the memory snapshot, before the prompt', () => {
    const [memory, asked] = texts([start(snapshot), prompt(1, 'Hi.')], 0);
    expect(memory!.startsWith(MEMORY_PREAMBLE)).toBe(true);
    expect(memory).toContain('<note scope="project">Use pnpm.</note>');
    expect(asked).toBe('Hi.');
  });

  it('comes after the tool results and before the prompts it was logged with', () => {
    const events: TurnEvent[] = [
      start(),
      prompt(1, 'Read it.'),
      { kind: 'assistant', seq: 2, at, content: [{ type: 'tool_use', id: 'tu_1', name: 'read', input: { path: 'a.ts' }, caller: { type: 'direct' } }], stopReason: 'tool_use', usage, costUsd: 0, latencyMs: 1, model: 'm' },
      { kind: 'tool-result', seq: 3, at, toolUseId: 'tu_1', name: 'read', status: 'ok', output: 'a' },
      { kind: 'user', seq: 4, at, content: 'Also b.', steer: true },
      notice(5, { mode: 'plan' }),
    ];
    const [result, told, follows, steer] = texts(events, 2);
    expect(result).toBe('(result)');
    expect(told).toBe(MODE_NOTICES.plan);
    expect(follows, 'the notes end before the user speaks (ISSUES.md G-02)').toBe(USER_PROMPT_FOLLOWS);
    expect(steer).toContain('Also b.');
  });

  it('outlives a refused prompt, and alone leaves nothing pending', () => {
    const memory = { added: [note('2', 'Be brief.')], removed: [] };
    const refused: TurnEvent[] = [start(), prompt(1, 'Hi.'), notice(2, { memory }), { kind: 'error', seq: 3, at, error: 'refusal', message: 'no' }];
    expect(hasPendingPrompt(refused)).toBe(false);
    const [told, , asked] = texts([...refused, prompt(4, 'Again.')], 0);
    expect(told!.startsWith(NOT_USER_LINE)).toBe(true);
    expect(told).toContain('<note scope="project">Be brief.</note>');
    expect(asked).toBe('Again.');
  });
});
