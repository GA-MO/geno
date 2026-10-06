import type { MessageParam } from '@anthropic-ai/sdk/resources/messages/messages';
import { describe, expect, it } from 'vitest';
import {
  asSessionId,
  COMPACT_AT,
  compactAtTokens,
  compactedText,
  compactionEvent,
  contextTokens,
  contextView,
  cutView,
  eventTokens,
  forkEvents,
  hasPendingPrompt,
  KEEP_TAIL_TOKENS,
  keepTailTokens,
  lastContextUse,
  loadedTools,
  loopStep,
  planCompaction,
  replayMessages,
  autoCompaction,
  plannedTokens,
  summarizeSession,
  summaryPrompt,
  transcriptOf,
  type CompactEvent,
  type CompactPlan,
  type Session,
  type TodoList,
  type TurnEvent,
} from '../src/index.js';

const at = '2026-10-07T00:00:01.000Z';
const session: Session = { id: asSessionId('s1'), createdAt: at, workspace: '/tmp/ws', provider: 'modelstudio', model: 'qwen3.8-flash', effort: 'medium' };
const start: TurnEvent = { kind: 'session-start', session, context: { instructions: [{ path: '/tmp/ws/AGENTS.md', text: 'Use pnpm.' }], rules: [], skills: [] } };
const user = (seq: number, content: string): TurnEvent => ({ kind: 'user', seq, at, content });
const steer = (seq: number, content: string): TurnEvent => ({ kind: 'user', seq, at, content, steer: true });
const parentSteer = (seq: number, content: string): TurnEvent => ({ kind: 'user', seq, at, content, steer: true, from: 'parent' });
const report = (seq: number, content: string): TurnEvent => ({ kind: 'user', seq, at, content, steer: true, from: 'child' });
type Use = readonly [id: string, name: string, input: unknown];
const assistant = (seq: number, text: string, uses: readonly Use[] = [], context = 1000): TurnEvent => ({
  kind: 'assistant',
  seq,
  at,
  content: [{ type: 'text', text, citations: null }, ...uses.map(([id, name, input]) => ({ type: 'tool_use' as const, id, name, input, caller: { type: 'direct' as const } }))],
  stopReason: uses.length === 0 ? 'end_turn' : 'tool_use',
  usage: { input: context - 10, cacheRead: 0, cacheWrite: 0, output: 10 },
  costUsd: 0.01,
  latencyMs: 1,
  model: 'qwen3.8-flash',
});
const result = (seq: number, toolUseId: string, output: string, name = 'bash'): TurnEvent => ({ kind: 'tool-result', seq, at, toolUseId, name, status: 'ok', output });
const todoResult = (seq: number, toolUseId: string, todo: TodoList): TurnEvent => ({ kind: 'tool-result', seq, at, toolUseId, name: 'todo', status: 'ok', output: 'Updated the todo list.', todo });
const echoDefinition = JSON.stringify({ name: 'mcp__fake__echo', description: 'Echo the text.', input_schema: { type: 'object', properties: { text: { type: 'string' } } } });
const searchResult = (seq: number, toolUseId: string): TurnEvent => ({
  kind: 'tool-result',
  seq,
  at,
  toolUseId,
  name: 'tool_search',
  status: 'ok',
  output: `Loaded this tool. Call it directly from now on, with input that matches the input_schema:\n${echoDefinition}`,
  loaded: ['mcp__fake__echo'],
});
const cut = (seq: number, turnSeq: number): TurnEvent => ({ kind: 'cut', seq, at, turnSeq });

const big = (tokens: number): string => 'x'.repeat(Math.round(tokens * 3.5));
const plan = (events: readonly TurnEvent[], keep?: number): CompactPlan => {
  const planned = planCompaction(events, keep);
  if (planned === undefined) throw new Error('expected a cut');
  return planned;
};
const compacted = (events: readonly TurnEvent[], seq: number, keep?: number, summary = 'SUMMARY'): CompactEvent => ({
  ...compactionEvent(plan(events, keep), {
    trigger: 'auto',
    summary: { text: summary, spend: { usage: { input: 500, cacheRead: 0, cacheWrite: 0, output: 100 }, costUsd: 0.002, model: 'qwen3.8-flash' } },
    tokensBefore: contextTokens(events),
    at,
  }),
  seq,
});

const todo: TodoList = [
  { id: '1', text: 'Read the parser', status: 'done' },
  { id: '2', text: 'Fix the parser', status: 'in_progress' },
];

