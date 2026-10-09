# A10-plan-mode, run 1

Mode: plan. Fixture: `ts-lib`. Model: qwen3.8-flash.

## User

Make formatPrice support negative amounts like -$12.50 and add a test for it.

**Geno:** I'll find `formatPrice` and see how it handles input today.

- `grep` `{"pattern":"formatPrice"}` -> **ok**

  ```
  src/money.ts:6:export function formatPrice(cents: number, currency: Currency = 'USD'): string {
  test/money.test.ts:3:import { formatPrice, sum } from '../src/money.ts';
  test/money.test.ts:6:  assert.equal(formatPrice(1250), '$12.50');
  test/money.test.ts:7:  assert.equal(formatPrice(99900, 'THB'), '฿999.00');
  test/money.test.ts:8:  assert.equal(formatPrice(5), '$0.05');
  ```

- `read` `{"path":"src/money.ts"}` -> **ok**

  ```
   1	export type Currency = 'USD' | 'THB' | 'EUR';
   2	
   3	const SYMBOLS: Record<Currency, string> = { USD: '$', THB: '฿', EUR: '€' };
   4	
   5	/** Formats an amount in cents, such as 1250 -> "$12.50". */
   6	export function formatPrice(cents: number, currency: Currency = 'USD'): string {
   7	  const amount = cents / 100;
   8	  return `${SYMBOLS[currency]}${amount}`;
   9	}
  10	
  11	export function sum(prices: readonly number[]): number {
  12	  return prices.reduce((total, price) => total + price, 0);
  13	}
  ```

- `read` `{"path":"test/money.test.ts"}` -> **ok**

  ```
   1	import { test } from 'node:test';
   2	import assert from 'node:assert/strict';
   3	import { formatPrice, sum } from '../src/money.ts';
   4	
   5	test('formats cents with two decimals', () => {
   6	  assert.equal(formatPrice(1250), '$12.50');
   7	  assert.equal(formatPrice(99900, 'THB'), '฿999.00');
   8	  assert.equal(formatPrice(5), '$0.05');
   9	});
  10	
  11	test('sums prices', () => assert.equal(sum([100, 250]), 350));
  ```

**Geno:** The implementation looks like it wouldn't even produce the two-decimal output the existing tests expect — I'll run the test suite to see the current state.

- `bash` `{"command":"npm test 2>&1 | tail -30","description":"Run existing tests to check current pass/fail state"}` -> **ok**

  ```
    failureType: 'testCodeFailure'
    error: |-
      Expected values to be strictly equal:
      + actual - expected
      
      + 'hello---world'
      - 'hello-world'
               ^
      
    code: 'ERR_ASSERTION'
    name: 'AssertionError'
    expected: 'hello-world'
    actual: 'hello---world'
    operator: 'strictEqual'
    stack: |-
      TestContext.<anonymous> (file:///Users/me/Development/g-code/.claude/worktrees/agent-a9d5362ddfbbd2023/scratchpad/real-usecases/ws/A10-plan-mode-r1/repo/test/slug.test.ts:7:10)
      Test.runInAsyncScope (node:async_hooks:214:14)
      Test.run (node:internal/test_runner/tes
  … (262 more characters in session.jsonl)
  ```

**Geno:** Several tests were already failing before my task. Let me see which ones.

- `bash` `{"command":"npm test 2>&1 | grep -E '^# (tests|pass|fail)|not ok|failureType' | head -20","description":"List which tests fail"}` -> **ok**

  ```
  not ok 1 - single units
    failureType: 'testCodeFailure'
  not ok 2 - combined units
    failureType: 'testCodeFailure'
  not ok 4 - formats cents with two decimals
    failureType: 'testCodeFailure'
  not ok 6 - joins words with one dash
    failureType: 'testCodeFailure'
  # tests 6
  # pass 2
  # fail 4
  [exit code 0]
  ```

- `list` `{"directory":"src"}` -> **ok**

  ```
  src/config.ts
  src/duration.ts
  src/index.ts
  src/money.ts
  src/slug.ts
  ```

**Geno:** I've read the code and run the tests. Two things stand out:

1. `formatPrice` at src/money.ts:6 returns `${SYMBOLS[currency]}${cents / 100}` — no fixed decimals and no sign handling. For `-1250` it produces `$-12.5`; the target is `-$12.50`.
2. The existing test `formats cents with two decimals` **already fails** before any change (`formatPrice(1250)` → `$12.5`, expected `$12.50`). Producing `-$12.50` requires two-decimal formatting anyway, so the plan fixes that in the same edit. (`test/slug.test.ts` and a `units` test also fail, but they're unrelated — I'll leave them alone.)

- `todo` `{"items":[{"id":"1","text":"Rework formatPrice in src/money.ts: sign before symbol, Math.abs, toFixed(2)","status":"pending"},{"id":"2","text":"Add negative-amount tests to test/money.test.ts","status":"pending"},{"id":"3","text":"Run npm test; confirm money tests pass (pre-existing slug/units failu
… (34 more characters in session.jsonl)` -> **ok**

  ```
  Updated the todo list: 0 of 3 done.
  ```

**Geno:** ## Plan

**1. Rewrite `formatPrice` in src/money.ts:6**

```ts
/** Formats an amount in cents, such as 1250 -> "$12.50" and -1250 -> "-$12.50". */
export function formatPrice(cents: number, currency: Currency = 'USD'): string {
  const sign = cents < 0 ? '-' : '';
  const amount = (Math.abs(cents) / 100).toFixed(2);
  return `${sign}${SYMBOLS[currency]}${amount}`;
}
```

The minus goes before the currency symbol, matching your `-$12.50` example. Taking the absolute value first keeps the sign out of the middle (`$-12.50`), and `toFixed(2)` gives the two decimals the existing test already expects. `sum` and types are untouched.

**2. Add a test in test/money.test.ts**

```ts
test('formats negative cents with leading minus', () => {
  assert.equal(formatPrice(-1250), '-$12.50');
  assert.equal(formatPrice(-99900, 'THB'), '-฿999.00');
  assert.equal(formatPrice(-5), '-$0.05');
});
```

**3. Verify** with `npm test`: both money tests must pass.

## Risks and open questions

- **Sign placement convention**: some locales write `$-12.50` or `-$ 12.50`. I chose the leading `-$` from your example; if you need locale-correct output, the real fix is `Intl.NumberFormat` — say so and I'd change step 1.
- **Existing failing test**: `formats cents with two decimals` fails today on the positive path. The `toFixed(2)` above fixes it as a side effect; it's not a new regression.
- **Non-integer cent inputs**: `toFixed(2)` rounds them (e.g. `formatPrice(0.005)` → `$0.01`). Callers pass integers today, so no extra guard.
- **Out of scope**: `test/slug.test.ts` and the `units` tests fail for unrelated reasons; I won't touch them.
