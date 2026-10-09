import { describe, expect, it } from 'vitest';
import type { StopReason } from '@anthropic-ai/sdk/resources/messages/messages';
import { asSessionId, budgetReminder, lastCallDue, loopStep, noticeTexts, type LoopStep, type Run, type TurnErrorKind, type TurnEvent } from '../src/index.js';

const at = '2026-10-04T00:00:01.000Z';
const start: TurnEvent = {
  kind: 'session-start',
  session: {
    id: asSessionId('s1'),
    createdAt: at,
    workspace: '/tmp/ws',
    provider: 'modelstudio',
    model: 'qwen3.8-flash',
    effort: 'medium',
  },
};
const user = (seq: number): TurnEvent => ({ kind: 'user', seq, at, content: 'q' });
const assistant = (seq: number, stopReason: StopReason | null, toolIds: string[] = [], costUsd = 0.01): TurnEvent => ({
  kind: 'assistant',
  seq,
  at,
  content: toolIds.length === 0 ? [{ type: 'text', text: 'Done.', citations: null }] : toolIds.map((id) => ({ type: 'tool_use', id, name: 'grep', input: {}, caller: { type: 'direct' } })),
  stopReason,
  usage: { input: 1, cacheRead: 0, cacheWrite: 0, output: 1 },
  costUsd,
  latencyMs: 1,
  model: 'qwen3.8-flash',
});
const result = (seq: number, toolUseId: string): TurnEvent => ({
  kind: 'tool-result',
  seq,
  at,
  toolUseId,
  name: 'grep',
  status: 'ok',
  output: 'hit',
});
const error = (seq: number, kind: TurnErrorKind): TurnEvent => ({ kind: 'error', seq, at, error: kind, message: kind });

const run: Run = { firstSeq: 1, maxTurns: 3, maxCostUsd: 0.05 };
const CALL: LoopStep = { kind: 'call-model' };
const done = (reason: string) => ({ kind: 'done', reason });
const tools = (...ids: string[]) => ({ kind: 'run-tools', toolUses: ids.map((id) => expect.objectContaining({ id })) });
const stop = (seq: number, started: string[]): TurnEvent => ({
  kind: 'error',
  seq,
  at,
  error: 'abort',
  message: 'interrupted by the user',
  tools: started.map((toolUseId) => ({ toolUseId, name: 'grep', startAt: 1, endAt: 2 })),
});
const STOPPED = /interrupted by user.*may have partly run/;
const NOT_STARTED = /interrupted by user.*did not run/;
const CUT_OFF = /output limit.*did not run/;
const answered = (...answers: [id: string, text: RegExp][]) => ({
  kind: 'answer-tools',
  answers: answers.map(([id, text]) => ({ use: expect.objectContaining({ id }), text: expect.stringMatching(text) })),
});

