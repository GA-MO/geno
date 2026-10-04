declare const brand: unique symbol;
type Brand<T, B extends string> = T & { readonly [brand]: B };

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
  'model-error',
] as const;
export type ApplyFailure = (typeof APPLY_FAILURES)[number];

export type ApplyOutcome =
  | { readonly kind: 'applied'; readonly after: string }
  | { readonly kind: 'failed'; readonly reason: ApplyFailure; readonly detail: string };

export const APPLIER_NAMES = ['noop', 'oracle'] as const;
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
  apply(input: ApplyInput): Promise<ApplyOutcome>;
};

export type ReplayResult = {
  readonly tripleId: TripleId;
  readonly applier: ApplierName;
  readonly outcome: ApplyOutcome;
  readonly exactMatch: boolean;
  readonly diff: string;
};
