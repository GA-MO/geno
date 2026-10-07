import { describe, expect, it } from 'vitest';
import {
  asSessionId,
  CHAPTER_LIMITS,
  chapterToolDefinitions,
  chaptersOf,
  compactedText,
  compactionEvent,
  contextTokens,
  contextView,
  cutView,
  eventTokens,
  forkEvents,
  hintOf,
  keptOf,
  MARK_CHAPTER_SPEC,
  MARK_CHAPTER_TOOL,
  newChapterOf,
  parseChapterMark,
  planCompaction,
  replayMessages,
  userChapterAt,
  type Chapter,
  type ChapterMark,
  type CompactEvent,
  type Session,
  type TurnEvent,
} from '../src/index.js';

const at = '2026-10-07T00:00:01.000Z';
const session: Session = { id: asSessionId('s1'), createdAt: at, workspace: '/tmp/ws', provider: 'modelstudio', model: 'qwen3.8-flash', effort: 'medium' };
const start: TurnEvent = { kind: 'session-start', session };
const user = (seq: number, content: string): TurnEvent => ({ kind: 'user', seq, at, content });
const steer = (seq: number, content: string): TurnEvent => ({ kind: 'user', seq, at, content, steer: true });
const call = (seq: number, id: string, name: string, input: unknown, context = 1_000): TurnEvent => ({
  kind: 'assistant',
  seq,
  at,
  content: [{ type: 'tool_use', id, name, input, caller: { type: 'direct' } }],
  stopReason: 'tool_use',
  usage: { input: context - 10, cacheRead: 0, cacheWrite: 0, output: 10 },
  costUsd: 0.01,
  latencyMs: 1,
  model: 'qwen3.8-flash',
});
const answer = (seq: number, text: string, context = 1_000): TurnEvent => ({
  kind: 'assistant',
  seq,
  at,
  content: [{ type: 'text', text, citations: null }],
  stopReason: 'end_turn',
  usage: { input: context - 10, cacheRead: 0, cacheWrite: 0, output: 10 },
  costUsd: 0.01,
  latencyMs: 1,
  model: 'qwen3.8-flash',
});
const result = (seq: number, toolUseId: string, output: string, name = 'read'): TurnEvent => ({ kind: 'tool-result', seq, at, toolUseId, name, status: 'ok', output });
const marked = (seq: number, toolUseId: string, mark: ChapterMark): TurnEvent => ({ kind: 'tool-result', seq, at, toolUseId, name: MARK_CHAPTER_TOOL, status: 'ok', output: 'marked', chapter: mark });
const userMark = (turnSeq: number, mark: ChapterMark | null): TurnEvent => ({ kind: 'chapter', at, turnSeq, mark });
const cut = (seq: number, turnSeq: number): TurnEvent => ({ kind: 'cut', seq, at, turnSeq });
const big = (tokens: number): string => 'x'.repeat(Math.round(tokens * 3.5));

const titles = (chapters: readonly Chapter[]): string[] => chapters.map((chapter) => chapter.title);

/**
 * Three turns. Turn 1 explores, then the agent marks "Parser fix" mid-turn. Turn 2 marks "Test verification" after a
 * steer. The user marks turn 3 after it ended, and names turn 1 too, logged last, as a mark between turns is.
 */
const log: readonly TurnEvent[] = [
  start,
  user(1, 'Fix the date parser in src/date.ts.'),
  call(2, 'tu_read', 'read', { path: 'src/date.ts' }),
  result(3, 'tu_read', big(3_000)),
  call(4, 'tu_ch1', MARK_CHAPTER_TOOL, { title: 'Parser fix' }, 4_000),
  marked(5, 'tu_ch1', { title: 'Parser fix', summary: 'The off-by-one in parseDate.' }),
  answer(6, 'Fixed it.', 4_100),
  user(7, 'Now run the tests.'),
  steer(8, 'Use vitest.'),
  call(9, 'tu_ch2', MARK_CHAPTER_TOOL, { title: 'Test verification' }, 4_200),
  marked(10, 'tu_ch2', { title: 'Test verification' }),
  call(11, 'tu_bash', 'bash', { command: 'pnpm vitest' }, 4_300),
  result(12, 'tu_bash', big(3_000), 'bash'),
  answer(13, 'All pass.', 7_400),
  user(14, 'Write the changelog entry.'),
  answer(15, 'Done.', 7_500),
  userMark(14, { title: 'Release notes' }),
  userMark(1, { title: 'Exploration' }),
];

