import { describe, expect, it } from 'vitest';
import type { ChapterMark } from '@g-code/core';
import { callAnchor, currentEntry, defaultTitle, START_ANCHOR, tableOf, turnAnchor } from '../src/chat/chapter-model.js';
import { shownSteps, summaryOf } from '../src/chat/fold.js';
import type { Action, Transcript } from '../src/chat/messages.js';
import { railOf, type Step } from '../src/chat/rail.js';
import { emptyTranscript, reduce } from '../src/chat/transcript.js';

const run = (actions: readonly Action[], from: Transcript = emptyTranscript('qwen3.8-flash')): Transcript => actions.reduce(reduce, from);
const start = (id: string, chapter?: ChapterMark): Action => ({ type: 'turn-start', id, at: 1000, prompt: `prompt of ${id}`, seq: Number(id.slice(1)), ...(chapter === undefined ? {} : { chapter }) });
const end: Action = { type: 'turn-end', at: 9000, status: 'done', usage: undefined };
const call = (id: string, name: string, status: 'running' | 'completed' | 'failed' = 'completed', chapter?: ChapterMark): Action => ({
  type: 'tool',
  id,
  at: 2000,
  name,
  target: '',
  toolKind: name === 'read' ? 'read' : name === 'grep' ? 'search' : 'other',
  status,
  ...(chapter === undefined ? {} : { chapter }),
});
const mark = (id: string, title: string, summary?: string): Action => call(id, 'mark_chapter', 'completed', { title, ...(summary === undefined ? {} : { summary }) });
const names = (steps: readonly Step[]) => steps.map((s) => (s.kind === 'chapter' ? `chapter:${s.tool.chapter.title}` : s.kind === 'calls' ? `calls:${s.name}` : s.kind));

describe('chapters on the rail', () => {
  it('draws a mark_chapter call that ran as its divider, and keeps a running or refused one a call', () => {
    const t = run([start('t1'), call('r1', 'read'), mark('c1', 'Parser fix'), call('c2', 'mark_chapter', 'failed'), call('c3', 'mark_chapter', 'running')]);
    expect(names(railOf(t.turns[0]!))).toEqual(['calls:read', 'chapter:Parser fix', 'calls:mark_chapter', 'calls:mark_chapter']);
  });

  it('keeps the divider in view in a folded compact turn, and does not count the call as work', () => {
    const t = run([start('t1'), call('r1', 'read'), mark('c1', 'Parser fix'), call('g1', 'grep'), { type: 'text', text: 'Fixed it.' }, end]);
    expect(names(shownSteps(t.turns[0]!, 'compact', false))).toEqual(['fold', 'chapter:Parser fix', 'text']);
    expect(summaryOf(t.turns[0]!).kinds.other).toBe(0);
  });
});

describe("the user's chapter", () => {
  it('lands on its turn from a replay, and the live mark, rename and removal change only that turn', () => {
    const replayed = run([start('t1', { title: 'Exploration' }), end, start('t7'), end]);
    expect(replayed.turns.map((turn) => turn.chapter?.title)).toEqual(['Exploration', undefined]);
    const marked = reduce(replayed, { type: 'chapter', turn: 't7', mark: { title: 'Tests' } });
    expect(marked.turns.map((turn) => turn.chapter?.title)).toEqual(['Exploration', 'Tests']);
    expect(marked.turns[0]).toBe(replayed.turns[0]);
    const removed = reduce(marked, { type: 'chapter', turn: 't1', mark: null });
    expect(removed.turns[0]).not.toHaveProperty('chapter');
    expect(reduce(removed, { type: 'chapter', turn: 'gone', mark: { title: 'x' } })).toBe(removed);
  });
});

describe('the table of contents', () => {
  it('lists nothing for a chat without chapters', () => {
    expect(tableOf(run([start('t1'), call('r1', 'read'), end]))).toEqual([]);
  });

  it("opens with the chat's start, then every chapter in transcript order, the user's and the agent's", () => {
    const t = run([start('t1'), call('r1', 'read'), mark('c1', 'Parser fix', 'The off-by-one.'), end, start('t7', { title: 'Release notes' }), mark('c2', 'Changelog'), end]);
    expect(tableOf(t)).toEqual([
      { anchor: START_ANCHOR, title: 'Start', summary: undefined, by: 'start' },
      { anchor: callAnchor('c1'), title: 'Parser fix', summary: 'The off-by-one.', by: 'agent' },
      { anchor: turnAnchor('t7'), title: 'Release notes', summary: undefined, by: 'user' },
      { anchor: callAnchor('c2'), title: 'Changelog', summary: undefined, by: 'agent' },
    ]);
  });

  it("leaves the start out when the user's own chapter opens the chat, and lists no refused call", () => {
    const t = run([start('t1', { title: 'Exploration' }), call('c1', 'mark_chapter', 'failed'), end]);
    expect(tableOf(t).map((entry) => entry.title)).toEqual(['Exploration']);
  });

  it('marks as current the last chapter whose divider passed the reading line, and the start above the first', () => {
    const tops = [-Infinity, 300, 900, undefined, 1500];
    expect(currentEntry(tops, 100)).toBe(0);
    expect(currentEntry(tops, 300)).toBe(1);
    expect(currentEntry(tops, 1000)).toBe(2);
    expect(currentEntry(tops, 1600), 'an anchor not drawn is skipped').toBe(4);
  });
});

describe('the title field', () => {
  it("starts with the message's first line, cut at a word to 40 characters", () => {
    expect(defaultTitle('  Fix the parser\nand then the tests')).toBe('Fix the parser');
    expect(defaultTitle('Now write the release notes for the date parser change and its tests')).toBe('Now write the release notes for the date');
    expect(defaultTitle('x'.repeat(60))).toHaveLength(40);
  });
});