const cases: [name: string, events: TurnEvent[], expected: unknown, run?: Run][] = [
  ['a new question calls the model', [start, user(1)], CALL],
  ['nothing asked is done', [start], done('end_turn')],
  ['tool uses run', [start, user(1), assistant(2, 'tool_use', ['a', 'b'])], tools('a', 'b')],
  [
    'only tools without a logged result run again',
    [start, user(1), assistant(2, 'tool_use', ['a', 'b']), result(3, 'a')],
    tools('b'),
  ],
  ['all results logged calls the model', [start, user(1), assistant(2, 'tool_use', ['a']), result(3, 'a')], CALL],
  [
    'a call the user rejected ends the turn, wherever it sits in the batch',
    [start, user(1), assistant(2, 'tool_use', ['a', 'b']), { ...result(3, 'a'), status: 'rejected' } as TurnEvent, result(4, 'b')],
    done('end_turn'),
  ],
  [
    'the calls after one the user rejected are answered, not run',
    [start, user(1), assistant(2, 'tool_use', ['a', 'b', 'c']), { ...result(3, 'a'), status: 'rejected' } as TurnEvent],
    answered(['b', /^The user rejected an earlier call.*did not run\. STOP what you are doing/], ['c', /^The user rejected an earlier call/]),
  ],
  [
    'a rule denial lets the model go on',
    [start, user(1), assistant(2, 'tool_use', ['a']), { ...result(3, 'a'), status: 'denied' } as TurnEvent],
    CALL,
  ],
  [
    'the next question after a rejection calls the model',
    [start, user(1), assistant(2, 'tool_use', ['a']), { ...result(3, 'a'), status: 'rejected' } as TurnEvent, user(4)],
    CALL,
    { ...run, firstSeq: 4 },
  ],
  [
    "an earlier turn's rejection does not end a later one",
    [start, user(1), assistant(2, 'tool_use', ['a']), { ...result(3, 'a'), status: 'rejected' } as TurnEvent, user(4), assistant(5, 'tool_use', ['b']), result(6, 'b')],
    CALL,
    { ...run, firstSeq: 4 },
  ],
  ['end_turn is done', [start, user(1), assistant(2, 'end_turn')], done('end_turn')],
  ['stop_sequence is done', [start, user(1), assistant(2, 'stop_sequence')], done('end_turn')],
  ['pause_turn continues', [start, user(1), assistant(2, 'pause_turn')], CALL],
  ['max_tokens is an error', [start, user(1), assistant(2, 'max_tokens')], done('error')],
  ['a tool_use stop without tool uses is an error', [start, user(1), assistant(2, 'tool_use')], done('error')],
  ['a context overflow is an error', [start, user(1), assistant(2, 'model_context_window_exceeded')], done('error')],
  ['a missing stop reason is an error', [start, user(1), assistant(2, null)], done('error')],
  ['a refusal stop is a refusal', [start, user(1), assistant(2, 'refusal')], done('refusal')],
  ['a logged refusal is a refusal', [start, user(1), error(2, 'refusal')], done('refusal')],
  ['an abort in this run ends it', [start, user(1), error(2, 'abort')], done('error')],
  ['a transport error in this run ends it', [start, user(1), error(2, 'transport')], done('error')],
  ['a context overflow in this run ends it', [start, user(1), error(2, 'overflow')], done('error')],
  ['a later run answers a prompt that overflowed', [start, user(1), error(2, 'overflow')], CALL, { ...run, firstSeq: 3 }],
  ['a retry is not a turn of the conversation', [start, user(1), { kind: 'retry', seq: 2, at, attempt: 1, delayMs: 1000, message: '529' }], CALL],
  ['a logged max-turns stop ends the run', [start, user(1), error(2, 'max-turns')], done('max-turns')],
  ['a logged budget stop ends the run', [start, user(1), error(2, 'budget')], done('budget')],
  [
    'a later run resumes over an earlier abort without running what it stopped',
    [start, user(1), assistant(2, 'tool_use', ['a']), error(3, 'abort')],
    answered(['a', STOPPED]),
    { ...run, firstSeq: 4 },
  ],
  ['a later run resumes over an earlier limit', [start, user(1), error(2, 'max-turns')], CALL, { ...run, firstSeq: 3 }],
  [
    'a later run does not resend a refused prompt',
    [start, user(1), error(2, 'refusal')],
    done('refusal'),
    { ...run, firstSeq: 3 },
  ],
  [
    'a call the user stopped is answered as stopped, never run, before a newer question',
    [start, user(1), assistant(2, 'tool_use', ['a']), stop(3, ['a']), user(4)],
    answered(['a', STOPPED]),
    { ...run, firstSeq: 4 },
  ],
  [
    'a later run with no new question answers the stopped calls too, and the ones that never started',
    [start, user(1), assistant(2, 'tool_use', ['a', 'b']), stop(3, ['a'])],
    answered(['a', STOPPED], ['b', NOT_STARTED]),
    { ...run, firstSeq: 4 },
  ],
  [
    'an abort logged before batches were timed counts every call as started',
    [start, user(1), assistant(2, 'tool_use', ['a', 'b']), error(3, 'abort'), user(4)],
    answered(['a', STOPPED], ['b', STOPPED]),
    { ...run, firstSeq: 4 },
  ],
  [
    'a call the user issued and then stopped is answered the same way',
    [start, user(1), { ...(assistant(2, 'tool_use', ['a']) as Extract<TurnEvent, { kind: 'assistant' }>), issuedBy: 'user' }, stop(3, ['a']), user(4)],
    answered(['a', STOPPED]),
    { ...run, firstSeq: 4 },
  ],
  [
    'stopped calls answered at the stop leave the next question to the model',
    [start, user(1), assistant(2, 'tool_use', ['a']), result(3, 'a'), stop(4, []), user(5)],
    CALL,
    { ...run, firstSeq: 5 },
  ],
  ['a call cut off at max_tokens is answered, never run', [start, user(1), assistant(2, 'max_tokens', ['a', 'b'])], answered(['b', CUT_OFF])],
  ['the complete calls before the cut one still run', [start, user(1), assistant(2, 'max_tokens', ['a', 'b']), result(3, 'b')], tools('a')],
  ['a cut-off turn goes on once its calls are answered', [start, user(1), assistant(2, 'max_tokens', ['a', 'b']), result(3, 'b'), result(4, 'a')], CALL],
  [
    'a second cut-off in a row ends the run',
    [start, user(1), assistant(2, 'max_tokens', ['a']), result(3, 'a'), assistant(4, 'max_tokens', ['b']), result(5, 'b')],
    done('error'),
  ],
  [
    "a cut-off in an earlier run does not count toward this run's",
    [start, user(1), assistant(2, 'max_tokens', ['a']), result(3, 'a'), user(4), assistant(5, 'max_tokens', ['b']), result(6, 'b')],
    CALL,
    { ...run, firstSeq: 4 },
  ],
  [
    'the turn limit stops the next call',
    [start, user(1), assistant(2, 'tool_use', ['a']), result(3, 'a'), assistant(4, 'tool_use', ['b']), result(5, 'b')],
    done('max-turns'),
    { ...run, maxTurns: 2 },
  ],
  [
    "the turn limit still lets the last call's tools run",
    [start, user(1), assistant(2, 'tool_use', ['a'])],
    tools('a'),
    { ...run, maxTurns: 1 },
  ],
  [
    "only this run's calls count toward the turn limit",
    [start, user(1), assistant(2, 'end_turn'), user(3), assistant(4, 'tool_use', ['a']), result(5, 'a')],
    CALL,
    { ...run, firstSeq: 3, maxTurns: 2 },
  ],
  [
    'passing the budget stops the next call',
    [
      start,
      user(1),
      assistant(2, 'tool_use', ['a'], 0.03),
      result(3, 'a'),
      assistant(4, 'tool_use', ['b'], 0.03),
      result(5, 'b'),
    ],
    done('budget'),
  ],
  ['reaching the budget exactly does not stop', [start, user(1), assistant(2, 'tool_use', ['a'], 0.05), result(3, 'a')], CALL],
];