describe('parseChapterMark', () => {
  const refusals: readonly [string, unknown, string][] = [
    ['no object', 'Parser fix', 'mark_chapter takes an object with a title'],
    ['no title', { summary: 'x' }, 'mark_chapter needs a title'],
    ['a blank title', { title: '   ' }, 'mark_chapter needs a title'],
    ['a title over the limit', { title: 'x'.repeat(CHAPTER_LIMITS.title + 1) }, 'title is 41 characters; keep it to 40, as a short noun phrase'],
    ['a summary over the limit', { title: 'Fix', summary: 'y'.repeat(CHAPTER_LIMITS.summary + 1) }, 'summary is 201 characters; keep it to 200'],
    ['a summary that is not text', { title: 'Fix', summary: 3 }, 'summary must be text'],
    ['an unknown field', { title: 'Fix', level: 2 }, 'mark_chapter has an unknown field "level"'],
  ];
  it.each(refusals)('refuses %s, saying why', (_name, raw, problem) => {
    expect(parseChapterMark(raw)).toEqual({ ok: false, problem });
  });

  it('trims the title, keeps a 40-character one, puts the summary on one line, and drops a blank summary', () => {
    expect(parseChapterMark({ title: '  Parser   fix ', summary: ' The off-by-one\n in parseDate. ' })).toEqual({ ok: true, value: { title: 'Parser fix', summary: 'The off-by-one in parseDate.' } });
    expect(parseChapterMark({ title: 'x'.repeat(CHAPTER_LIMITS.title) }).ok).toBe(true);
    expect(parseChapterMark({ title: 'Tests', summary: '  ' })).toEqual({ ok: true, value: { title: 'Tests' } });
  });
});

describe('the tool', () => {
  it('is offered in Plan, Ask and Auto to a client that draws chapters, and never to a non-interactive run or another client', () => {
    for (const mode of ['plan', 'ask', 'auto'] as const) expect(chapterToolDefinitions(mode, true)).toEqual([MARK_CHAPTER_SPEC]);
    expect(chapterToolDefinitions('non-interactive', true)).toEqual([]);
    expect(chapterToolDefinitions('auto', false)).toEqual([]);
  });

  it('tells the model to mark phases sparingly, not each step or the first message, with a short noun phrase', () => {
    const description = MARK_CHAPTER_SPEC.description!;
    expect(description).toContain('Use it sparingly: about 3 to 8 chapters in a long session, never one per tool call');
    expect(description).toContain('not for the first message');
    expect(description).toContain('short noun phrase of at most 40 characters');
    expect(hintOf(MARK_CHAPTER_SPEC.description)).toMatch(/^Mark the start of a new chapter in this session/);
  });

  it('refuses the chapter the session is already in, whatever its case, and allows it again after another', () => {
    const chapters = chaptersOf(log);
    expect(newChapterOf({ title: 'release NOTES' }, chapters)).toEqual({ ok: false, problem: '"Release notes" is already the current chapter; mark a new one only when the work moves to another phase' });
    expect(newChapterOf({ title: 'Parser fix' }, chapters)).toEqual({ ok: true, value: { title: 'Parser fix' } });
    expect(newChapterOf({ title: 'Anything' }, []).ok).toBe(true);
  });
});

describe('chaptersOf', () => {
  it("folds the agent's calls and the user's marks into transcript order, each with where it starts", () => {
    expect(chaptersOf(log)).toEqual([
      { title: 'Exploration', start: { kind: 'turn', turnSeq: 1 } },
      { title: 'Parser fix', summary: 'The off-by-one in parseDate.', start: { kind: 'call', toolUseId: 'tu_ch1' } },
      { title: 'Test verification', start: { kind: 'call', toolUseId: 'tu_ch2' } },
      { title: 'Release notes', start: { kind: 'turn', turnSeq: 14 } },
    ]);
    expect(chaptersOf([start, user(1, 'hi'), answer(2, 'hello')])).toEqual([]);
  });

  it("lets the user's latest mark at a message win: a rename replaces it and a removal drops it", () => {
    const renamed = chaptersOf([...log, userMark(14, { title: 'Changelog' })]);
    expect(titles(renamed)).toEqual(['Exploration', 'Parser fix', 'Test verification', 'Changelog']);
    expect(userChapterAt(renamed, 14)?.title).toBe('Changelog');
    const removed = chaptersOf([...log, userMark(1, null)]);
    expect(titles(removed)).toEqual(['Parser fix', 'Test verification', 'Release notes']);
    expect(userChapterAt(removed, 1)).toBeUndefined();
  });

  it('leaves out a refused call, and a mark at a seq that starts no turn, such as a steer', () => {
    const refused: TurnEvent = { kind: 'tool-result', seq: 16, at, toolUseId: 'tu_bad', name: MARK_CHAPTER_TOOL, status: 'error', output: 'refused', chapter: { title: 'Nope' } };
    expect(titles(chaptersOf([...log, refused, userMark(8, { title: 'On a steer' })]))).toEqual(['Exploration', 'Parser fix', 'Test verification', 'Release notes']);
  });

  it('is not part of the conversation and costs no context tokens', () => {
    const event = userMark(1, { title: 'Exploration' });
    expect(eventTokens(event)).toBe(0);
    expect(replayMessages([...log.slice(0, -2), event])).toEqual(replayMessages(log.slice(0, -2)));
  });
});

