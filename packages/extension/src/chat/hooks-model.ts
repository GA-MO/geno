import type { HookProblem, HookRow, HookStatus } from '@g-code/core';

export type HooksListing =
  | { readonly kind: 'loading' }
  | { readonly kind: 'loaded'; readonly trusted: boolean; readonly hooks: readonly HookRow[]; readonly problems: readonly HookProblem[] }
  | { readonly kind: 'failed'; readonly message: string };

export type HooksToView = { readonly type: 'hooks'; readonly listing: HooksListing };

export type HooksFromView = { readonly type: 'hooks-list' };

/** How each hook's state reads on its row. */
export const HOOK_STATUS_LABELS: Readonly<Record<HookStatus, { readonly label: string; readonly tone: 'ok' | 'wait' | 'quiet' }>> = {
  runs: { label: 'Runs', tone: 'ok' },
  untrusted: { label: 'Needs a trusted workspace', tone: 'wait' },
  P14: { label: 'Not run yet', tone: 'quiet' },
  P15: { label: 'Not run yet', tone: 'quiet' },
  P16: { label: 'Not run yet', tone: 'quiet' },
  never: { label: 'Geno never fires it', tone: 'quiet' },
};
