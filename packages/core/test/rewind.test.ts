import { describe, expect, it } from 'vitest';
import {
  asSessionId,
  checkpointOfTurn,
  cutView,
  forkEvents,
  nextSeq,
  promptAt,
  replayMessages,
  reviewState,
  summarizeSession,
  toolUsesFrom,
  type Session,
  type TurnEvent,
} from '../src/index.js';

const at = '2026-10-07T00:00:01.000Z';
const session: Session = { id: asSessionId('s1'), createdAt: at, workspace: '/tmp/ws', provider: 'modelstudio', model: 'qwen3.8-flash', effort: 'medium' };
const start: TurnEvent = { kind: 'session-start', session };
const user = (seq: number, content: string): TurnEvent => ({ kind: 'user', seq, at, content });
const steer = (seq: number, content: string): TurnEvent => ({ kind: 'user', seq, at, content, steer: true });
const report = (seq: number, content: string): TurnEvent => ({ kind: 'user', seq, at, content, steer: true, from: 'child' });
const assistant = (seq: number, text: string, toolIds: string[] = []): TurnEvent => ({
  kind: 'assistant',
  seq,
  at,
  content: [{ type: 'text', text, citations: null }, ...toolIds.map((id) => ({ type: 'tool_use' as const, id, name: 'bash', input: {}, caller: { type: 'direct' as const } }))],
  stopReason: toolIds.length === 0 ? 'end_turn' : 'tool_use',
  usage: { input: 1, cacheRead: 0, cacheWrite: 0, output: 1 },
  costUsd: 0.01,
  latencyMs: 1,
  model: 'qwen3.8-flash',
});
const result = (seq: number, toolUseId: string): TurnEvent => ({ kind: 'tool-result', seq, at, toolUseId, name: 'bash', status: 'ok', output: 'ran' });
const checkpoint = (seq: number, sha: string): TurnEvent => ({ kind: 'checkpoint', seq, at, sessionId: session.id, turnSeq: seq + 1, sha, files: [], label: `before turn ${seq + 1}` });
const childStart = (seq: number, toolUseId: string, child: string): TurnEvent => ({
  kind: 'child-start',
  seq,
  at,
  child: asSessionId(child),
  toolUseId,
  role: 'explore',
  model: 'qwen3.8-flash',
  effort: 'medium',
  caps: { maxTurns: 3, maxCostUsd: 0.05 },
  start: 'fresh',
});
const childEnd = (seq: number, toolUseId: string, child: string): TurnEvent => ({ kind: 'child-end', seq, at, child: asSessionId(child), toolUseId, end: { kind: 'done' }, turns: 1, costUsd: 0.01, summary: 'found it' });
const backgroundEnd = (seq: number, toolUseId: string): TurnEvent => ({
  kind: 'background-end',
  seq,
  at,
  job: { id: 'bg-1', toolUseId, command: 'sleep 9', state: { status: 'stopped', by: 'user' } },
  tail: '',
});
const cut = (seq: number, turnSeq: number): TurnEvent => ({ kind: 'cut', seq, at, turnSeq });
const mode = (seq: number): TurnEvent => ({ kind: 'mode', seq, at, mode: 'auto' });
const title = (seq: number): TurnEvent => ({ kind: 'title', seq, at, title: 'named' });

/**
 * Three turns. Turn 1 (seq 1) runs a tool, takes a steer after its result, and starts a child. Turn 2 (seq 9) runs a
 * tool too, and the user switched the mode and named the session during it. Turn 3 (seq 16) only answers.
 */
const log: readonly TurnEvent[] = [
  start,
  user(1, 'first'),
  checkpoint(2, 'sha-1'),
  assistant(3, 'running', ['t1']),
  result(4, 't1'),
  steer(5, 'also this'),
  childStart(6, 't1', 'c1'),
  childEnd(7, 't1', 'c1'),
  assistant(8, 'done one'),
  user(9, 'second'),
  checkpoint(10, 'sha-2'),
  assistant(11, 'running', ['t2']),
  mode(12),
  result(13, 't2'),
  title(14),
  assistant(15, 'done two'),
  user(16, 'third'),
  checkpoint(17, 'sha-3'),
  assistant(18, 'done three'),
];

