import { describe, expect, it } from 'vitest';
import type { ArenaId, ArenaLane, ArenaRun, CostPreview, VariantSpec } from '@g-code/core';
import { compareView, costSentence, defaultFocus, hunkLines, raceRows, raceTurnOf, rankRows, toggleGraft, varietyOf, type LaneDiff } from '../src/chat/arena-model.js';
import { steer } from '../src/chat/working.js';

const START = Date.parse('2026-10-06T10:00:00.000Z');
const plain: VariantSpec = { seed: 'plain', model: null, effort: null };
const minimal: VariantSpec = { seed: 'minimal', model: null, effort: null };
const idiomatic: VariantSpec = { seed: 'idiomatic', model: null, effort: null };

const lane = (letter: string, variant: VariantSpec, patch: Partial<ArenaLane> = {}): ArenaLane => ({
  lane: `task-${letter.toLowerCase()}`,
  letter,
  sessionId: `s-${letter}`,
  variant,
  status: 'running',
  check: null,
  turns: 0,
  costUsd: null,
  rank: null,
  reason: null,
  ...patch,
});

const preview: CostPreview = { n: 3, perLaneUsd: 0.032, reviewMaxUsd: 0.05, totalUsd: 0.146, basis: { kind: 'default' } };

const run = (lanes: ArenaLane[], patch: Partial<ArenaRun> = {}): ArenaRun => ({
  id: 'arena-000000000001' as ArenaId,
  task: 'Make two loud',
  workspace: '/repo',
  createdAt: new Date(START).toISOString(),
  preview,
  lanes,
  status: 'running',
  review: null,
  summary: null,
  winner: null,
  ...patch,
});

const hunk = (id: string, startLine: number, oldText: string, newText: string) => ({ id, startLine, lineCount: oldText === '' ? 0 : oldText.split('\n').length - 1, oldText, newText });

/** A changed line two in each lane; B also changes b.ts, and A adds a line that B lacks. */
const DIFFS: LaneDiff[] = [
  { lane: 'task-a', files: [{ path: 'a.ts', hunks: [hunk('a0', 2, 'two\n', 'Two\n'), hunk('a1', 4, '', 'four\n')] }] },
  { lane: 'task-b', files: [{ path: 'a.ts', hunks: [hunk('b0', 2, 'two\n', 'Two\n')] }, { path: 'b.ts', hunks: [hunk('b1', 1, 'x\n', 'y\n')] }] },
  { lane: 'task-c', files: [{ path: 'a.ts', hunks: [hunk('c0', 2, 'two\n', 'BAD\n')] }] },
];

const ranked = (winner: string | null = null) =>
  run(
    [
      lane('A', plain, { status: 'passed', check: { outcome: 'passed', tail: '' }, turns: 4, costUsd: 0.0021, rank: 2, reason: 'Adds an unasked line.' }),
      lane('B', minimal, { status: 'passed', check: { outcome: 'passed', tail: '' }, turns: 3, costUsd: 0.0015, rank: 1, reason: 'Smallest change that does it.' }),
      lane('C', idiomatic, { status: 'failed', check: { outcome: 'failed', tail: 'grep found BAD\n' }, turns: 3, costUsd: 0.0016 }),
    ],
    { status: 'ranked', summary: 'B wins on scope.', winner },
  );

describe('the cost preview in words', () => {
  it('says a default of the per-lane cost when Geno has too little history', () => {
    expect(costSentence(preview)).toBe('About $0.15: 3 lanes at a default of $0.032 a task, plus up to $0.05 for the review.');
  });

  it('names Geno’s own median when the history is long enough', () => {
    expect(costSentence({ n: 2, perLaneUsd: 0.0123, reviewMaxUsd: 0.05, totalUsd: 0.0746, basis: { kind: 'history', samples: 9 } })).toBe(
      'About $0.07: 2 lanes at $0.012, Geno’s median task, plus up to $0.05 for the review.',
    );
    expect(costSentence({ n: 4, perLaneUsd: 0.0004, reviewMaxUsd: 0.05, totalUsd: 0.0516, basis: { kind: 'history', samples: 3 } })).toContain('4 lanes at $0.0004, Geno’s median task');
  });

  it('reads the variety a config decided from the variants it gave', () => {
    const ask = { task: 't', n: 2, variety: undefined } as const;
    expect(varietyOf(ask, [plain, minimal])).toBe('seeds');
    expect(varietyOf(ask, [{ ...plain, effort: 'low' }, { ...plain, effort: 'high' }])).toBe('effort');
    expect(varietyOf(ask, [{ ...plain, model: 'm1' }, { ...plain, model: 'm2' }])).toBe('models');
    expect(varietyOf({ ...ask, variety: 'effort' }, [plain, minimal])).toBe('effort');
  });
});

