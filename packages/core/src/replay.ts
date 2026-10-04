import { createTwoFilesPatch } from 'diff';
import { modelApplier, type ModelCall } from './model-applier.js';
import type { TokenUsage } from './session.js';
import {
  APPLY_FAILURES,
  TRIPLE_SCOPES,
  type Applier,
  type ApplierName,
  type ApplyFailure,
  type ApplyTriple,
  type ReplayResult,
  type TripleScope,
} from './types.js';

/** The model behind the model-backed appliers. Appliers that call no model never touch it. */
export type ApplyModel = { readonly name: string; readonly call: ModelCall };

export const appliersFor = (triple: ApplyTriple, model: ApplyModel): Record<ApplierName, Applier> => ({
  noop: { name: 'noop', apply: async ({ before }) => ({ outcome: { kind: 'applied', after: before }, attempt: null }) },
  oracle: { name: 'oracle', apply: async () => ({ outcome: { kind: 'applied', after: triple.expected }, attempt: null }) },
  str_replace: modelApplier('str_replace', model.name, model.call),
  apply_patch: modelApplier('apply_patch', model.name, model.call),
  whole_file: modelApplier('whole_file', model.name, model.call),
});

export const unifiedDiff = (path: string, expected: string, actual: string): string =>
  createTwoFilesPatch(`expected/${path}`, `actual/${path}`, expected, actual);

const withoutTrailingWhitespace = (text: string): string =>
  text
    .split('\n')
    .map((line) => line.trimEnd())
    .join('\n')
    .trimEnd();

export async function replay(triple: ApplyTriple, applier: Applier): Promise<ReplayResult> {
  const { outcome, attempt } = await applier.apply({
    path: triple.path,
    before: triple.before,
    instruction: triple.instruction,
  });
  const base = { tripleId: triple.id, scope: triple.scope, applier: applier.name, outcome, attempt };
  if (outcome.kind === 'failed') return { ...base, exactMatch: false, exactIgnoringTrailingWhitespace: false, diff: '' };
  const exactMatch = outcome.after === triple.expected;
  return {
    ...base,
    exactMatch,
    exactIgnoringTrailingWhitespace: withoutTrailingWhitespace(outcome.after) === withoutTrailingWhitespace(triple.expected),
    diff: exactMatch ? '' : unifiedDiff(triple.path, triple.expected, outcome.after),
  };
}

/** Counts over a set of results. Rates are these divided by `total`. */
export type ReplayCounts = {
  readonly total: number;
  readonly exact: number;
  readonly exactIgnoringTrailingWhitespace: number;
  readonly firstTryFailed: number;
  readonly failed: number;
  readonly retries: number;
};

export type ReplaySummary = {
  readonly all: ReplayCounts;
  readonly byScope: Readonly<Record<TripleScope, ReplayCounts>>;
  readonly firstTryFailures: Readonly<Record<ApplyFailure, number>>;
  readonly finalFailures: Readonly<Record<ApplyFailure, number>>;
  readonly usage: TokenUsage;
  /** Null when any model call was unpriced. */
  readonly costUsd: number | null;
};

const firstTryFailure = (r: ReplayResult): ApplyFailure | undefined => {
  if (r.attempt !== null) return r.attempt.firstTry === 'applied' ? undefined : r.attempt.firstTry;
  return r.outcome.kind === 'failed' ? r.outcome.reason : undefined;
};

function counts(results: readonly ReplayResult[]): ReplayCounts {
  const count = (keep: (r: ReplayResult) => boolean) => results.filter(keep).length;
  return {
    total: results.length,
    exact: count((r) => r.exactMatch),
    exactIgnoringTrailingWhitespace: count((r) => r.exactIgnoringTrailingWhitespace),
    firstTryFailed: count((r) => firstTryFailure(r) !== undefined),
    failed: count((r) => r.outcome.kind === 'failed'),
    retries: results.reduce((sum, r) => sum + (r.attempt?.retries ?? 0), 0),
  };
}

function byReason(reasons: readonly (ApplyFailure | undefined)[]): Record<ApplyFailure, number> {
  const tally = Object.fromEntries(APPLY_FAILURES.map((reason) => [reason, 0])) as Record<ApplyFailure, number>;
  for (const reason of reasons) if (reason !== undefined) tally[reason]++;
  return tally;
}

export function summarize(results: readonly ReplayResult[]): ReplaySummary {
  const attempts = results.flatMap((r) => (r.attempt === null ? [] : [r.attempt]));
  const sum = (pick: (u: TokenUsage) => number) => attempts.reduce((n, a) => n + pick(a.usage), 0);
  return {
    all: counts(results),
    byScope: Object.fromEntries(
      TRIPLE_SCOPES.map((scope) => [scope, counts(results.filter((r) => r.scope === scope))]),
    ) as Record<TripleScope, ReplayCounts>,
    firstTryFailures: byReason(results.map(firstTryFailure)),
    finalFailures: byReason(results.map((r) => (r.outcome.kind === 'failed' ? r.outcome.reason : undefined))),
    usage: {
      input: sum((u) => u.input),
      cacheRead: sum((u) => u.cacheRead),
      cacheWrite: sum((u) => u.cacheWrite),
      output: sum((u) => u.output),
    },
    costUsd: attempts.some((a) => a.costUsd === null) ? null : attempts.reduce((n, a) => n + (a.costUsd ?? 0), 0),
  };
}
