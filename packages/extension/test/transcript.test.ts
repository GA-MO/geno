import { describe, expect, it } from 'vitest';
import { formatCost, formatDuration, formatTokens } from '../src/chat/format.js';
import type { Action, FileDiff, Transcript } from '../src/chat/messages.js';
import { emptyTranscript, isRunning, reduce, totalsOf } from '../src/chat/transcript.js';

const run = (actions: readonly Action[], start: Transcript = emptyTranscript('qwen3.8-flash')): Transcript => actions.reduce(reduce, start);

const DIFF: FileDiff = {
  path: 'a.ts',
  change: 'c1',
  hunks: [
    { id: 'c1:0', line: 2, removed: ['  return a + b;'], added: ['  return b + a;'], status: 'pending' },
    { id: 'c1:1', line: 7, removed: [], added: ['export const four = 4;'], status: 'pending' },
  ],
};

const usage = { model: 'qwen3.8-flash', inputTokens: 1200, outputTokens: 40, costUsd: 0.0002 };

describe('the transcript reducer', () => {
  it('joins streamed text into one block until a tool call comes between', () => {
    const t = run([
      { type: 'turn-start', id: 't1', at: 0, prompt: 'Swap it' },
      { type: 'text', text: 'Read' },
      { type: 'text', text: 'ing.' },
      { type: 'tool', id: 'tu1', at: 100, name: 'read', target: 'a.ts', toolKind: 'read', status: 'running' },
      { type: 'text', text: 'Done.' },
    ]);
    expect(t.turns[0]!.blocks.map((b) => (b.kind === 'text' ? b.text : b.kind))).toEqual(['Reading.', 'tool', 'Done.']);
    expect(isRunning(t)).toBe(true);
  });

  it('shows a notice only while it is the newest thing in a running turn', () => {
    const retrying = run([
      { type: 'turn-start', id: 't1', at: 0, prompt: 'p' },
      { type: 'notice', text: 'Retrying in 1s (model overloaded)' },
    ]);
    expect(retrying.turns[0]!.notice).toBe('Retrying in 1s (model overloaded)');
    expect(run([{ type: 'text', text: 'Back.' }], retrying).turns[0]!.notice).toBeUndefined();
    expect(run([{ type: 'tool', id: 'tu1', at: 1, name: 'read', status: 'running' }], retrying).turns[0]!.notice).toBeUndefined();
    const ended = run([{ type: 'turn-end', at: 1, status: 'failed', usage: undefined }], retrying);
    expect(ended.turns[0]!.notice).toBeUndefined();
    expect(run([{ type: 'notice', text: 'late' }], ended).turns[0]!.notice).toBeUndefined();
  });

  it('times a tool call from its start to its first end, and keeps fields an update leaves out', () => {
    const t = run([
      { type: 'turn-start', id: 't1', at: 0, prompt: 'p' },
      { type: 'tool', id: 'tu1', at: 100, name: 'bash', target: 'npm test', toolKind: 'execute', status: 'running' },
      { type: 'tool', id: 'tu1', at: 350, status: 'completed' },
      { type: 'tool', id: 'tu1', at: 900, status: 'completed', output: 'ok' },
    ]);
    expect(t.turns[0]!.blocks[0]).toMatchObject({ name: 'bash', target: 'npm test', status: 'completed', startedAt: 100, endedAt: 350, output: 'ok' });
  });

  it('puts a write on its tool call even when the write arrives first', () => {
    const t = run([
      { type: 'turn-start', id: 't1', at: 0, prompt: 'p' },
      { type: 'diff', toolId: 'tu1', at: 100, diff: DIFF },
      { type: 'tool', id: 'tu1', at: 100, name: 'edit', target: 'a.ts', toolKind: 'edit', status: 'running' },
    ]);
    expect(t.turns[0]!.blocks).toHaveLength(1);
    expect(t.turns[0]!.blocks[0]).toMatchObject({ kind: 'tool', name: 'edit', diff: DIFF });
  });

  it('takes review decisions from any surface, and returns the same transcript when nothing changed', () => {
    const before = run([
      { type: 'turn-start', id: 't1', at: 0, prompt: 'p' },
      { type: 'diff', toolId: 'tu1', at: 1, diff: DIFF },
      { type: 'text', text: 'after' },
    ]);
    const after = reduce(before, { type: 'review', hunks: { 'c1:0': 'kept', 'other:0': 'undone' } });
    const tool = after.turns[0]!.blocks[0]!;
    expect(tool.kind === 'tool' && tool.diff!.hunks.map((h) => h.status)).toEqual(['kept', 'pending']);
    expect(after.turns[0]!.blocks[1]).toBe(before.turns[0]!.blocks[1]);
    expect(reduce(after, { type: 'review', hunks: { 'c1:0': 'kept' } })).toBe(after);
  });

  it('ends a turn by cancelling what still runs or waits, and closes an answered permission once', () => {
    const t = run([
      { type: 'turn-start', id: 't1', at: 0, prompt: 'p' },
      { type: 'permission', id: '0', command: 'rm -rf build', reason: 'rm -rf of a path inside the workspace', options: [] },
      { type: 'permission-done', id: '0', optionId: 'reject' },
      { type: 'permission-done', id: '0', optionId: undefined },
      { type: 'permission', id: '1', command: 'git push', reason: 'a push', options: [] },
      { type: 'tool', id: 'tu1', at: 1, name: 'bash', status: 'running' },
      { type: 'turn-end', at: 1, status: 'stopped', usage: undefined },
    ]);
    expect(t.turns[0]!.blocks.map((b) => (b.kind === 'permission' ? b.outcome : b.kind === 'tool' ? b.status : b.kind))).toEqual([
      { kind: 'chosen', optionId: 'reject' },
      { kind: 'cancelled' },
      'cancelled',
    ]);
    expect(t.turns[0]!.status).toBe('stopped');
    expect(isRunning(t)).toBe(false);
  });

  it('keeps remember and ask_user cards as permissions, so they wait like one, and settles a question with its answer', () => {
    const t = run([
      { type: 'turn-start', id: 't1', at: 0, prompt: 'p' },
      { type: 'permission', id: '0', command: 'Use pnpm.', reason: '', options: [], ask: { kind: 'memory', text: 'Use pnpm.', scope: 'project' } },
      { type: 'permission-done', id: '0', optionId: 'allow' },
      { type: 'permission', id: '1', command: 'Which?', reason: '', options: [], ask: { kind: 'question', request: { questions: [{ id: 'choice', header: 'Question', question: 'Which?', multiSelect: false, options: [{ label: 'a' }, { label: 'b' }] }] } } },
      { type: 'permission-done', id: '1', optionId: undefined, answer: { kind: 'answered', answers: { choice: { picked: ['b'] } } } },
      { type: 'permission', id: '2', command: 'Why?', reason: '', options: [], ask: { kind: 'question', request: { questions: [{ id: 'choice', header: 'Question', question: 'Why?', multiSelect: false, options: [] }] } } },
    ]);
    const blocks = t.turns[0]!.blocks;
    expect(blocks.map((b) => (b.kind === 'permission' ? [b.ask?.kind, b.outcome] : b.kind))).toEqual([
      ['memory', { kind: 'chosen', optionId: 'allow' }],
      ['question', { kind: 'answered', answers: { choice: { picked: ['b'] } } }],
      ['question', { kind: 'open' }],
    ]);
    const ended = reduce(t, { type: 'turn-end', at: 1, status: 'stopped', usage: undefined });
    expect(ended.turns[0]!.blocks.at(-1)).toMatchObject({ outcome: { kind: 'cancelled' } });
  });

  it('settles a declined question card as skipped', () => {
    const request = { questions: [{ id: 'choice', header: 'Question', question: 'Why?', multiSelect: false, options: [] }] };
    const t = run([
      { type: 'turn-start', id: 't1', at: 0, prompt: 'p' },
      { type: 'permission', id: '0', command: 'Why?', reason: '', options: [], ask: { kind: 'question', request } },
      { type: 'permission-done', id: '0', optionId: undefined, answer: { kind: 'declined' } },
    ]);
    expect(t.turns[0]!.blocks[0]).toMatchObject({ outcome: { kind: 'skipped' } });
  });

  it('replays to the same transcript a reset carries, so a reloaded view matches the extension', () => {
    const actions: Action[] = [
      { type: 'turn-start', id: 't1', at: 0, prompt: 'p' },
      { type: 'text', text: 'Hi' },
      { type: 'turn-end', at: 1, status: 'done', usage },
    ];
    const live = run(actions);
    expect(run([{ type: 'reset', transcript: live }], emptyTranscript('other'))).toEqual(live);
  });

  it('totals the session over turns that reported usage, and knows no cost when one turn had none', () => {
    const t = run([
      { type: 'turn-start', id: 't1', at: 0, prompt: 'p' },
      { type: 'turn-end', at: 1, status: 'done', usage },
      { type: 'turn-start', id: 't2', at: 0, prompt: 'p' },
      { type: 'turn-end', at: 1, status: 'failed', usage: undefined },
      { type: 'turn-start', id: 't3', at: 0, prompt: 'p' },
      { type: 'turn-end', at: 1, status: 'done', usage },
    ]);
    expect(totalsOf(t)).toEqual({ inputTokens: 2400, outputTokens: 80, costUsd: 0.0004, turns: 2 });
    expect(totalsOf(run([{ type: 'turn-start', id: 't4', at: 0, prompt: 'p' }, { type: 'turn-end', at: 1, status: 'done', usage: { ...usage, costUsd: null } }], t)).costUsd).toBeNull();
  });
});

describe('panel number formats', () => {
  it('writes tokens, costs and durations the way the footer shows them', () => {
    expect([842, 1234, 56_789, 2_345_678].map(formatTokens)).toEqual(['842', '1.2k', '57k', '2.3M']);
    expect([0, 0.00042, 0.5].map(formatCost)).toEqual(['$0.00', '$0.0004', '$0.50']);
    expect([42, 2345, 42_000, 125_000].map(formatDuration)).toEqual(['42ms', '2.3s', '42s', '2m 5s']);
  });
});
