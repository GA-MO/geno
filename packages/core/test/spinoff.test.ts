import { describe, expect, it } from 'vitest';
import {
  asSessionId,
  cutView,
  hintOf,
  moveSpinoff,
  offerOf,
  parseDismissTask,
  parseSpawnTask,
  parseSpinoff,
  SPAWN_TASK_TOOL,
  SPINOFF_LIMITS,
  SPINOFF_SPECS,
  spinoffIdOf,
  spinoffNamed,
  spinoffsOf,
  spinoffToolDefinitions,
  type Session,
  type Spinoff,
  type SpinoffDecision,
  type SpinoffId,
  type SpinoffMove,
  type SpinoffOffer,
  type SpinoffState,
  type TurnEvent,
} from '../src/index.js';

const at = '2026-10-07T00:00:01.000Z';
const session: Session = { id: asSessionId('s1'), createdAt: at, workspace: '/tmp/ws', provider: 'modelstudio', model: 'qwen3.8-flash', effort: 'medium' };
const input = (title: string) => ({ title, tldr: `Noticed ${title}.`, prompt: `Do: ${title} in src/a.ts, then run the tests.` });
const offer = (id: string, title: string): SpinoffOffer => ({ id: id as SpinoffId, ...input(title) });
const spinoff = (id: string, title: string, state: SpinoffState = { kind: 'offered' }): Spinoff => ({ ...offer(id, title), toolUseId: `call-${id}`, state });

describe('parseSpawnTask', () => {
  const refusals: readonly [string, unknown, RegExp][] = [
    ['no object', 'fix it', /takes an object with title, tldr and prompt/],
    ['a missing prompt', { title: 'Remove x', tldr: 'x is dead.' }, /needs prompt/],
    ['a blank title', { ...input('a'), title: '   ' }, /needs title/],
    ['a title over the limit', { ...input('a'), title: 'x'.repeat(SPINOFF_LIMITS.title + 1) }, /title is 61 characters; keep it to 60/],
    ['a prompt over the limit', { ...input('a'), prompt: 'x'.repeat(SPINOFF_LIMITS.prompt + 1) }, /prompt is 8001 characters/],
    ['an unknown field', { ...input('a'), priority: 'high' }, /unknown field "priority"/],
  ];
  it.each(refusals)('refuses %s', (_name, raw, problem) => {
    const parsed = parseSpawnTask(raw);
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(parsed.problem).toMatch(problem);
  });

  it('keeps the three fields, trimmed, and a title of exactly 60 characters', () => {
    expect(parseSpawnTask({ title: ' Remove formatDate ', tldr: ' It is unused. ', prompt: ' Delete it. ' })).toEqual({ ok: true, value: { title: 'Remove formatDate', tldr: 'It is unused.', prompt: 'Delete it.' } });
    expect(parseSpawnTask({ ...input('a'), title: 'x'.repeat(SPINOFF_LIMITS.title) }).ok).toBe(true);
  });

  it('dismiss_task takes a task_id and nothing else', () => {
    expect(parseDismissTask({ task_id: ' task_1 ' })).toEqual({ ok: true, value: 'task_1' });
    expect(parseDismissTask({}).ok).toBe(false);
    expect(parseDismissTask({ task_id: 'task_1', why: 'done' })).toEqual({ ok: false, problem: 'dismiss_task has an unknown field "why"' });
  });
});

describe('offers', () => {
  it('gives a call the same short id every time, and another id when that one is taken', () => {
    const id = spinoffIdOf('call_abc', []);
    expect(id).toMatch(/^task_[0-9a-f]{8}$/);
    expect(spinoffIdOf('call_abc', [])).toBe(id);
    expect(spinoffIdOf('call_abd', [])).not.toBe(id);
    const second = spinoffIdOf('call_abc', [spinoff(id, 'taken')]);
    expect(second).toMatch(/^task_[0-9a-f]{8}$/);
    expect(second).not.toBe(id);
  });

  it('refuses a title an open suggestion already has, whatever its case, and allows it again once that one is settled', () => {
    const open = [spinoff('task_1', 'Remove formatDate')];
    expect(offerOf(input('remove FORMATDATE'), 'c2', open)).toEqual({ ok: false, problem: 'task_1 already suggests "Remove formatDate"; it is still open, so there is nothing to add' });
    expect(offerOf(input('remove formatDate'), 'c2', [spinoff('task_1', 'Remove formatDate', { kind: 'dismissed' })]).ok).toBe(true);
  });

  it(`refuses an offer past ${SPINOFF_LIMITS.open} open suggestions, counting only the open ones`, () => {
    const open = Array.from({ length: SPINOFF_LIMITS.open }, (_, i) => spinoff(`task_${i}`, `Task ${i}`));
    const parsed = offerOf(input('One more'), 'c', open);
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(parsed.problem).toMatch(/10 suggestions are open; withdraw stale ones with dismiss_task/);
    const settled = open.with(0, { ...open[0]!, state: { kind: 'withdrawn' } });
    expect(offerOf(input('One more'), 'c', settled).ok).toBe(true);
  });
});