const seqs = (events: readonly TurnEvent[]) => events.map((e) => (e.kind === 'session-start' ? 0 : e.seq));
const upTo = (seq: number) => log.filter((e) => e.kind === 'session-start' || (e.seq !== undefined && e.seq < seq));

describe('cutView', () => {
  it.each([
    { name: 'a log without cuts is unchanged', events: log, want: seqs(log) },
    { name: 'a cut at turn 3 drops it and stands in its place', events: [...log, cut(19, 16)], want: [...seqs(upTo(16)), 19] },
    { name: 'a cut at turn 2 keeps the mode and title logged during it', events: [...log, cut(19, 9)], want: [...seqs(upTo(9)), 12, 14, 19] },
    { name: 'a cut at turn 1 leaves the start, the settings and itself', events: [...log, cut(19, 1)], want: [0, 12, 14, 19] },
    { name: 'a later cut further back cuts the first one too', events: [...log, cut(19, 16), user(20, 'again'), cut(21, 9)], want: [...seqs(upTo(9)), 12, 14, 21] },
    { name: 'a cut at a steer cuts nothing', events: [...log, cut(19, 5)], want: [...seqs(log), 19] },
    { name: 'a cut at a seq already cut cuts nothing more', events: [...log, cut(19, 9), cut(20, 16)], want: [...seqs(upTo(9)), 12, 14, 19, 20] },
  ])('$name', ({ events, want }) => {
    expect(seqs(cutView(events))).toEqual(want);
  });

  it('goes on numbering after the cut', () => {
    expect(nextSeq(cutView([...log, cut(19, 9)]))).toBe(20);
  });

  it('keeps turn 1 steer and child events in place when cutting turn 2', () => {
    const view = cutView([...log, cut(19, 9)]);
    expect(view.slice(0, 9)).toEqual(log.slice(0, 9));
  });

  it('sends the model the conversation before the cut, then the new prompt', () => {
    const view = [...cutView([...log, cut(19, 9)]), user(20, 'second, better')];
    expect(replayMessages(view)).toEqual(replayMessages([...upTo(9), user(20, 'second, better')]));
  });

  it.each([
    { name: 'drops the end of a background command a cut turn started', tool: 't2', kept: false },
    { name: 'keeps the end of a background command a kept turn started', tool: 't1', kept: true },
  ])('$name', ({ tool, kept }) => {
    const view = cutView([...log, cut(19, 9), backgroundEnd(20, tool)]);
    expect(view.some((e) => e.kind === 'background-end')).toBe(kept);
  });

  it('drops a cut turn restore, whose notice is about turns that are gone', () => {
    const restored: TurnEvent = { kind: 'restored', seq: 19, at, turnSeq: 18, sha: 'sha-3', files: ['a.ts'] };
    expect(cutView([...log, restored, cut(20, 16)]).some((e) => e.kind === 'restored')).toBe(false);
  });

  it('counts only the turns left in the history', () => {
    expect(summarizeSession(session, cutView([...log, cut(19, 9)])).turns).toBe(1);
  });

  it('drops the hunks of a cut edit from review', () => {
    const edit: TurnEvent = {
      kind: 'tool-result',
      seq: 13,
      at,
      toolUseId: 't2',
      name: 'edit',
      status: 'ok',
      output: 'edited',
      change: { id: 'e1', path: '/tmp/ws/a.ts', hunks: [{ startLine: 1, lineCount: 1, oldText: 'a\n', newText: 'b\n', status: 'pending' }] },
    };
    const edited = log.map((e) => (e.kind === 'tool-result' && e.seq === 13 ? edit : e));
    expect(reviewState(edited)).toHaveLength(1);
    expect(reviewState(cutView([...edited, cut(19, 9)]))).toEqual([]);
  });
});

