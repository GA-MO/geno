# A10-plan-mode, run sonnet-1

Mode: plan. Fixture: `ts-lib`. Model: claude-sonnet-5-5.

## User

Make formatPrice support negative amounts like -$12.50 and add a test for it.

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

- `todo` `{"items":[{"id":"1","text":"Fix formatPrice in src/money.ts: use absolute value with toFixed(2), prefix '-' before symbol when negative","status":"pending"},{"id":"2","text":"Add negative-amount test in test/money.test.ts (-1250, -5, THB, 0)","status":"pending"},{"id":"3","text":"Run npm test","stat
… (16 more characters in session.jsonl)` -> **ok**

  ```
  Updated the todo list: 0 of 3 done.
  ```

**Geno:** **Plan**

I changed nothing, since this is Plan mode.

**Finding:** `formatPrice` at `src/money.ts:7-8` does `${symbol}${cents / 100}`. It never pads decimals, so `formatPrice(1250)` returns `$12.5`. The existing test at `test/money.test.ts:6` should therefore already fail. Negatives would come out as `$-12.5`, with the sign in the wrong place. I haven't run the tests to confirm.

**Steps**
1. In `src/money.ts`, rewrite the body of `formatPrice`:
   ```ts
   const sign = cents < 0 ? '-' : '';
   const amount = (Math.abs(cents) / 100).toFixed(2);
   return `${sign}${SYMBOLS[currency]}${amount}`;
   ```
   This puts the sign before the symbol (`-$12.50`) and also fixes the two-decimal padding.
2. In `test/money.test.ts`, add a test `formats negative amounts` with these assertions:
   - `formatPrice(-1250)` is `-$12.50`
   - `formatPrice(-5)` is `-$0.05`
   - `formatPrice(-99900, 'THB')` is `-฿999.00`
   - `formatPrice(0)` is `$0.00`
3. Run `npm test` (`node --test`).

**Risks and open questions**
- **Negative zero:** `cents` of `-0` doesn't count as `< 0`, so it prints `$0.00`. That is what I want.
- **Fractional cents:** Inputs like `-0.4` would give `-$0.00`. Cents should be integers, so I'd leave it alone unless you want rounding added.
- **Style:** I chose `-$12.50` because you wrote it that way. Some locales use `($12.50)` instead.