describe('moveSpinoff, the state machine', () => {
  const started: SpinoffDecision = { kind: 'started', sessionId: 's9', lane: 'remove-formatdate' };
  const moves: readonly [string, SpinoffMove, SpinoffState][] = [
    ['the user starts it', started, { kind: 'started', sessionId: 's9', lane: 'remove-formatdate' }],
    ['the user dismisses it', { kind: 'dismissed' }, { kind: 'dismissed' }],
    ['the agent withdraws it', { kind: 'withdrawn', id: 'task_1' as SpinoffId }, { kind: 'withdrawn' }],
  ];
  it.each(moves)('from offered, %s', (_name, move, state) => {
    expect(moveSpinoff(spinoff('task_1', 'Remove x'), move)).toEqual({ ok: true, value: spinoff('task_1', 'Remove x', state) });
  });

  const settled: readonly [string, SpinoffState, string][] = [
    ['started', started, 'task_1 cannot change: the user already started it as a task in lane remove-formatdate'],
    ['dismissed', { kind: 'dismissed' }, 'task_1 cannot change: the user already dismissed it'],
    ['withdrawn', { kind: 'withdrawn' }, 'task_1 cannot change: it was already withdrawn'],
  ];
  it.each(settled)('a %s suggestion takes no move, with the reason', (_name, state, problem) => {
    for (const [, move] of moves) expect(moveSpinoff(spinoff('task_1', 'Remove x', state), move)).toEqual({ ok: false, problem });
  });

  it('names a suggestion by id, or lists the ones there are', () => {
    const list = [spinoff('task_1', 'A'), spinoff('task_2', 'B')];
    expect(spinoffNamed(list, 'task_2')).toEqual({ ok: true, value: list[1] });
    expect(spinoffNamed(list, 'task_3')).toEqual({ ok: false, problem: 'no task task_3; the suggested ones are task_1, task_2' });
    expect(spinoffNamed([], 'task_3')).toEqual({ ok: false, problem: 'no task task_3; nothing was suggested in this session' });
  });
});

const start: TurnEvent = { kind: 'session-start', session };
const user = (seq: number, content: string): TurnEvent => ({ kind: 'user', seq, at, content });
const offered = (seq: number, toolUseId: string, o: SpinoffOffer): TurnEvent => ({ kind: 'tool-result', seq, at, toolUseId, name: 'spawn_task', status: 'ok', output: 'Suggested', spinoff: { kind: 'offered', offer: o } });
const withdrawn = (seq: number, toolUseId: string, id: string): TurnEvent => ({ kind: 'tool-result', seq, at, toolUseId, name: 'dismiss_task', status: 'ok', output: 'Withdrew', spinoff: { kind: 'withdrawn', id: id as SpinoffId } });
const refused = (seq: number, toolUseId: string): TurnEvent => ({ kind: 'tool-result', seq, at, toolUseId, name: 'spawn_task', status: 'error', output: 'spawn_task needs prompt' });
const decided = (id: string, decision: SpinoffDecision, seq?: number): TurnEvent => ({ kind: 'spinoff', ...(seq === undefined ? {} : { seq }), at, id: id as SpinoffId, decision });
const cut = (seq: number, turnSeq: number): TurnEvent => ({ kind: 'cut', seq, at, turnSeq });

const a = offer('task_a', 'Remove formatDate');
const b = offer('task_b', 'Fix the stale README setup');
const c = offer('task_c', 'Test parseRange');
const lane = { kind: 'started', sessionId: 's9', lane: 'remove-formatdate' } as const;

