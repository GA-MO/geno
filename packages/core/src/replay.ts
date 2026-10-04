import { createTwoFilesPatch } from 'diff';
import type { Applier, ApplierName, ApplyTriple, ReplayResult } from './types.js';

export const appliersFor = (triple: ApplyTriple): Record<ApplierName, Applier> => ({
  noop: { name: 'noop', apply: async ({ before }) => ({ kind: 'applied', after: before }) },
  oracle: { name: 'oracle', apply: async () => ({ kind: 'applied', after: triple.expected }) },
});

export const unifiedDiff = (path: string, expected: string, actual: string): string =>
  createTwoFilesPatch(`expected/${path}`, `actual/${path}`, expected, actual);

export async function replay(triple: ApplyTriple, applier: Applier): Promise<ReplayResult> {
  const outcome = await applier.apply({
    path: triple.path,
    before: triple.before,
    instruction: triple.instruction,
  });
  const base = { tripleId: triple.id, applier: applier.name, outcome };
  if (outcome.kind === 'failed') return { ...base, exactMatch: false, diff: '' };
  const exactMatch = outcome.after === triple.expected;
  return {
    ...base,
    exactMatch,
    diff: exactMatch ? '' : unifiedDiff(triple.path, triple.expected, outcome.after),
  };
}

export type ReplaySummary = {
  readonly total: number;
  readonly exact: number;
  readonly failed: number;
  readonly exactRate: number;
  readonly failureRate: number;
};

export function summarize(results: readonly ReplayResult[]): ReplaySummary {
  const total = results.length;
  const exact = results.filter((r) => r.exactMatch).length;
  const failed = results.filter((r) => r.outcome.kind === 'failed').length;
  const rate = (n: number) => (total === 0 ? 0 : n / total);
  return { total, exact, failed, exactRate: rate(exact), failureRate: rate(failed) };
}