describe('the race', () => {
  it('gives each lane its label, badge and place on the track', () => {
    const racing = run([lane('A', plain), lane('B', minimal, { status: 'checking', turns: 3, costUsd: 0.0015 }), lane('C', idiomatic, { status: 'failed', turns: 2, costUsd: 0.001, check: { outcome: 'failed', tail: '' } })]);
    const rows = raceRows(racing, START + 30_000);
    expect(rows.map((r) => [r.letter, r.label, r.state.label, r.settled, r.check?.label, r.cost, r.turns])).toEqual([
      ['A', 'As asked', 'Running', false, undefined, undefined, undefined],
      ['B', 'Minimal change', 'Checking', false, undefined, '$0.0015', '3 model calls'],
      ['C', 'Idiomatic refactor', 'Failed', true, 'Check failed', '$0.0010', '2 model calls'],
    ]);
    const [a, b, c] = rows.map((r) => r.progress);
    expect(a).toBeGreaterThan(0.08);
    expect(a).toBeLessThan(b!);
    expect(b).toBe(0.8);
    expect(c).toBe(1);
  });

  it('moves a running lane forward with time, and never past the check by time alone', () => {
    const lanes = [lane('A', plain)];
    const at = (ms: number) => raceRows(run(lanes), START + ms)[0]!.progress;
    expect(at(0)).toBeCloseTo(0.08);
    expect(at(60_000)).toBeGreaterThan(at(10_000));
    expect(at(3_600_000)).toBeLessThan(0.8);
    expect(at(-5_000)).toBeCloseTo(0.08);
  });

  it('poses a running lane’s dino running, flexes a passing one once, and plays nothing for a failed one', () => {
    const running = steer(undefined, raceTurnOf({ sessionId: 's-A', status: 'running' }, START), false, () => 0);
    expect(running?.pose).toBe('running');
    const passed = steer(running, raceTurnOf({ sessionId: 's-A', status: 'passed' }, START), false, () => 0);
    expect(passed?.pose).toBe('flex');
    const failed = steer(running, raceTurnOf({ sessionId: 's-A', status: 'failed' }, START), false, () => 0);
    expect(failed).toBeUndefined();
    expect(steer(undefined, raceTurnOf({ sessionId: 's-A', status: 'passed' }, START), false, () => 0)).toBeUndefined();
  });
});

describe('the ranking', () => {
  it('lists ranked lanes best first with their reasons, then the failed ones, and offers Pick on passing lanes only', () => {
    const rows = rankRows(ranked());
    expect(rows.map((r) => [r.rank, r.letter, r.state.label, r.reason, r.pick, r.checkTail])).toEqual([
      [1, 'B', 'Passed', 'Smallest change that does it.', true, undefined],
      [2, 'A', 'Passed', 'Adds an unasked line.', true, undefined],
      [null, 'C', 'Failed', null, false, 'grep found BAD\n'],
    ]);
  });

  it('marks the winner and offers no more picks once one is chosen', () => {
    const rows = rankRows(ranked('task-b'));
    expect(rows.map((r) => [r.letter, r.state.label, r.winner, r.pick])).toEqual([
      ['B', 'Winner', true, false],
      ['A', 'Passed', false, false],
      ['C', 'Failed', false, false],
    ]);
  });

  it('offers no pick while the run is still ranking', () => {
    expect(rankRows({ ...ranked(), status: 'ranking' }).some((r) => r.pick)).toBe(false);
  });
});

describe('the compare', () => {
  it('lines up each file’s cells by lane, in start order, with No change where a lane left the file alone', () => {
    const view = compareView(ranked(), DIFFS, undefined, undefined);
    expect(view.columns.map((c) => [c.letter, c.label, c.rank])).toEqual([
      ['A', 'As asked', 2],
      ['B', 'Minimal change', 1],
      ['C', 'Idiomatic refactor', null],
    ]);
    expect(view.files.map((f) => [f.path, f.cells.map((cell) => [cell.lane, cell.hunks.map((h) => h.id)])])).toEqual([
      ['a.ts', [['task-a', ['a0', 'a1']], ['task-b', ['b0']], ['task-c', ['c0']]]],
      ['b.ts', [['task-a', []], ['task-b', ['b1']], ['task-c', []]]],
    ]);
  });

  it('grafts nothing before a winner is picked', () => {
    const view = compareView(ranked(), DIFFS, undefined, undefined);
    expect(view.files.flatMap((f) => f.cells.flatMap((c) => c.hunks)).some((h) => h.graftable)).toBe(false);
  });

  it('after a pick, offers the other lanes’ hunks, but not the winner’s own nor one identical to the winner’s', () => {
    const view = compareView(ranked('task-b'), DIFFS, undefined, undefined);
    const graftable = Object.fromEntries(view.files.flatMap((f) => f.cells.flatMap((c) => c.hunks)).map((h) => [h.id, h.graftable]));
    expect(graftable).toEqual({ a0: false, a1: true, b0: false, c0: true, b1: false });
  });

  it('a narrow panel opens on the winner, else the first ranked lane, and keeps a lane the user chose', () => {
    expect(compareView(ranked(), DIFFS, undefined, undefined).focus).toBe('task-b');
    expect(compareView(ranked('task-a'), DIFFS, undefined, undefined).focus).toBe('task-a');
    expect(compareView(ranked('task-a'), DIFFS, 'task-c', undefined).focus).toBe('task-c');
    expect(compareView(ranked(), DIFFS, 'gone', undefined).focus).toBe('task-b');
    expect(defaultFocus(run([lane('A', plain), lane('B', minimal)]))).toBe('task-a');
  });

  it('grafts from one lane at a time', () => {
    const one = toggleGraft(undefined, 'task-a', 'a1');
    expect(one).toEqual({ lane: 'task-a', hunks: ['a1'] });
    expect(toggleGraft(one, 'task-c', 'c0')).toEqual({ lane: 'task-c', hunks: ['c0'] });
    expect(toggleGraft(one, 'task-a', 'a1')).toBeUndefined();
    const view = compareView(ranked('task-b'), DIFFS, undefined, one);
    expect(view.selected).toEqual(one);
    expect(compareView(ranked(), DIFFS, undefined, one).selected).toBeUndefined();
  });

  it('prints a hunk as its removed then added lines', () => {
    expect(hunkLines({ oldText: 'two\n', newText: 'Two\nmore\n' })).toEqual([
      { sign: '-', text: 'two' },
      { sign: '+', text: 'Two' },
      { sign: '+', text: 'more' },
    ]);
    expect(hunkLines({ oldText: '', newText: 'four\n' })).toEqual([{ sign: '+', text: 'four' }]);
  });
});