const handback: Run = { ...run, handback: true };
const reportCall = (seq: number, id: string, extra: string[] = []): TurnEvent => {
  const turn = assistant(seq, 'tool_use', extra) as Extract<TurnEvent, { kind: 'assistant' }>;
  return { ...turn, content: [...turn.content, { type: 'tool_use', id, name: 'report', input: { message: 'done' }, caller: { type: 'direct' } }] };
};
const reported = (seq: number, id: string, status: 'ok' | 'error' = 'ok'): TurnEvent => ({ ...result(seq, id), name: 'report', status } as TurnEvent);
const nudge = (seq: number): TurnEvent => ({ kind: 'report-nudge', seq, at });
const emptyNudge = (seq: number): TurnEvent => ({ kind: 'report-nudge', seq, at, empty: true });
/** A turn that ended with thinking alone, as qwen3.8-flash's did in the real-model campaign (ISSUES.md G-03). */
const thinkingOnly = (seq: number): TurnEvent => ({ ...(assistant(seq, 'end_turn') as Extract<TurnEvent, { kind: 'assistant' }>), content: [{ type: 'thinking', thinking: 'Now I write the file.', signature: '' }] });
const NUDGE: LoopStep = { kind: 'nudge' };

const handbackCases: [name: string, events: TurnEvent[], expected: unknown, run?: Run][] = [
  ['a report call that went through ends the run', [start, user(1), reportCall(2, 'r')], tools('r'), handback],
  ['the run ends once the report call went through', [start, user(1), reportCall(2, 'r'), reported(3, 'r')], done('end_turn'), handback],
  ['the calls beside the report still run, and then the run ends', [start, user(1), reportCall(2, 'r', ['a']), reported(3, 'r'), result(4, 'a')], done('end_turn'), handback],
  ['a report call that failed lets the model go on', [start, user(1), reportCall(2, 'r'), reported(3, 'r', 'error')], CALL, handback],
  ['a model that ends its turn without a report is nudged', [start, user(1), assistant(2, 'end_turn')], NUDGE, handback],
  ['the nudge calls the model', [start, user(1), assistant(2, 'end_turn'), nudge(3)], CALL, handback],
  ['a second end without a report ends the run', [start, user(1), assistant(2, 'end_turn'), nudge(3), assistant(4, 'end_turn')], done('end_turn'), handback],
  ['a turn cap with no call left ends the run without a nudge', [start, user(1), assistant(2, 'end_turn')], done('end_turn'), { ...handback, maxTurns: 1 }],
  ['an earlier run\'s nudge does not count toward this run\'s', [start, user(1), assistant(2, 'end_turn'), nudge(3), assistant(4, 'end_turn'), user(5), assistant(6, 'end_turn')], NUDGE, { ...handback, firstSeq: 5 }],
  ['a refusal is not nudged', [start, user(1), assistant(2, 'refusal')], done('refusal'), handback],
  ['a run without handback is not nudged', [start, user(1), assistant(2, 'end_turn')], done('end_turn')],
  ['a turn that ends with thinking alone is nudged', [start, user(1), thinkingOnly(2)], { kind: 'nudge', empty: true }],
  ['the empty-turn nudge calls the model', [start, user(1), thinkingOnly(2), emptyNudge(3)], CALL],
  ['a second empty turn in a row ends the run as an error', [start, user(1), thinkingOnly(2), emptyNudge(3), thinkingOnly(4)], done('error')],
  ['an answer after the empty-turn nudge ends the turn', [start, user(1), thinkingOnly(2), emptyNudge(3), assistant(4, 'end_turn')], done('end_turn')],
  ['an empty turn at the turn cap ends the run at the cap', [start, user(1), thinkingOnly(2)], done('max-turns'), { ...run, maxTurns: 1 }],
  ['a report call outside a handback run does not end it', [start, user(1), reportCall(2, 'r'), reported(3, 'r')], CALL],
];

