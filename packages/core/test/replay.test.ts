import { describe, expect, it } from 'vitest';
import {
  appliersFor,
  asTripleId,
  replay,
  summarize,
  type Applier,
  type ApplyModel,
  type ApplyTriple,
} from '../src/index.js';

const noModel: ApplyModel = {
  name: 'none',
  call: () => {
    throw new Error('noop and oracle call no model');
  },
};

const triple: ApplyTriple = {
  id: asTripleId('fixture-abc1234'),
  scope: 'commit',
  repo: '/tmp/fixture',
  commit: 'abc1234def',
  path: 'math.js',
  instruction: 'Fix the sign in add',
  before: 'return a - b;\n',
  expected: 'return a + b;\n',
};

describe('replay', () => {
  it('oracle gives an exact match and an empty diff', async () => {
    const result = await replay(triple, appliersFor(triple, noModel).oracle);
    expect(result).toEqual({
      tripleId: triple.id,
      scope: 'commit',
      applier: 'oracle',
      outcome: { kind: 'applied', after: triple.expected },
      exactMatch: true,
      exactIgnoringTrailingWhitespace: true,
      attempt: null,
      diff: '',
    });
  });

  it('noop on a changed triple misses and diffs expected against actual', async () => {
    const result = await replay(triple, appliersFor(triple, noModel).noop);
    expect(result.exactMatch).toBe(false);
    expect(result.outcome).toEqual({ kind: 'applied', after: triple.before });
    expect(result.diff).toContain('--- expected/math.js');
    expect(result.diff).toContain('+++ actual/math.js');
    expect(result.diff).toContain('-return a + b;');
    expect(result.diff).toContain('+return a - b;');
  });

  it('a failed outcome is not a match and carries no diff', async () => {
    const failing: Applier = {
      name: 'noop',
      apply: async () => ({ outcome: { kind: 'failed', reason: 'zero-matches', detail: 'no match' }, attempt: null }),
    };
    const result = await replay(triple, failing);
    expect(result).toMatchObject({ exactMatch: false, diff: '' });
    const summary = summarize([result]);
    expect(summary.all).toEqual({
      total: 1,
      exact: 0,
      exactIgnoringTrailingWhitespace: 0,
      firstTryFailed: 1,
      failed: 1,
      retries: 0,
    });
    expect(summary.byScope['file-slice'].total).toBe(0);
    expect(summary.finalFailures['zero-matches']).toBe(1);
  });

  it('counts a result that differs only in trailing whitespace as a near match', async () => {
    const sloppy: Applier = {
      name: 'noop',
      apply: async () => ({ outcome: { kind: 'applied', after: 'return a + b;   \n\n' }, attempt: null }),
    };
    expect(await replay(triple, sloppy)).toMatchObject({ exactMatch: false, exactIgnoringTrailingWhitespace: true });
  });
});
