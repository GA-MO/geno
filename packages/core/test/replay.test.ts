import { describe, expect, it } from 'vitest';
import {
  appliersFor,
  asTripleId,
  replay,
  summarize,
  type Applier,
  type ApplyTriple,
} from '../src/index.js';

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
    const result = await replay(triple, appliersFor(triple).oracle);
    expect(result).toEqual({
      tripleId: triple.id,
      applier: 'oracle',
      outcome: { kind: 'applied', after: triple.expected },
      exactMatch: true,
      diff: '',
    });
  });

  it('noop on a changed triple misses and diffs expected against actual', async () => {
    const result = await replay(triple, appliersFor(triple).noop);
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
      apply: async () => ({ kind: 'failed', reason: 'zero-matches', detail: 'no match' }),
    };
    const result = await replay(triple, failing);
    expect(result).toMatchObject({ exactMatch: false, diff: '' });
    expect(summarize([result])).toEqual({
      total: 1,
      exact: 0,
      failed: 1,
      exactRate: 0,
      failureRate: 1,
    });
  });
});
