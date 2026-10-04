import type { Brand } from '../types.js';
import type { FilterName } from './filters.js';
import type { NextEditInputs, PredictedEdit } from './zeta.js';

export type CompletionId = Brand<string, 'CompletionId'>;
export const asCompletionId = (raw: string): CompletionId => raw as CompletionId;

export const COMPLETION_KINDS = ['fim', 'next-edit'] as const;
export type CompletionKind = (typeof COMPLETION_KINDS)[number];

/** Where the returned text came from: a fresh model call, a finished cached call, or a call still streaming. */
export const COMPLETION_SOURCES = ['model', 'cache', 'in-flight'] as const;
export type CompletionSource = (typeof COMPLETION_SOURCES)[number];

export type Snippet = { readonly path: string; readonly text: string };

export type FimInputs = {
  readonly repo: string;
  readonly path: string;
  readonly prefix: string;
  readonly suffix: string;
  /** Most relevant first. */
  readonly snippets: readonly Snippet[];
};

export const OUTCOME_KINDS = [
  'cancelled',
  'suppressed',
  'shown',
  'accepted',
  'partial',
  'rejected',
  'typed-over',
] as const;
export type OutcomeKind = (typeof OUTCOME_KINDS)[number];

export type Outcome =
  | { readonly kind: Exclude<OutcomeKind, 'suppressed'> }
  | { readonly kind: 'suppressed'; readonly filter: FilterName };

export const WAS_SHOWN: Readonly<Record<OutcomeKind, boolean>> = {
  cancelled: false,
  suppressed: false,
  shown: true,
  accepted: true,
  partial: true,
  rejected: true,
  'typed-over': true,
};

/** Whether accepted text still exists unchanged later; unknown until checked. */
export type Persisted = boolean | 'unknown';

type RequestFields = {
  readonly id: CompletionId;
  readonly path: string;
  readonly version: number;
  readonly offset: number;
  readonly model: string;
  readonly source: CompletionSource;
  readonly promptTokens: number;
  readonly sentAt: string;
  readonly ttftMs: number | null;
  readonly latencyMs: number | null;
  /** For next-edit, the replacement text of the predicted edit. */
  readonly text: string | null;
  readonly outcome: Outcome;
  readonly persisted: Persisted;
};

/** The inputs are recorded after trimming to the budget, so the record shows what the model saw. */
export type FimRequest = RequestFields & { readonly kind: 'fim'; readonly inputs: FimInputs };

export type NextEditRequest = RequestFields & {
  readonly kind: 'next-edit';
  readonly inputs: NextEditInputs;
  readonly edit: PredictedEdit | null;
};

export type CompletionRequest = FimRequest | NextEditRequest;

/** One line of tab-events.jsonl. Later lines refine the request with the same id. */
export type TabEvent =
  | { readonly kind: 'request'; readonly request: CompletionRequest }
  | { readonly kind: 'outcome'; readonly id: CompletionId; readonly at: string; readonly outcome: Outcome }
  | { readonly kind: 'persisted'; readonly id: CompletionId; readonly at: string; readonly persisted: boolean };

export function foldTabEvents(events: readonly TabEvent[]): CompletionRequest[] {
  const byId = new Map<CompletionId, CompletionRequest>();
  for (const event of events) {
    if (event.kind === 'request') {
      byId.set(event.request.id, event.request);
      continue;
    }
    const request = byId.get(event.id);
    if (request === undefined) continue;
    byId.set(
      event.id,
      event.kind === 'outcome' ? { ...request, outcome: event.outcome } : { ...request, persisted: event.persisted },
    );
  }
  return [...byId.values()];
}
