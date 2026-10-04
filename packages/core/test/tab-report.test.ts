import { describe, expect, it } from 'vitest';
import {
  asCompletionId,
  foldTabEvents,
  percentile,
  tabReport,
  type CompletionRequest,
  type FimRequest,
  type NextEditRequest,
  type Outcome,
  type TabEvent,
} from '../src/tab/index.js';

const request = (
  n: number,
  outcome: Outcome,
  overrides: Partial<FimRequest> = {},
): FimRequest => ({
  id: asCompletionId(`c${n}`),
  kind: 'fim',
  path: '/w/a.ts',
  version: 1,
  offset: n,
  inputs: { repo: 'w', path: 'a.ts', prefix: '', suffix: '', snippets: [] },
  model: 'qwen-1.5b',
  source: 'model',
  promptTokens: 100 * n,
  sentAt: `2026-10-0${n < 5 ? 1 : 2}T00:00:00.000Z`,
  ttftMs: 10 * n,
  latencyMs: 100 * n,
  text: 'x',
  outcome,
  persisted: 'unknown',
  ...overrides,
});

const at = '2026-10-03T00:00:00.000Z';

describe('percentile', () => {
  it('interpolates between the middle two on an even count', () => {
    expect(percentile([4, 1, 3, 2], 50)).toBe(2.5);
    expect(percentile([1, 2, 3, 4], 90)).toBeCloseTo(3.7);
  });

  it('takes the middle value on an odd count', () => {
    expect(percentile([5, 1, 3], 50)).toBe(3);
    expect(percentile([10, 20, 30, 40, 50], 90)).toBe(46);
  });

  it('is null with no values and the value itself with one', () => {
    expect(percentile([], 50)).toBeNull();
    expect(percentile([7], 90)).toBe(7);
  });
});

describe('tabReport', () => {
  const events: TabEvent[] = [
    { kind: 'request', request: request(1, { kind: 'shown' }) },
    { kind: 'request', request: request(2, { kind: 'shown' }) },
    { kind: 'request', request: request(3, { kind: 'shown' }) },
    { kind: 'request', request: request(4, { kind: 'shown' }) },
    { kind: 'request', request: request(5, { kind: 'cancelled' }, { ttftMs: null, latencyMs: null, text: null }) },
    { kind: 'request', request: request(6, { kind: 'suppressed', filter: 'empty' }) },
    { kind: 'request', request: request(7, { kind: 'shown' }, { source: 'cache', ttftMs: 0, latencyMs: 0 }) },
    { kind: 'request', request: request(8, { kind: 'shown' }, { model: 'other' }) },
    { kind: 'outcome', id: asCompletionId('c1'), at, outcome: { kind: 'accepted' } },
    { kind: 'outcome', id: asCompletionId('c2'), at, outcome: { kind: 'accepted' } },
    { kind: 'outcome', id: asCompletionId('c3'), at, outcome: { kind: 'typed-over' } },
    { kind: 'outcome', id: asCompletionId('c7'), at, outcome: { kind: 'partial' } },
    { kind: 'persisted', id: asCompletionId('c1'), at, persisted: true },
    { kind: 'persisted', id: asCompletionId('c2'), at, persisted: false },
    { kind: 'outcome', id: asCompletionId('missing'), at, outcome: { kind: 'accepted' } },
  ];

  it('folds later outcome and persistence lines into their request', () => {
    const folded = foldTabEvents(events);
    expect(folded).toHaveLength(8);
    expect(folded.find((r) => r.id === 'c1')).toMatchObject({ outcome: { kind: 'accepted' }, persisted: true });
    expect(folded.find((r) => r.id === 'c4')).toMatchObject({ outcome: { kind: 'shown' }, persisted: 'unknown' });
  });

  it('counts outcomes and times only shown items the model answered, per model', () => {
    const [other, qwen] = tabReport(foldTabEvents(events));
    expect(other!.model).toBe('other');
    expect(other!.total).toBe(1);
    expect(qwen).toEqual({
      kind: 'fim',
      model: 'qwen-1.5b',
      total: 7,
      byOutcome: { cancelled: 1, suppressed: 1, shown: 1, accepted: 2, partial: 1, rejected: 0, 'typed-over': 1 },
      shown: 5,
      timedShown: 4,
      ttftMs: { p50: 25, p90: 37 },
      latencyMs: { p50: 250, p90: 370 },
      promptTokens: { p50: 250, p90: 370 },
      acceptPerShown: 2 / 5,
      persistedPerAccepted: 1 / 2,
    });
  });

  it('keeps only requests sent at or after --since', () => {
    const [, qwen] = tabReport(foldTabEvents(events), '2026-10-02T00:00:00.000Z');
    expect(qwen!.total).toBe(3);
    expect(qwen!.timedShown).toBe(0);
    expect(qwen!.ttftMs).toEqual({ p50: null, p90: null });
    expect(qwen!.acceptPerShown).toBe(0);
    expect(qwen!.persistedPerAccepted).toBeNull();
  });

  it('reports next-edit apart from FIM even on the same model', () => {
    const { inputs: _, ...fields } = request(1, { kind: 'shown' });
    const nextEdit: NextEditRequest = {
      ...fields,
      id: asCompletionId('n1'),
      kind: 'next-edit',
      inputs: { path: 'a.ts', cursor: 0, region: { start: 0, end: 1, text: 'x' }, history: [], related: [] },
      edit: { start: 0, end: 1, text: 'y' },
    };
    const reports = tabReport([request(1, { kind: 'shown' }), nextEdit] satisfies CompletionRequest[]);
    expect(reports.map((r) => [r.kind, r.model, r.total])).toEqual([
      ['fim', 'qwen-1.5b', 1],
      ['next-edit', 'qwen-1.5b', 1],
    ]);
  });
});