describe('loopStep', () => {
  it.each(cases)('%s', (_name, events, expected, limits = run) => {
    expect(loopStep(events, limits)).toEqual(expected);
  });
});

describe('loopStep in a run that hands back through report', () => {
  it.each(handbackCases)('%s', (_name, events, expected, limits = run) => {
    expect(loopStep(events, limits)).toEqual(expected);
  });
});

describe('budgetReminder', () => {
  const ten: Run = { firstSeq: 1, maxTurns: 10, maxCostUsd: 1 };
  const calls = (n: number, costUsd = 0.01, from = 2): TurnEvent[] =>
    Array.from({ length: n }, (_, i) => [assistant(from + 2 * i, 'tool_use', [`t${i}`], costUsd), result(from + 1 + 2 * i, `t${i}`)]).flat();
  const told = (seq: number): TurnEvent => ({ kind: 'notice', seq, at, budget: { calls: 2, maxCalls: 10, costUsd: 0.92, maxCostUsd: 1 } });

  it('stays quiet while more than 20% of the calls and the cost is left', () => {
    expect(budgetReminder([start, user(1), ...calls(7)], ten)).toBeUndefined();
  });

  it('tells what is left once 20% or less of the calls is left', () => {
    expect(budgetReminder([start, user(1), ...calls(8)], ten)).toEqual({ calls: 2, maxCalls: 10, costUsd: expect.closeTo(0.92, 6), maxCostUsd: 1, perCallUsd: expect.closeTo(0.01, 6) });
  });

  it('tells what is left once 20% or less of the cost is left, however many calls remain', () => {
    expect(budgetReminder([start, user(1), ...calls(2, 0.4)], ten)).toMatchObject({ calls: 8, costUsd: expect.closeTo(0.2, 6) });
  });

  it('tells it once a run', () => {
    expect(budgetReminder([start, user(1), ...calls(8), told(18), ...calls(1, 0.01, 19)], ten)).toBeUndefined();
  });

  it('tells it again in a later run, whose limits are its own', () => {
    const earlier = [start, user(1), ...calls(8), told(18)];
    expect(budgetReminder([...earlier, user(19), ...calls(8, 0.01, 20)], { ...ten, firstSeq: 19 })).toMatchObject({ calls: 2 });
  });

  it('says nothing at a limit, where the run stops instead', () => {
    expect(budgetReminder([start, user(1), ...calls(10)], ten)).toBeUndefined();
  });

  it('reads as a notice that names both limits and asks for a closing report', () => {
    const [text] = noticeTexts({ budget: { calls: 2, maxCalls: 10, costUsd: 0.0123, maxCostUsd: 0.4 } });
    expect(text).toMatch(/^\[Geno\] /);
    expect(text).toContain('about 2 more model calls are left (2 of its 10 calls, and $0.0123 of its $0.40 cost limit)');
    expect(text).toMatch(/end your turn with a short report/);
  });

  it('counts the cost left in calls at the mean cost a call so far, as the last call may pass the limit', () => {
    const say = (costUsd: number, perCallUsd: number) => noticeTexts({ budget: { calls: 30, maxCalls: 40, costUsd, maxCostUsd: 0.08, perCallUsd } })[0];
    expect(say(0.015, 0.004)).toContain('about 4 more model calls are left (30 of its 40 calls, and $0.0150 of its $0.0800 cost limit, at about $0.0040 a call)');
    expect(say(0.001, 0.004)).toContain('about 1 more model call is left');
    expect(noticeTexts({ budget: { calls: 2, maxCalls: 10, costUsd: 0.9, maxCostUsd: 1, perCallUsd: 0.01 } })[0]).toContain('about 2 more model calls are left');
  });
});

describe('lastCallDue (ISSUES.md G-04)', () => {
  it('is due before the call that reaches the turn cap, and not before', () => {
    expect(lastCallDue([start, user(1)], { ...run, maxTurns: 2 })).toBe(false);
    expect(lastCallDue([start, user(1), assistant(2, 'tool_use', ['a'], 0.001), result(3, 'a')], { ...run, maxTurns: 2 })).toBe(true);
  });

  it('is due when another call at the mean cost so far would pass the cost limit', () => {
    const events = [start, user(1), assistant(2, 'tool_use', ['a'], 0.03), result(3, 'a')];
    expect(lastCallDue(events, { ...run, maxTurns: 10, maxCostUsd: 0.05 })).toBe(true);
    expect(lastCallDue(events, { ...run, maxTurns: 10, maxCostUsd: 0.07 })).toBe(false);
  });

  it('is not due once a limit is reached, when no call is left at all', () => {
    expect(lastCallDue([start, user(1), assistant(2, 'tool_use', ['a']), result(3, 'a')], { ...run, maxTurns: 1 })).toBe(false);
  });
});
