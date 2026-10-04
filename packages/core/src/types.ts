import type { ProposedChange } from './edit.js';
import type { TokenUsage } from './session.js';

declare const brand: unique symbol;
export type Brand<T, B extends string> = T & { readonly [brand]: B };

export type TaskId = Brand<string, 'TaskId'>;
export type TripleId = Brand<string, 'TripleId'>;

export const asTaskId = (raw: string): TaskId => raw as TaskId;
export const asTripleId = (raw: string): TripleId => raw as TripleId;

export type EvalTask = {
  readonly id: TaskId;
  readonly repo: string;
  readonly baseCommit: string;
  readonly prompt: string;
  readonly setup: string;
  readonly verify: string;
};

export const TRIPLE_SCOPES = ['commit', 'file-slice'] as const;
export type TripleScope = (typeof TRIPLE_SCOPES)[number];

export type ApplyTriple = {
  readonly id: TripleId;
  readonly scope: TripleScope;
  readonly repo: string;
  readonly commit: string;
  readonly path: string;
  readonly instruction: string;
  readonly before: string;
  readonly expected: string;
};

export const APPLY_FAILURES = [
  'zero-matches',
  'multiple-matches',
  'stale-base',
  'parse-error',
  'wrong-file',
  'no-edit',
  'model-error',
] as const;
export type ApplyFailure = (typeof APPLY_FAILURES)[number];

export type ApplyOutcome =
  | { readonly kind: 'applied'; readonly after: string }
  | { readonly kind: 'failed'; readonly reason: ApplyFailure; readonly detail: string };

export const EDIT_FORMATS = ['str_replace', 'apply_patch', 'whole_file'] as const;
export type EditFormat = (typeof EDIT_FORMATS)[number];

export const APPLIER_NAMES = ['noop', 'oracle', ...EDIT_FORMATS] as const;
export type ApplierName = (typeof APPLIER_NAMES)[number];

export const isApplierName = (raw: string): raw is ApplierName =>
  (APPLIER_NAMES as readonly string[]).includes(raw);

export type ApplyInput = {
  readonly path: string;
  readonly before: string;
  readonly instruction: string;
};

export type Applier = {
  readonly name: ApplierName;
  apply(input: ApplyInput): Promise<ApplierRun>;
};

/** `attempt` is null for appliers that call no model. */
export type ApplierRun = { readonly outcome: ApplyOutcome; readonly attempt: ModelAttempt | null };

export type FirstTry = 'applied' | ApplyFailure;

export type ModelAttempt = {
  readonly model: string;
  readonly firstTry: FirstTry;
  /** Failed edits whose error went back to the model for another try. */
  readonly retries: number;
  readonly calls: number;
  readonly usage: TokenUsage;
  readonly costUsd: number | null;
  readonly changes: readonly ProposedChange[];
};

export type ReplayResult = {
  readonly tripleId: TripleId;
  readonly scope: TripleScope;
  readonly applier: ApplierName;
  readonly outcome: ApplyOutcome;
  readonly exactMatch: boolean;
  readonly exactIgnoringTrailingWhitespace: boolean;
  readonly attempt: ModelAttempt | null;
  readonly diff: string;
};
