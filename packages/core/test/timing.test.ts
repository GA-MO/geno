import { describe, expect, it } from 'vitest';
import type { ContentBlock } from '@anthropic-ai/sdk/resources/messages/messages';
import { asSessionId, buildRequest, speedReport, turnTimings, type ModelMarks, type TurnEvent } from '../src/index.js';

const T0 = Date.parse('2026-10-05T00:00:00.000Z');
const iso = (ms: number) => new Date(T0 + ms).toISOString();

const start: TurnEvent = {
  kind: 'session-start',
  session: { id: asSessionId('s1'), createdAt: iso(0), workspace: '/tmp/ws', provider: 'modelstudio', model: 'qwen3.8-flash', effort: 'medium' },
};
const user = (seq: number, at: number): TurnEvent => ({ kind: 'user', seq, at: iso(at), content: 'q' });

const marks = (startAt: number, requestAt: number, firstTokenAt: number | null, firstAnswerAt: number | null, lastTokenAt: number | null, endAt: number): ModelMarks => ({
  startAt: T0 + startAt,
  requestAt: T0 + requestAt,
  firstTokenAt: firstTokenAt === null ? null : T0 + firstTokenAt,
  firstAnswerAt: firstAnswerAt === null ? null : T0 + firstAnswerAt,
  lastTokenAt: lastTokenAt === null ? null : T0 + lastTokenAt,
  endAt: T0 + endAt,
});

const thinking = (chars: number): ContentBlock => ({ type: 'thinking', thinking: 'x'.repeat(chars), signature: 'sig' });
const text = (chars: number): ContentBlock => ({ type: 'text', text: 'y'.repeat(chars), citations: null });
// '{"path":"a"}' is 12 characters.
const read = (id: string): ContentBlock => ({ type: 'tool_use', id, name: 'read', input: { path: 'a' }, caller: { type: 'direct' } });

const assistant = (seq: number, at: number, content: ContentBlock[], output: number, timing?: ModelMarks): TurnEvent => ({
  kind: 'assistant',
  seq,
  at: iso(at),
  content,
  stopReason: content.some((b) => b.type === 'tool_use') ? 'tool_use' : 'end_turn',
  usage: { input: 10, cacheRead: 2000, cacheWrite: 300, output },
  costUsd: 0.001,
  latencyMs: 1,
  model: 'qwen3.8-flash',
  ...(timing === undefined ? {} : { timing }),
});

const result = (seq: number, at: number, toolUseId: string, startAt?: number, endAt?: number): TurnEvent => ({
  kind: 'tool-result',
  seq,
  at: iso(at),
  toolUseId,
  name: 'read',
  status: 'ok',
  output: 'contents',
  ...(startAt === undefined || endAt === undefined ? {} : { timing: { startAt: T0 + startAt, endAt: T0 + endAt } }),
});

// A thinking turn with two tools, then a turn that answers without thinking or tools.
const thinkingThenAnswer: TurnEvent[] = [
  start,
  user(1, 900),
  { kind: 'checkpoint', seq: 2, at: iso(1090), sessionId: asSessionId('s1'), turnSeq: 3, sha: 'abc', files: [], label: 'before turn 3' },
  assistant(3, 4655, [thinking(300), text(76), read('t1'), read('t2')], 400, marks(1000, 1100, 1600, 2600, 4600, 4650)),
  result(4, 5952, 't1', 4700, 4900),
  result(5, 5953, 't2', 4950, 5950),
  assistant(6, 7425, [text(40)], 20, marks(6000, 6010, 6400, 6400, 7400, 7420)),
];