/**
 * Three turns. The second loads a deferred tool, sets the todo list, takes a user steer and a parent steer and a
 * child's report. Each tool result is about 3,000 tokens, so a 5,000-token tail keeps only the last turn or so.
 */
const log: TurnEvent[] = [
  start,
  user(1, 'Fix the date parser in src/date.ts. Keep the public API unchanged.'),
  assistant(2, 'Reading it.', [['tu_read', 'read', { path: 'src/date.ts' }]], 2_000),
  result(3, 'tu_read', big(3_000), 'read'),
  assistant(4, 'Found the bug.', [], 5_100),
  user(5, 'Now the tests, please.'),
  assistant(6, 'Loading echo.', [['tu_search', 'tool_search', { select: ['mcp__fake__echo'] }], ['tu_todo', 'todo', { items: todo }]], 6_000),
  searchResult(7, 'tu_search'),
  todoResult(8, 'tu_todo', todo),
  steer(9, 'Use vitest, not jest.'),
  parentSteer(10, '<parent_message>\nAlso cover leap years.\n</parent_message>'),
  report(11, 'child report: found 3 callers'),
  assistant(12, 'Writing tests.', [['tu_edit', 'edit', { path: 'test/date.test.ts' }]], 7_000),
  { kind: 'tool-result', seq: 13, at, toolUseId: 'tu_edit', name: 'edit', status: 'ok', output: big(3_000), change: { id: 'c1', path: '/tmp/ws/test/date.test.ts', hunks: [] } },
  assistant(14, 'Running them.', [['tu_bash', 'bash', { command: 'pnpm vitest' }]], 10_100),
  result(15, 'tu_bash', big(3_000)),
];

const seqs = (events: readonly TurnEvent[]): (number | 'start' | undefined)[] => events.map((e) => (e.kind === 'session-start' ? 'start' : e.seq));

/** Every tool_result answers a tool_use of the assistant message just before it, as the API requires. */
function pairsHold(messages: readonly MessageParam[]): boolean {
  return messages.every((message, i) => {
    if (typeof message.content === 'string') return true;
    const previous = messages[i - 1];
    const uses = new Set(previous === undefined || typeof previous.content === 'string' ? [] : previous.content.flatMap((b) => (b.type === 'tool_use' ? [b.id] : [])));
    return message.content.every((block) => block.type !== 'tool_result' || uses.has(block.tool_use_id));
  });
}

describe('the cut', () => {
  it('lands on the model turn whose tool call the tail answers, never between a call and its result', () => {
    // A 4,000-token tail would start at the bash result (seq 15) if results were cut points; the cut moves to its call.
    const planned = plan(log, 4_000);
    expect(planned.keptFrom).toBe(14);
    expect(seqs(planned.tail)).toEqual([14, 15]);
    const event = compacted(log, 16, 4_000);
    const messages = replayMessages([...log, event]);
    expect(pairsHold(messages)).toBe(true);
    expect(JSON.stringify(messages)).not.toContain('Writing tests.');
  });

  it('keeps the oldest boundary whose tail fits the budget', () => {
    const tailFrom = (seq: number) => log.slice(log.findIndex((e) => e.kind !== 'session-start' && e.seq === seq)).reduce((sum, e) => sum + eventTokens(e), 0);
    expect(plan(log, tailFrom(12)).keptFrom).toBe(12);
    expect(plan(log, tailFrom(9)).keptFrom).toBe(9);
    expect(plan(log, tailFrom(4)).keptFrom).toBe(4);
    // Seq 2 has no model turn before it, so the oldest cut is seq 4 however large the budget.
    expect(plan(log, 1_000_000).keptFrom).toBe(4);
  });

  it('keeps the newest turn when no tail fits, so a huge last round still compacts the rest', () => {
    expect(plan(log, 10).keptFrom).toBe(14);
  });

  it('has nothing to cut in a session with one model turn', () => {
    expect(planCompaction([start, user(1, 'hi'), assistant(2, 'hello')], 10)).toBeUndefined();
    expect(planCompaction([start, user(1, 'hi')], 10)).toBeUndefined();
  });

  it('never cuts while a tool call it would leave behind has its result later', () => {
    const pending: TurnEvent[] = [start, user(1, 'go'), assistant(2, 'a', [['tu_a', 'bash', {}]]), steer(3, 'wait'), result(4, 'tu_a', 'done'), assistant(5, 'b')];
    // The steer at seq 3 sits between tu_a and its result, so it is no cut point, though it would keep the most.
    expect(plan(pending, 1_000_000).keptFrom).toBe(5);
    expect(pairsHold(replayMessages([...pending, compacted(pending, 6, 1_000_000)]))).toBe(true);
  });
});