/** Turn 1 (seq 1) offers a and b. Turn 2 (seq 4) withdraws b and offers c, one call refused; the user starts a while it runs. */
const log: readonly TurnEvent[] = [
  start,
  user(1, 'fix the parser'),
  offered(2, 'ca', a),
  offered(3, 'cb', b),
  user(4, 'go on'),
  decided('task_a', lane),
  withdrawn(5, 'wb', 'task_b'),
  refused(6, 'cx'),
  offered(7, 'cc', c),
];

describe('spinoffsOf, replaying the log', () => {
  const at = (o: SpinoffOffer, toolUseId: string, state: SpinoffState): Spinoff => ({ ...o, toolUseId, state });
  const replays: readonly [string, readonly TurnEvent[], readonly Spinoff[]][] = [
    ['nothing offered', [start, user(1, 'hi')], []],
    ['the whole log', log, [at(a, 'ca', lane), at(b, 'cb', { kind: 'withdrawn' }), at(c, 'cc', { kind: 'offered' })]],
    ['turn 1', log.slice(0, 4), [at(a, 'ca', { kind: 'offered' }), at(b, 'cb', { kind: 'offered' })]],
    ['a dismissal after the start, which changes nothing', [...log, decided('task_a', { kind: 'dismissed' })], [at(a, 'ca', lane), at(b, 'cb', { kind: 'withdrawn' }), at(c, 'cc', { kind: 'offered' })]],
    ['a withdrawal of a started task, which changes nothing', [...log, withdrawn(8, 'wa', 'task_a')], [at(a, 'ca', lane), at(b, 'cb', { kind: 'withdrawn' }), at(c, 'cc', { kind: 'offered' })]],
    ['a decision about an id never offered', [...log, decided('task_z', { kind: 'dismissed' })], [at(a, 'ca', lane), at(b, 'cb', { kind: 'withdrawn' }), at(c, 'cc', { kind: 'offered' })]],
    ['the user dismissing c', [...log, decided('task_c', { kind: 'dismissed' }, 8)], [at(a, 'ca', lane), at(b, 'cb', { kind: 'withdrawn' }), at(c, 'cc', { kind: 'dismissed' })]],
  ];
  it.each(replays)('%s', (_name, events, list) => {
    expect(spinoffsOf(events)).toEqual(list);
  });

  it('a cut drops the cut turns\' offers and withdrawals, and keeps the user\'s decisions about earlier ones', () => {
    const view = cutView([...log, cut(8, 4)]);
    expect(spinoffsOf(view)).toEqual([at(a, 'ca', lane), at(b, 'cb', { kind: 'offered' })]);
    expect(spinoffsOf(cutView([...log, cut(8, 1)]))).toEqual([]);
  });
});

describe('the tools', () => {
  it('are offered in Plan, Ask and Auto only to a client that shows the cards, sorted by name', () => {
    for (const mode of ['plan', 'ask', 'auto'] as const) expect(spinoffToolDefinitions(mode, true).map((tool) => tool.name)).toEqual(['dismiss_task', 'spawn_task']);
    expect(spinoffToolDefinitions('non-interactive', true)).toEqual([]);
    expect(spinoffToolDefinitions('auto', false)).toEqual([]);
  });

  it('spawn_task says when to use it and when not, and its tool_search hint stands alone', () => {
    const description = SPINOFF_SPECS[SPAWN_TASK_TOOL].description!;
    for (const words of ['dead code', 'stale docs', 'missing test', 'TODO you confirmed', 'security issue', 'vague code-smell', 'small enough to fix as part of the current change', 'self-contained', 'file paths'])
      expect(description).toContain(words);
    expect(hintOf(description)).toBe('Suggest a separate task for an issue you noticed that is outside the current change.');
  });
});

describe('parseSpinoff', () => {
  it('keeps a well-formed suggestion in each state and refuses a broken one', () => {
    for (const state of [{ kind: 'offered' }, lane, { kind: 'dismissed' }, { kind: 'withdrawn' }] as const) expect(parseSpinoff(spinoff('task_1', 'A', state))).toEqual(spinoff('task_1', 'A', state));
    expect(parseSpinoff({ ...spinoff('task_1', 'A'), state: { kind: 'started' } })).toBeUndefined();
    expect(parseSpinoff({ ...spinoff('task_1', 'A'), state: { kind: 'running' } })).toBeUndefined();
    expect(parseSpinoff({ ...spinoff('task_1', 'A'), title: 3 })).toBeUndefined();
  });
});