describe('turnTimings', () => {
  it('splits a thinking turn with tools into first token, thinking, decode, tools and overhead', () => {
    const [first] = turnTimings(thinkingThenAnswer);
    expect(first).toEqual({
      seq: 3,
      outcome: 'answer',
      wallMs: 5000,
      ttftMs: 500,
      thinkingMs: 1000,
      decodeMs: 2000,
      modelMs: 3550,
      toolMs: 1200,
      overheadMs: 250,
      tools: [
        { toolUseId: 't1', name: 'read', ms: 200 },
        { toolUseId: 't2', name: 'read', ms: 1000 },
      ],
      tokens: { input: 10, output: 400, thinking: 300, cacheRead: 2000, cacheWrite: 300 },
    });
  });

  it('gives a turn without thinking or tools no thinking or tool time, and ends the last turn at its last logged moment', () => {
    const [, second] = turnTimings(thinkingThenAnswer);
    expect(second).toEqual({
      seq: 6,
      outcome: 'answer',
      wallMs: 1425,
      ttftMs: 390,
      thinkingMs: 0,
      decodeMs: 1000,
      modelMs: 1410,
      toolMs: 0,
      overheadMs: 15,
      tools: [],
      tokens: { input: 10, output: 20, thinking: 0, cacheRead: 2000, cacheWrite: 300 },
    });
  });

  it('keeps every turn whole: wall is model plus tools plus overhead', () => {
    const timings = turnTimings(thinkingThenAnswer);
    expect(timings).toHaveLength(2);
    for (const t of timings) expect(t.modelMs + t.toolMs + t.overheadMs).toBe(t.wallMs);
  });

  it('counts tools that ran at the same time once, by the wall time they cover', () => {
    const [first] = turnTimings([
      start,
      user(1, 900),
      assistant(2, 1500, [text(10), read('t1'), read('t2'), read('t3')], 50, marks(1000, 1010, 1100, 1100, 1400, 1450)),
      result(3, 2501, 't1', 1500, 1900),
      result(4, 2502, 't2', 1520, 1700),
      result(5, 2503, 't3', 2000, 2500),
      assistant(6, 2700, [text(5)], 5, marks(2600, 2610, 2650, 2650, 2690, 2695)),
    ]);
    expect(first!.tools.map((t) => t.ms)).toEqual([400, 180, 500]);
    expect(first!.toolMs).toBe(900);
    expect(first!.overheadMs).toBe(1600 - 440 - 900);
  });

  it('counts a model call interrupted mid-thought as thinking, with no answer, decode or tokens', () => {
    const events: TurnEvent[] = [
      start,
      user(1, 0),
      { kind: 'error', seq: 2, at: iso(3001), error: 'abort', message: 'interrupted by the user', timing: marks(0, 5, 800, null, 2900, 3000) },
    ];
    expect(turnTimings(events)).toEqual([
      {
        seq: 2,
        outcome: 'aborted',
        wallMs: 3001,
        ttftMs: 795,
        thinkingMs: 2100,
        decodeMs: 0,
        modelMs: 2995,
        toolMs: 0,
        overheadMs: 6,
        tools: [],
        tokens: null,
      },
    ]);
  });

  it('counts the tools of an interrupted batch from the abort error, including the one cut off', () => {
    const events: TurnEvent[] = [
      start,
      user(1, 0),
      assistant(2, 1010, [text(10), read('t1'), read('t2')], 30, marks(0, 0, 200, 200, 1000, 1000)),
      {
        kind: 'error',
        seq: 3,
        at: iso(1700),
        error: 'abort',
        message: 'interrupted by the user',
        tools: [
          { toolUseId: 't1', name: 'read', startAt: T0 + 1020, endAt: T0 + 1220 },
          { toolUseId: 't2', name: 'bash', startAt: T0 + 1230, endAt: T0 + 1690 },
        ],
      },
    ];
    expect(turnTimings(events)).toEqual([
      expect.objectContaining({
        seq: 2,
        outcome: 'aborted',
        wallMs: 1700,
        modelMs: 1000,
        toolMs: 660,
        overheadMs: 40,
        tools: [
          { toolUseId: 't1', name: 'read', ms: 200 },
          { toolUseId: 't2', name: 'bash', ms: 460 },
        ],
      }),
    ]);
  });

  it('marks a failed call as an error', () => {
    const events: TurnEvent[] = [
      start,
      user(1, 0),
      { kind: 'error', seq: 2, at: iso(400), error: 'transport', message: 'socket hang up', timing: marks(0, 0, null, null, null, 390) },
    ];
    expect(turnTimings(events)).toEqual([expect.objectContaining({ outcome: 'error', ttftMs: null, thinkingMs: 0, decodeMs: 0, modelMs: 390, wallMs: 400 })]);
  });

  it('does not count the time the user took to send the next prompt', () => {
    const events: TurnEvent[] = [
      start,
      user(1, 0),
      assistant(2, 1005, [text(10)], 5, marks(0, 0, 100, 100, 1000, 1000)),
      user(3, 60_000),
      assistant(4, 61_005, [text(10)], 5, marks(60_001, 60_001, 60_100, 60_100, 61_000, 61_000)),
    ];
    expect(turnTimings(events).map((t) => t.wallMs)).toEqual([1005, 1004]);
  });

  it('skips calls logged before turns were timed, so old logs still read', () => {
    const events: TurnEvent[] = [start, user(1, 0), assistant(2, 1000, [text(10), read('t1')], 5), result(3, 1100, 't1'), assistant(4, 2000, [text(5)], 5)];
    expect(turnTimings(events)).toEqual([]);
  });

  it('reports how much of the agent time model and tool time explain, and what no turn covers', () => {
    const report = speedReport([
      { taskId: 'a', pass: true, agentMs: 7000, turns: turnTimings(thinkingThenAnswer) },
      { taskId: 'b', pass: false, agentMs: 3500, turns: turnTimings([start, user(1, 0), { kind: 'error', seq: 2, at: iso(3001), error: 'abort', message: 'x', timing: marks(0, 5, 800, null, 2900, 3000) }]) },
    ]);
    expect(report).toMatchObject({ tasks: 2, passed: 1, turns: 3, agentMs: 10_500, outsideTurnsMs: 10_500 - (5000 + 1425 + 3001) });
    expect(report.parts.model.totalMs).toBe(3550 + 1410 + 2995);
    expect(report.parts.tools).toEqual({ p50: 0, p90: 960, totalMs: 1200 });
    expect(report.explained).toBeCloseTo((3550 + 1410 + 2995 + 1200) / 10_500);
    // The aborted call reports no usage, so token spreads cover the two answered turns only.
    expect(report.outputTokens).toEqual({ p50: 210, p90: 362 });
    expect(report.outputTokensPerSecond.p50).toBeCloseTo((400 / 3 + 20) / 2);
  });

  it('leaves the request bytes the model sees unchanged', () => {
    const untimed = thinkingThenAnswer.map((event) => {
      if (event.kind === 'session-start' || !('timing' in event)) return event;
      const { timing: _timing, ...rest } = event;
      return rest as TurnEvent;
    });
    expect(untimed).not.toEqual(thinkingThenAnswer);
    const session = start.kind === 'session-start' ? start.session : undefined;
    expect(JSON.stringify(buildRequest(session!, thinkingThenAnswer))).toBe(JSON.stringify(buildRequest(session!, untimed)));
  });
});
