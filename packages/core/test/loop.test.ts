import { describe, expect, it } from 'vitest';
import type { StopReason } from '@anthropic-ai/sdk/resources/messages/messages';
import { asSessionId, loopStep, type LoopStep, type Run, type TurnErrorKind, type TurnEvent } from '../src/index.js';

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
  content: toolIds.map((id) => ({ type: 'tool_use', id, name: 'grep', input: {}, caller: { type: 'direct' } })),
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
    'a later run resumes over an earlier abort',
    [start, user(1), assistant(2, 'tool_use', ['a']), error(3, 'abort')],
    tools('a'),
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
    'pending tools run before a newer question',
    [start, user(1), assistant(2, 'tool_use', ['a']), error(3, 'abort'), user(4)],
    tools('a'),
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

describe('loopStep', () => {
  it.each(cases)('%s', (_name, events, expected, limits = run) => {
    expect(loopStep(events, limits)).toEqual(expected);
  });
});
