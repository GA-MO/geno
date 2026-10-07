import { describe, expect, it } from 'vitest';
import type { PrCheck, PrLookup, PullRequest } from '@g-code/core';
import { GH_HELP, nextRefreshMs, prStatusLine, PR_REFRESH, type PrStatusLine } from '../src/chat/pr-status-model.js';

const PR: PullRequest = { number: 42, title: 'Add the cart total', url: 'https://github.com/sam/shop/pull/42', state: 'OPEN', isDraft: false, reviewDecision: 'REVIEW_REQUIRED', branch: 'cart-total' };
const check = (name: string, bucket: PrCheck['bucket']): PrCheck => ({ name, workflow: 'CI', bucket, link: '' });
const look = (checks: readonly PrCheck[], pr: Partial<PullRequest> = {}): PrLookup => ({ kind: 'pr', pr: { ...PR, ...pr }, checks });

describe('the PR status line', () => {
  it('shows the number, title, state with the review decision, and the pending, passed and failed counts', () => {
    expect(prStatusLine(look([check('lint', 'pass'), check('test', 'pending'), check('build', 'fail'), check('deploy', 'cancel'), check('e2e', 'skipping')]), undefined, false)).toEqual({
      kind: 'pr',
      number: 42,
      title: 'Add the cart total',
      state: 'Review required',
      tone: 'open',
      checks: { pending: 1, pass: 1, fail: 2 },
      tooltip: '#42 Add the cart total\nOpen, review required\nChecks: 1 failed, 1 cancelled, 1 pending, 1 passed, 1 skipped\n✓ lint\n… test\n✗ build\n✗ deploy\n– e2e',
    });
  });

  it('marks drafts, merged and closed PRs', () => {
    expect(prStatusLine(look([], { isDraft: true, reviewDecision: null }), undefined, false)).toMatchObject({ tone: 'draft', state: 'Draft' });
    expect(prStatusLine(look([], { reviewDecision: null }), undefined, false)).toMatchObject({ tone: 'open', state: '' });
    expect(prStatusLine(look([], { state: 'MERGED', reviewDecision: 'APPROVED' }), undefined, false)).toMatchObject({ tone: 'merged', state: 'Merged · approved' });
    expect(prStatusLine(look([], { state: 'CLOSED' }), undefined, false)).toMatchObject({ tone: 'closed' });
  });

  it('says how to get gh when it is missing or logged out, until the user hides the hint', () => {
    expect(prStatusLine({ kind: 'gh-missing' }, undefined, false)).toEqual({ kind: 'help', text: GH_HELP.missing });
    expect(prStatusLine({ kind: 'gh-logged-out' }, undefined, false)).toEqual({ kind: 'help', text: GH_HELP['logged-out'] });
    expect(prStatusLine({ kind: 'gh-missing' }, undefined, true)).toBeUndefined();
  });

  it('shows nothing for a branch without a PR or a folder not on GitHub, and keeps the last line through a failed look', () => {
    const shown = prStatusLine(look([check('test', 'pending')]), undefined, false) as PrStatusLine;
    expect(prStatusLine({ kind: 'no-pr', branch: 'main' }, shown, false)).toBeUndefined();
    expect(prStatusLine({ kind: 'not-github' }, shown, false)).toBeUndefined();
    expect(prStatusLine({ kind: 'failed', message: 'offline' }, shown, false)).toBe(shown);
  });

  it('looks again by itself only while an open PR has a check pending', () => {
    expect(nextRefreshMs(look([check('lint', 'pass'), check('test', 'pending')]))).toBe(PR_REFRESH.pendingMs);
    expect(PR_REFRESH.pendingMs, 'never a tight loop').toBeGreaterThanOrEqual(60_000);
    expect(nextRefreshMs(look([check('test', 'pass')]))).toBeUndefined();
    expect(nextRefreshMs(look([]))).toBeUndefined();
    expect(nextRefreshMs(look([check('test', 'pending')], { state: 'MERGED' }))).toBeUndefined();
    expect(nextRefreshMs({ kind: 'gh-missing' })).toBeUndefined();
  });
});