describe('what a compaction keeps verbatim', () => {
  const kept = plan(log, 4_000).kept;

  it("keeps the user's own messages, user steers and the parent's steer, and leaves a child's report to the summary", () => {
    expect(kept.messages.map((m) => [m.seq, m.from, m.steer])).toEqual([
      [1, 'user', false],
      [5, 'user', false],
      [9, 'user', true],
      [10, 'parent', true],
    ]);
    const text = compactedText({ summary: 'S', kept });
    expect(text).toContain('- The user: Fix the date parser in src/date.ts. Keep the public API unchanged.');
    expect(text).toContain('- The user, while you worked: Use vitest, not jest.');
    expect(text).toContain('Also cover leap years.');
    expect(text).not.toContain('found 3 callers');
  });

  it('keeps the todo list, the loaded tool definitions and the files touched', () => {
    expect(kept.todo).toEqual(todo);
    expect(kept.tools).toEqual([echoDefinition]);
    expect(kept.files).toEqual({ read: ['src/date.ts'], changed: ['test/date.test.ts'] });
    const text = compactedText({ summary: 'S', kept });
    expect(text).toContain('[~] 2: Fix the parser');
    expect(text).toContain(echoDefinition);
  });

  it('leaves loaded tools callable, since the log keeps the load', () => {
    expect([...loadedTools([...log, compacted(log, 16, 4_000)])]).toEqual(['mcp__fake__echo']);
  });
});

describe('the context after a compaction', () => {
  const event = compacted(log, 16, 4_000);
  const after = [...log, event];

  it('is the session start, the compaction, then the tail', () => {
    expect(seqs(contextView(after))).toEqual(['start', 16, 14, 15]);
    expect(contextView(contextView(after))).toEqual(contextView(after));
    expect(contextView(log)).toBe(log);
  });

  it('opens with the loaded context and the compacted text, then the kept turns as they were', () => {
    const messages = replayMessages(after);
    expect(messages.map((m) => m.role)).toEqual(['user', 'assistant', 'user']);
    const first = messages[0]!.content as { type: string; text: string }[];
    expect(first[0]!.text).toContain('Use pnpm.');
    expect(first[1]!.text).toBe(compactedText(event));
    expect(first[1]!.text).toContain('<summary>\nSUMMARY\n</summary>');
    expect(messages.slice(1)).toEqual(replayMessages(log).slice(-2));
  });

  it('goes on with events logged after the compaction', () => {
    const later = [...after, assistant(17, 'All green.'), user(18, 'thanks')];
    const messages = replayMessages(later);
    expect(messages.at(-2)).toEqual({ role: 'assistant', content: (later.at(-2) as Extract<TurnEvent, { kind: 'assistant' }>).content });
    expect(messages.at(-1)!.role).toBe('user');
  });

  it('rebuilds the same request after a resume, from the log as written', () => {
    const resumed = JSON.parse(JSON.stringify(after)) as TurnEvent[];
    expect(replayMessages(resumed)).toEqual(replayMessages(after));
  });

  it('is measured by the compaction until the next model call', () => {
    expect(event.tokensBefore).toBe(contextTokens(log));
    expect(event.tokensAfter).toBeLessThan(event.tokensBefore);
    expect(contextTokens(after)).toBe(event.tokensAfter);
    expect(lastContextUse(session, after)).toEqual({ used: event.tokensAfter, window: 1_000_000 });
    const next = [...after, assistant(17, 'ok', [], 4_200)];
    expect(lastContextUse(session, next)).toEqual({ used: 4_200, window: 1_000_000 });
  });

  it('keeps the compacted text when the prompt it kept from is refused', () => {
    const asked = [...log, assistant(16, big(500), [], 12_000), user(17, 'And the port?')];
    const kept = compacted(asked, 18, 100);
    expect(kept.keptFrom).toBe(17);
    const refused: TurnEvent[] = [...asked, kept, { kind: 'error', seq: 19, at, error: 'refusal', message: 'refused' }];
    expect(hasPendingPrompt(refused)).toBe(false);
    const messages = replayMessages([...refused, user(20, 'Then the host?')]);
    expect(messages).toHaveLength(1);
    expect((messages[0]!.content as { text: string }[]).map((block) => block.text)).toEqual([expect.stringContaining('Use pnpm.'), compactedText(kept), 'Then the host?']);
  });

  it("does not change the loop's next step", () => {
    const run = { firstSeq: 1, maxTurns: 50, maxCostUsd: 1 };
    expect(loopStep(after, run)).toEqual(loopStep(log, run));
  });
});

