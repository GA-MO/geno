import type * as acp from '@agentclientprotocol/sdk';
import { COMPACT_META, compactNotice, type CompactMark } from '@g-code/core';
import { describe, expect, it } from 'vitest';
import { agentChunkAction } from '../src/chat/compact-host.js';
import { compactLook } from '../src/chat/compact-model.js';
import { shownSteps } from '../src/chat/fold.js';
import type { Action, Transcript } from '../src/chat/messages.js';
import { railOf } from '../src/chat/rail.js';
import { emptyTranscript, reduce } from '../src/chat/transcript.js';

const run = (actions: readonly Action[], start: Transcript = emptyTranscript('qwen3.8-flash')): Transcript => actions.reduce(reduce, start);

const MARK: CompactMark = {
  seq: 7,
  trigger: 'auto',
  tokensBefore: 812_400,
  tokensAfter: 24_310,
  summary: '## Goal\nShip the parser.\n\n## Next steps\nRun the tests.',
  files: { read: ['src/parse.ts'], changed: ['src/parse.ts', 'test/parse.test.ts'] },
};

/** The chunk the engine sends for a compaction, as session-replay's compactUpdate builds it. */
const compactChunk = (mark: CompactMark): Extract<acp.SessionUpdate, { sessionUpdate: 'agent_message_chunk' }> => ({
  sessionUpdate: 'agent_message_chunk',
  content: { type: 'text', text: compactNotice(mark) },
  _meta: { [COMPACT_META]: mark },
});

const agentText = (text: string) => agentChunkAction({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text } })!;

const T0 = 1_000_000;
const start: Action = { type: 'turn-start', id: 't1', at: T0, prompt: 'Keep going' };
const read: Action = { type: 'tool', id: 'tu_r', at: T0 + 10, name: 'read', target: 'src/parse.ts', toolKind: 'read', status: 'completed' };
const compacting: Action = { type: 'notice', text: 'Compacting the context' };
const end: Action = { type: 'turn-end', at: T0 + 900, status: 'done', usage: undefined };

describe('a compaction in the transcript', () => {
  it('becomes a divider block where it landed, and its words for other clients are not model text', () => {
    const transcript = run([start, agentText('Reading.'), read, agentChunkAction(compactChunk(MARK))!, agentText('Done.'), end]);
    const turn = transcript.turns[0]!;
    expect(turn.blocks.map((block) => block.kind)).toEqual(['text', 'tool', 'compact', 'text']);
    expect(turn.blocks[2]).toEqual({ kind: 'compact', id: 'compact:7', mark: MARK });
    const texts = turn.blocks.flatMap((block) => (block.kind === 'text' ? [block.text] : []));
    expect(texts.join('')).not.toContain('Context compacted');
    expect(railOf(turn).map((step) => step.kind)).toEqual(['text', 'calls', 'compact', 'text']);
  });

  it('a chunk without the mark, or with a malformed one, stays model text', () => {
    expect(agentText('[Context compacted: 1 → about 0 tokens]')).toEqual({ type: 'text', text: '[Context compacted: 1 → about 0 tokens]' });
    const broken = agentChunkAction({ ...compactChunk(MARK), _meta: { [COMPACT_META]: { seq: 'x' } } });
    expect(broken).toEqual({ type: 'text', text: compactNotice(MARK) });
  });

  it('clears the "Compacting the context" notice when it lands', () => {
    const before = run([start, read, compacting]);
    expect(before.turns[0]!.notice).toBe('Compacting the context');
    expect(railOf(before.turns[0]!).at(-1)?.kind).toBe('notice');
    const after = run([agentChunkAction(compactChunk(MARK))!], before);
    expect(after.turns[0]!.notice).toBeUndefined();
    expect(railOf(after.turns[0]!).map((step) => step.kind)).toEqual(['calls', 'compact', 'thinking']);
  });

  it('a replay gives the same block, and a live chunk repeated by a replay stays one divider', () => {
    const live = run([start, read, compacting, agentChunkAction(compactChunk(MARK))!, agentText('Done.'), end]);
    const replayed = run([start, read, agentChunkAction(compactChunk(MARK))!, agentText('Done.'), end]);
    expect(replayed.turns[0]!.blocks).toEqual(live.turns[0]!.blocks);
    const twice = run([start, agentChunkAction(compactChunk(MARK))!, agentChunkAction(compactChunk(MARK))!]);
    expect(twice.turns[0]!.blocks.filter((block) => block.kind === 'compact')).toHaveLength(1);
  });

  it('a manual /compact is a turn of its own, with its chip and the divider', () => {
    const manual: CompactMark = { ...MARK, trigger: 'manual', focus: 'the parser' };
    const transcript = run([
      { type: 'turn-start', id: 't2', at: T0, prompt: '/compact the parser', command: { name: 'compact', args: 'the parser', route: 'engine' } },
      compacting,
      agentChunkAction(compactChunk(manual))!,
      end,
    ]);
    const turn = transcript.turns[0]!;
    expect(turn.command).toEqual({ name: 'compact', args: 'the parser', route: 'engine' });
    expect(turn.seq).toBeUndefined();
    expect(turn.blocks.map((block) => block.kind)).toEqual(['compact']);
  });

  it('stays in view when compact detail folds the turn', () => {
    const turn = run([start, agentText('Reading.'), read, read, read, read, read, agentChunkAction(compactChunk(MARK))!, { ...read, id: 'tu_2' }, agentText('All done.'), end]).turns[0]!;
    const shown = shownSteps(turn, 'compact', false).map((step) => step.kind);
    expect(shown).toContain('compact');
    expect(shown).not.toContain('calls');
  });

  it('a subagent compacting shows on its own rail', () => {
    const transcript = run([
      start,
      { type: 'tool', id: 'tu_agent', at: T0 + 1, name: 'agent', target: 'explore', toolKind: 'other', status: 'running' },
      { type: 'child-start', id: 'kid', toolId: 'tu_agent', role: 'explore', task: 'Look around', model: 'qwen3.8-flash', at: T0 + 2 },
      { type: 'child', id: 'kid', action: agentChunkAction(compactChunk(MARK)) as Extract<Action, { type: 'compact' }> },
    ]);
    expect(transcript.turns[0]!.children!['kid']!.turn.blocks.map((block) => block.kind)).toEqual(['compact']);
  });
});

describe('how a divider reads', () => {
  it('gives the counts, the after one as an estimate', () => {
    expect(compactLook(MARK)).toEqual({ title: 'Context compacted', numbers: '812,400 → about 24,310 tokens', reason: 'Geno compacted on its own before the context filled.', focus: undefined });
  });

  it('says the model refused the request for an overflow', () => {
    expect(compactLook({ ...MARK, trigger: 'overflow' }).reason).toBe('The model refused the request as too long, so Geno compacted and sent it again.');
  });

  it('shows a manual one’s focus, and no reason, since the /compact turn says it', () => {
    expect(compactLook({ ...MARK, trigger: 'manual', focus: 'the parser' })).toMatchObject({ reason: undefined, focus: 'the parser' });
    expect(compactLook({ ...MARK, trigger: 'manual' }).focus).toBeUndefined();
  });
});