describe('a rewind and a fork', () => {
  it("drop the chapters of the turns a cut removes, keep earlier ones, and keep the user's mark on a kept turn", () => {
    const view = cutView([...log, cut(16, 7)]);
    expect(chaptersOf(view)).toEqual([
      { title: 'Exploration', start: { kind: 'turn', turnSeq: 1 } },
      { title: 'Parser fix', summary: 'The off-by-one in parseDate.', start: { kind: 'call', toolUseId: 'tu_ch1' } },
    ]);
  });

  it('drop every chapter after a cut at the first turn, and a later mark on the cut message changes nothing', () => {
    expect(chaptersOf(cutView([...log, cut(16, 1), userMark(1, { title: 'Again' })]))).toEqual([]);
  });

  it("copy into a fork the chapters of the turns it takes, the user's later marks on them included", () => {
    const fork = forkEvents(log, 7, { id: asSessionId('fork'), createdAt: at, title: 'Fix the date parser' })!;
    expect(titles(chaptersOf(fork))).toEqual(['Exploration', 'Parser fix', 'Test verification']);
    expect(fork.filter((event) => event.kind === 'chapter')).toEqual([userMark(1, { title: 'Exploration' })]);
    const first = forkEvents(log, 1, { id: asSessionId('fork'), createdAt: at, title: 'Fix the date parser' })!;
    expect(titles(chaptersOf(first))).toEqual(['Exploration', 'Parser fix']);
  });
});

describe('a compaction', () => {
  const compact = (events: readonly TurnEvent[], seq: number, keep: number): CompactEvent => {
    const plan = planCompaction(events, keep);
    if (plan === undefined) throw new Error('expected a cut');
    return {
      ...compactionEvent(plan, { trigger: 'auto', summary: { text: 'SUMMARY', spend: { usage: { input: 500, cacheRead: 0, cacheWrite: 0, output: 100 }, costUsd: 0.002, model: 'qwen3.8-flash' } }, tokensBefore: contextTokens(events), at }),
      seq,
    };
  };

  it('keeps every chapter in the session, though the model no longer reads the calls that marked them', () => {
    const event = compact(log, 16, 500);
    const after = [...log, event];
    expect(chaptersOf(after)).toEqual(chaptersOf(log));
    const view = contextView(after);
    expect(view.some((e) => e.kind === 'tool-result' && e.chapter !== undefined)).toBe(false);
  });

  it("carries the agent's chapter titles in its kept state and names them in the compacted text", () => {
    const event = compact(log, 16, 500);
    expect(event.kept.chapters).toEqual(['Parser fix', 'Test verification']);
    expect(compactedText(event)).toContain('Chapters you marked, oldest first; the session is in the last one: Parser fix | Test verification');
  });

  it("carries the first compaction's chapters on into the next one, after the ones marked since", () => {
    const first = compact(log, 16, 500);
    const more: TurnEvent[] = [
      ...log,
      first,
      user(17, 'Ship it.'),
      call(18, 'tu_ch3', MARK_CHAPTER_TOOL, { title: 'Release' }, 2_000),
      marked(19, 'tu_ch3', { title: 'Release' }),
      call(20, 'tu_big', 'read', { path: 'CHANGELOG.md' }, 2_100),
      result(21, 'tu_big', big(3_000)),
      answer(22, 'Shipped.', 5_200),
    ];
    expect(keptOf(contextView(more).slice(0, -1)).chapters).toEqual(['Parser fix', 'Test verification', 'Release']);
  });

  it('adds nothing to a compaction of a session without chapters, so its text reads as before U58', () => {
    const plain = log.filter((e) => !(e.kind === 'tool-result' && e.chapter !== undefined) && e.kind !== 'chapter' && !(e.kind === 'assistant' && e.content.some((b) => b.type === 'tool_use' && b.name === MARK_CHAPTER_TOOL)));
    const event = compact(plain, 16, 500);
    expect(event.kept).not.toHaveProperty('chapters');
    expect(compactedText(event)).not.toContain('Chapters');
  });
});
