import { OUTCOME_KINDS, WAS_SHOWN, type CompletionRequest, type OutcomeKind } from './completion.js';

/** Linear interpolation between closest ranks, so the median of an even count is the mean of the middle two. */
export function percentile(values: readonly number[], p: number): number | null {
  if (values.length === 0) return null;
  const sorted = values.toSorted((a, b) => a - b);
  const rank = (p / 100) * (sorted.length - 1);
  const low = Math.floor(rank);
  const high = Math.ceil(rank);
  return sorted[low]! + (sorted[high]! - sorted[low]!) * (rank - low);
}

export type Spread = { readonly p50: number | null; readonly p90: number | null };

const spread = (values: readonly number[]): Spread => ({ p50: percentile(values, 50), p90: percentile(values, 90) });

const ratio = (part: number, whole: number): number | null => (whole === 0 ? null : part / whole);

export type ModelReport = {
  readonly model: string;
  readonly total: number;
  readonly byOutcome: Readonly<Record<OutcomeKind, number>>;
  readonly shown: number;
  /** Shown items answered by the model itself; cache and in-flight reuse would flatter the latency. */
  readonly timedShown: number;
  readonly ttftMs: Spread;
  readonly latencyMs: Spread;
  readonly promptTokens: Spread;
  readonly acceptPerShown: number | null;
  readonly persistedPerAccepted: number | null;
};

function reportFor(model: string, requests: readonly CompletionRequest[]): ModelReport {
  const byOutcome = Object.fromEntries(OUTCOME_KINDS.map((kind) => [kind, 0])) as Record<OutcomeKind, number>;
  for (const request of requests) byOutcome[request.outcome.kind]++;
  const shown = requests.filter((r) => WAS_SHOWN[r.outcome.kind]);
  const timed = shown.filter((r) => r.source === 'model');
  const accepted = requests.filter((r) => r.outcome.kind === 'accepted');
  return {
    model,
    total: requests.length,
    byOutcome,
    shown: shown.length,
    timedShown: timed.length,
    ttftMs: spread(timed.flatMap((r) => (r.ttftMs === null ? [] : [r.ttftMs]))),
    latencyMs: spread(timed.flatMap((r) => (r.latencyMs === null ? [] : [r.latencyMs]))),
    promptTokens: spread(timed.map((r) => r.promptTokens)),
    acceptPerShown: ratio(accepted.length, shown.length),
    persistedPerAccepted: ratio(accepted.filter((r) => r.persisted === true).length, accepted.length),
  };
}

export function tabReport(requests: readonly CompletionRequest[], since?: string): ModelReport[] {
  const sinceMs = since === undefined ? -Infinity : Date.parse(since);
  const byModel = new Map<string, CompletionRequest[]>();
  for (const request of requests.filter((r) => Date.parse(r.sentAt) >= sinceMs)) {
    byModel.set(request.model, [...(byModel.get(request.model) ?? []), request]);
  }
  return [...byModel].sort(([a], [b]) => a.localeCompare(b)).map(([model, rs]) => reportFor(model, rs));
}
