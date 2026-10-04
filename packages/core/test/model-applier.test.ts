import { describe, expect, it } from 'vitest';
import type { StopReason } from '@anthropic-ai/sdk/resources/messages/messages';
import { modelApplier, type ModelCall, type TurnEvent, type TurnResult } from '../src/index.js';

type Use = { readonly name?: string; readonly old: string; readonly new: string };

const turn = (uses: readonly Use[], stopReason: StopReason = uses.length > 0 ? 'tool_use' : 'end_turn'): TurnResult => ({
  kind: 'answer',
  turn: {
    content: uses.map((use, i) => ({
      type: 'tool_use',
      id: `tu_${i}_${use.old}`,
      name: use.name ?? 'edit',
      input: { path: 'f.txt', old_str: use.old, new_str: use.new },
      caller: { type: 'direct' },
    })),
    stopReason,
    usage: { input: 10, cacheRead: 0, cacheWrite: 0, output: 5 },
    costUsd: 0.001,
    latencyMs: 1,
    model: 'fake',
  },
});

function script(...turns: TurnResult[]) {
  const seen: (readonly TurnEvent[])[] = [];
  const call: ModelCall = async (events) => {
    seen.push([...events]);
    const next = turns[seen.length - 1];
    if (next === undefined) throw new Error(`no scripted turn ${seen.length}`);
    return next;
  };
  return { call, seen };
}

const apply = (call: ModelCall) =>
  modelApplier('str_replace', 'fake', call).apply({ path: 'f.txt', before: 'a\nb\nc\n', instruction: 'shout' });

const errorResults = (events: readonly TurnEvent[]) =>
  events.filter((e) => e.kind === 'tool-result' && e.status === 'error').length;

describe('modelApplier', () => {
  it('sends every failed call of a turn back at once and counts the turn as one retry', async () => {
    const { call, seen } = script(
      turn([{ old: 'x', new: 'X' }, { old: 'y', new: 'Y' }, { old: 'z', new: 'Z' }]),
      turn([{ old: 'a', new: 'A' }]),
      turn([]),
    );
    const { outcome, attempt } = await apply(call);
    expect(outcome).toEqual({ kind: 'applied', after: 'A\nb\nc\n' });
    expect(errorResults(seen[1]!)).toBe(3);
    expect(attempt).toMatchObject({ firstTry: 'zero-matches', retries: 1, calls: 3, costUsd: 0.003 });
  });

  it('fails when the last turn of edits left a failure, whatever the order of its calls', async () => {
    for (const uses of [
      [{ old: 'x', new: 'X' }, { old: 'b', new: 'B' }],
      [{ old: 'b', new: 'B' }, { old: 'x', new: 'X' }],
    ]) {
      const { outcome } = await apply(script(turn(uses), turn([])).call);
      expect(outcome).toMatchObject({ kind: 'failed', reason: 'zero-matches' });
    }
  });

  it('gives up after the third turn with a failure, having retried twice', async () => {
    const miss = turn([{ old: 'x', new: 'X' }]);
    const { call, seen } = script(miss, miss, miss);
    const { outcome, attempt } = await apply(call);
    expect(seen).toHaveLength(3);
    expect(outcome).toMatchObject({ kind: 'failed', reason: 'zero-matches' });
    expect(attempt).toMatchObject({ retries: 2, calls: 3 });
  });

  it('names a call to a tool that does not exist as wrong-tool', async () => {
    const { outcome, attempt } = await apply(script(turn([{ name: 'read', old: 'a', new: 'A' }]), turn([])).call);
    expect(attempt?.firstTry).toBe('wrong-tool');
    expect(outcome).toMatchObject({ kind: 'failed', reason: 'wrong-tool' });
  });

  it('never applies an edit cut short by max_tokens', async () => {
    const { outcome } = await apply(script(turn([{ old: 'a', new: 'A' }], 'max_tokens')).call);
    expect(outcome).toMatchObject({ kind: 'failed', reason: 'model-error' });
  });
});