describe('the turn under a prompt', () => {
  it.each([
    { turnSeq: 1, prompt: 'first', sha: 'sha-1' },
    { turnSeq: 9, prompt: 'second', sha: 'sha-2' },
    { turnSeq: 16, prompt: 'third', sha: 'sha-3' },
    { turnSeq: 5, prompt: undefined, sha: undefined },
    { turnSeq: 4, prompt: undefined, sha: undefined },
  ])('turn $turnSeq: prompt $prompt, checkpoint $sha', ({ turnSeq, prompt, sha }) => {
    expect(promptAt(log, turnSeq)?.content).toBe(prompt);
    expect(checkpointOfTurn(log, turnSeq)?.sha).toBe(sha);
  });

  it('lists the tool calls a cut drops, the ones whose background commands it stops', () => {
    expect([...toolUsesFrom(log, 9)]).toEqual(['t2']);
    expect([...toolUsesFrom(log, 1)]).toEqual(['t1', 't2']);
  });
});

describe('forkEvents', () => {
  const fork = { id: asSessionId('f1'), createdAt: '2026-10-07T00:00:02.000Z', title: 'first' };

  it('starts a session of its own that says where it came from', () => {
    const head = forkEvents(log, 1, fork)![0];
    expect(head).toEqual({ kind: 'session-start', session: { ...session, id: fork.id, createdAt: fork.createdAt }, fork: { sessionId: session.id, turnSeq: 1, title: 'first' } });
  });

  it.each([
    { name: 'turn 1, with its steer and child events in place', turnSeq: 1, want: seqs(upTo(9)) },
    { name: 'turn 2, with the mode and title logged during it', turnSeq: 9, want: seqs(upTo(16)) },
    { name: 'the last turn, to the end of the log', turnSeq: 16, want: seqs(log) },
  ])('copies up to and including $name', ({ turnSeq, want }) => {
    expect(seqs(forkEvents(log, turnSeq, fork)!)).toEqual(want);
  });

  it('copies the events of turn 1 as they are, but the checkpoint, which takes the fork id', () => {
    const copied = forkEvents(log, 1, fork)!.slice(1);
    expect(copied).toEqual(log.slice(1, 9).map((e) => (e.kind === 'checkpoint' ? { ...e, sessionId: fork.id } : e)));
    expect(copied.filter((e) => e.kind === 'user').map((e) => e.kind === 'user' && e.steer)).toEqual([undefined, true]);
  });

  it('sends the model what the source sent it for the same turns', () => {
    expect(replayMessages(forkEvents(log, 9, fork)!)).toEqual(replayMessages(upTo(16)));
  });

  it('forks the source as of its cuts, without the cut itself', () => {
    const forked = forkEvents([...log, cut(19, 9), user(20, 'second, better'), assistant(21, 'done better')], 20, fork)!;
    expect(seqs(forked)).toEqual([...seqs(upTo(9)), 12, 14, 20, 21]);
  });

  it('keeps a background child report inside its turn', () => {
    const events = [...upTo(9), report(9, 'explore reported back'), assistant(10, 'thanks'), user(11, 'next'), assistant(12, 'ok')];
    expect(seqs(forkEvents(events, 1, fork)!)).toEqual([...seqs(upTo(9)), 9, 10]);
  });

  it('leaves out a wait, which the engine would take up again', () => {
    const wait: TurnEvent = { kind: 'wait', seq: 19, at, wait: { kind: 'offline', since: 1, retryAt: null, resetAt: null, message: 'offline' } };
    expect(forkEvents([...log, wait], 16, fork)!.some((e) => e.kind === 'wait')).toBe(false);
  });

  it.each([
    { name: 'a steer', turnSeq: 5 },
    { name: 'a tool result', turnSeq: 4 },
    { name: 'a cut prompt', turnSeq: 16, events: [...log, cut(19, 9)] },
  ])('forks nothing at $name', ({ turnSeq, events }) => {
    expect(forkEvents(events ?? log, turnSeq, fork)).toBeUndefined();
  });

  it('lists in the history with its origin', () => {
    const forked = forkEvents(log, 1, fork)!;
    expect(summarizeSession((forked[0] as Extract<TurnEvent, { kind: 'session-start' }>).session, forked).forkedFrom).toEqual({ sessionId: session.id, turnSeq: 1, title: 'first' });
  });
});
