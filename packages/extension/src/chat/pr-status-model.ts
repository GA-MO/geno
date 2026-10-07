import { checkCounts, countsText, GH_INSTALL_URL, prStateText, type PrLookup } from '@g-code/core';

/** The status line above the composer: the branch's PR and its checks, or how to get gh, or nothing. */
export type PrStatusLine =
  | {
      readonly kind: 'pr';
      readonly number: number;
      readonly title: string;
      /** What the icon's colour does not say: draft, merged or closed, and the review decision, as "Draft · review required". Empty for an open PR that needs no review. */
      readonly state: string;
      readonly tone: 'open' | 'draft' | 'merged' | 'closed';
      readonly checks: { readonly pending: number; readonly pass: number; readonly fail: number };
      /** Every check, for the tooltip. */
      readonly tooltip: string;
    }
  | { readonly kind: 'help'; readonly text: string };

export type PrStatusToView = { readonly type: 'pr-status'; readonly line: PrStatusLine | undefined };

export type PrStatusFromView = { readonly type: 'open-pr' } | { readonly type: 'hide-pr-help' };

export type PrRefresh = {
  /** While a check is pending, the line looks again this often. */
  readonly pendingMs: number;
  /** A refresh for any other reason, such as the window regaining focus, waits this long after the last look. */
  readonly minGapMs: number;
};

export const PR_REFRESH: PrRefresh = { pendingMs: 60_000, minGapMs: 30_000 };

/** PR_REFRESH, or the faster one the tests set in GCODE_PR_REFRESH. */
export function prRefreshOf(env: Readonly<Record<string, string | undefined>>): PrRefresh {
  const raw = env['GCODE_PR_REFRESH'];
  if (raw === undefined || raw === '') return PR_REFRESH;
  const parsed = JSON.parse(raw) as Partial<PrRefresh>;
  return { pendingMs: parsed.pendingMs ?? PR_REFRESH.pendingMs, minGapMs: parsed.minGapMs ?? PR_REFRESH.minGapMs };
}

export const GH_HELP = {
  missing: "Install the GitHub CLI and run gh auth login to see this branch's PR here.",
  'logged-out': "Run gh auth login in a terminal to see this branch's PR here.",
} as const;

export const GH_HELP_URL = GH_INSTALL_URL;

const sentence = (text: string): string => text.charAt(0).toUpperCase() + text.slice(1);

/**
 * What the line shows for a look. A failed look keeps what it showed, so a dropped connection does not blink it away;
 * a folder with no PR, or no GitHub remote, shows nothing.
 */
export function prStatusLine(lookup: PrLookup, previous: PrStatusLine | undefined, helpHidden: boolean): PrStatusLine | undefined {
  switch (lookup.kind) {
    case 'pr': {
      const { pr, checks } = lookup;
      const counts = checkCounts(checks);
      const tone = pr.state === 'MERGED' ? 'merged' : pr.state === 'CLOSED' ? 'closed' : pr.isDraft ? 'draft' : 'open';
      const lines = [`#${pr.number} ${pr.title}`, sentence(prStateText(pr)), `Checks: ${countsText(checks)}`, ...checks.map((c) => `${c.bucket === 'pending' ? '…' : c.bucket === 'pass' ? '✓' : c.bucket === 'skipping' ? '–' : '✗'} ${c.name}`)];
      return {
        kind: 'pr',
        number: pr.number,
        title: pr.title,
        state: sentence(prStateText(pr).replace(/^open(, )?/, '').replaceAll(', ', ' · ')),
        tone,
        checks: { pending: counts.pending, pass: counts.pass, fail: counts.fail + counts.cancel },
        tooltip: lines.join('\n'),
      };
    }
    case 'gh-missing':
      return helpHidden ? undefined : { kind: 'help', text: GH_HELP.missing };
    case 'gh-logged-out':
      return helpHidden ? undefined : { kind: 'help', text: GH_HELP['logged-out'] };
    case 'failed':
      return previous;
    case 'no-pr':
    case 'not-github':
      return undefined;
  }
}

/** When the line looks again by itself: only while an open PR has a check pending. */
export const nextRefreshMs = (lookup: PrLookup, refresh: PrRefresh = PR_REFRESH): number | undefined =>
  lookup.kind === 'pr' && lookup.pr.state === 'OPEN' && lookup.checks.some((c) => c.bucket === 'pending') ? refresh.pendingMs : undefined;