describe('a second compaction on top of the first', () => {
  const first = compacted(log, 16, 4_000, 'FIRST');
  const grown: TurnEvent[] = [
    ...log,
    first,
    user(17, 'Also update the README.'),
    assistant(18, 'Fixing a failing test first.', [['tu_b2', 'read', { path: '/tmp/ws/test/date.test.ts' }]], 9_000),
    result(19, 'tu_b2', big(3_000), 'read'),
    assistant(20, 'Updating.', [['tu_r', 'read', { path: 'README.md' }]], 13_000),
    result(21, 'tu_r', big(3_000), 'read'),
  ];
  const second = compacted(grown, 22, 4_000, 'SECOND');

  it('summarizes the first compaction with the turns after it', () => {
    const prompt = summaryPrompt(plan(grown, 4_000));
    expect(prompt.indexOf('<summary>\nFIRST\n</summary>')).toBeGreaterThan(-1);
    expect(prompt.indexOf('<summary>\nFIRST')).toBeLessThan(prompt.indexOf('Fixing a failing test first.'));
    expect(prompt).not.toContain('Use pnpm.');
  });

  it('carries the kept messages, the todo list and the tools forward', () => {
    expect(second.kept.messages.map((m) => m.seq)).toEqual([1, 5, 9, 10, 17]);
    expect(second.kept.todo).toEqual(todo);
    expect(second.kept.tools).toEqual([echoDefinition]);
    expect(second.kept.files).toEqual({ read: ['src/date.ts', 'test/date.test.ts'], changed: ['test/date.test.ts'] });
  });

  it('estimates the context it leaves without the first one in it', () => {
    const sent = (events: readonly TurnEvent[]): number => contextView(events).reduce((sum, e) => sum + eventTokens(e), 0);
    const events: TurnEvent[] = [...log, first, user(17, 'Also update the README.')];
    events.push(assistant(18, 'Reading.', [['tu_m', 'read', { path: 'README.md' }]], sent(events)));
    events.push(result(19, 'tu_m', big(3_000), 'read'));
    events.push(assistant(20, 'Updated.', [], sent(events)));
    events.push(user(21, 'Thanks.'));
    const next = compacted(events, 22, 100);
    expect(Math.abs(next.tokensAfter - sent([...events, next]))).toBeLessThan(50);
  });

  it('replaces the first in the context', () => {
    const after = [...grown, second];
    expect(seqs(contextView(after))).toEqual(['start', 22, 20, 21]);
    const text = JSON.stringify(replayMessages(after));
    expect(text).toContain('SECOND');
    expect(text).not.toContain('FIRST');
  });
});

describe('a compaction logged mid-turn, then cut across by the next', () => {
  // The first keeps from seq 12 and is logged after seq 15, mid-turn; the second keeps from seq 14, before it.
  const tailFrom12 = log.slice(log.findIndex((e) => e.kind !== 'session-start' && e.seq === 12)).reduce((sum, e) => sum + eventTokens(e), 0);
  const first = compacted(log, 16, tailFrom12, 'FIRST');
  const grown = [...log, first, assistant(17, 'Done.')];
  const second = compacted(grown, 18, 1_000_000, 'SECOND');

  it('leaves the first out of the context, since the second summarized it', () => {
    expect(first.keptFrom).toBe(12);
    expect(second.keptFrom).toBe(14);
    const after = [...grown, second];
    expect(seqs(contextView(after))).toEqual(['start', 18, 14, 15, 17]);
    const text = JSON.stringify(replayMessages(after));
    expect(text).toContain('SECOND');
    expect(text).not.toContain('FIRST');
  });
});

describe('rewind and fork across a compaction', () => {
  const event = compacted(log, 16, 4_000);
  const after = [...log, event, user(17, 'next')];

  it('rewinds to a turn before the compaction from the whole log', () => {
    const view = cutView([...after, cut(18, 5)]);
    expect(view.some((e) => e.kind === 'compact')).toBe(false);
    expect(replayMessages(view)).toEqual(replayMessages(log.slice(0, 5)));
  });

  it('forks from a turn after the compaction with the compaction in place', () => {
    const forked = forkEvents(after, 17, { id: asSessionId('s2'), createdAt: at, title: 't' })!;
    expect(forked.some((e) => e.kind === 'compact')).toBe(true);
    expect(replayMessages(forked)).toEqual(replayMessages(after));
  });
});

describe('when to compact', () => {
  it(`compacts once the context and what is queued pass ${COMPACT_AT * 100}% of the window`, () => {
    // The last call measured 10,100 tokens; the bash result queued after it adds about 3,000.
    expect(contextTokens(log)).toBe(10_100 + eventTokens(log.at(-1)!));
    expect(compactAtTokens(16_000)).toBe(12_800);
    expect(autoCompaction(log, compactAtTokens(16_000))?.keptFrom).toBe(14);
    expect(autoCompaction(log, compactAtTokens(17_000))).toBeUndefined();
    expect(autoCompaction(log, compactAtTokens(undefined))).toBeUndefined();
  });

  it('skips a compaction that could not bring the context back under the threshold', () => {
    const planned = plan(log, keepTailTokens(12_800));
    expect(plannedTokens(planned, contextTokens(log))).toBeLessThan(12_800);
    // At 9,000 the threshold is passed, but what the cut keeps and the summary bring would pass it again.
    expect(contextTokens(log)).toBeGreaterThan(9_000);
    expect(plannedTokens(plan(log, keepTailTokens(9_000)), contextTokens(log))).toBeGreaterThanOrEqual(9_000);
    expect(autoCompaction(log, 9_000)).toBeUndefined();
  });

  it("takes the user's own threshold over the window's", () => {
    expect(compactAtTokens(1_000_000, 12_000)).toBe(12_000);
    expect(compactAtTokens(undefined, 12_000)).toBe(12_000);
  });

  it('keeps a quarter of the threshold verbatim on a small window', () => {
    expect(keepTailTokens(compactAtTokens(1_000_000))).toBe(KEEP_TAIL_TOKENS);
    expect(keepTailTokens(compactAtTokens(32_000))).toBe(6_400);
  });

  it('waits for a model call after a compaction before compacting again', () => {
    const after = [...log, compacted(log, 16, 4_000)];
    expect(contextTokens(after)).toBeGreaterThan(1_000);
    expect(autoCompaction(after, 1_000)).toBeUndefined();
  });
});

describe("the compaction's spend", () => {
  const event = compacted(log, 16, 4_000);

  it('counts in the session cost', () => {
    expect(summarizeSession(session, [...log, event]).costUsd).toBeCloseTo(summarizeSession(session, log).costUsd! + 0.002);
  });

  it('counts toward the budget but not the turns', () => {
    // Five model turns at $0.01 each, and the summary call's $0.002.
    const run = { firstSeq: 1, maxTurns: 6, maxCostUsd: 0.051 };
    const logged = [...log, event];
    expect(loopStep(log, run)).toEqual({ kind: 'call-model' });
    expect(loopStep(logged, run)).toEqual({ kind: 'done', reason: 'budget' });
    expect(loopStep(logged, { ...run, maxCostUsd: 1 })).toEqual({ kind: 'call-model' });
  });
});

describe('the transcript the summary call reads', () => {
  it('keeps every result whole while the transcript fits, and names the tool each result answers', () => {
    const text = transcriptOf(replayMessages(log.slice(0, 5)));
    expect(text).toContain('[Assistant called read]: {"path":"src/date.ts"}');
    expect(text).toContain(`[Result of read]: ${big(3_000)}\n`);
    expect(text).not.toContain('left out');
  });

  it('cuts the longest results first, to their start and end, so the short ones stay whole', () => {
    const long = 'L'.repeat(10_000);
    const short = 'S'.repeat(2_500);
    const messages = replayMessages([start, user(1, 'go'), assistant(2, 'a', [['tu_l', 'read', {}], ['tu_s', 'read', {}]]), result(3, 'tu_l', long, 'read'), result(4, 'tu_s', short, 'read')]);
    const text = transcriptOf(messages, 8_000);
    expect(text.length).toBeLessThanOrEqual(8_000 + 200);
    expect(text).toContain(`[Result of read]: ${short}`);
    expect(text).toMatch(/\[Result of read\]: L+\n\[\.\.\. \d+ characters left out of this transcript only; the agent saw them \.\.\.\]\nL{1000}/);
  });

  it('drops the oldest lines past its budget and keeps an earlier compacted context at the top', () => {
    const event = compacted(log, 16, 4_000, 'FIRST');
    const text = transcriptOf(replayMessages([...log, event, user(17, 'last words')]), compactedText(event).length + 50);
    expect(text.startsWith('<compacted_context>')).toBe(true);
    expect(text).toContain('earlier lines left out');
    expect(text.endsWith('[User]: last words')).toBe(true);
  });

  it('passes the focus the user gave', () => {
    expect(summaryPrompt(plan(log, 4_000), 'the leap year bug')).toContain('The user asked the summary to focus on: the leap year bug');
  });
});
