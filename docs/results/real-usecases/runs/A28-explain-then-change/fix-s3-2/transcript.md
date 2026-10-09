# A28-explain-then-change, run fix-s3-2

Mode: non-interactive. Fixture: `ts-lib`. Model: qwen3.8-flash.

## User

What could we do about prices in currencies with no minor unit, like JPY? Do not change code yet.

**Geno:** I'll look at how prices are currently handled in this codebase before recommending anything.

- `grep` `{"pattern":"price|amount|currency|cents|decimal","ignore_case":true}` -> **ok**

  ```
  README.md:3:Small helpers for prices and slugs. Run the tests with `npm test` (Node 22, no dependencies).
  legacy/old-money.js:2:exports.price = (c) => "$" + c / 100;
  src/money.ts:1:export type Currency = 'USD' | 'THB' | 'EUR';
  src/money.ts:3:const SYMBOLS: Record<Currency, string> = { USD: '$', THB: '฿', EUR: '€' };
  src/money.ts:5:/** Formats an amount in cents, such as 1250 -> "$12.50". */
  src/money.ts:6:export function formatPrice(cents: number, currency: Currency = 'USD'): string {
  src/money.ts:7:  const amount = cents / 100;
  src/money.ts:8:  return `${SYMBOLS[currency]}${amount}`;
  src/mone
  … (570 more characters in session.jsonl)
  ```

- `list` `{"depth":2}` -> **ok**

  ```
  .agents/
  .agents/skills/ (1 file)
  .g-code/
  .g-code/settings.json
  .gitignore
  CHANGELOG.md
  README.md
  legacy/
  legacy/old-money.js
  package.json
  src/
  src/config.ts
  src/duration.ts
  src/index.ts
  src/money.ts
  src/slug.ts
  test/
  test/duration.test.ts
  test/money.test.ts
  test/slug.test.ts
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

**Geno:** The problem is in `src/money.ts:6-8`: `formatPrice` hardcodes `cents / 100` and formats the same way for every currency. For a zero-decimal currency like JPY (also KRW, VND, CLP), ¥1,250 would render as `¥12.5`, off by 100×. The natural fix is a per-currency minor-unit exponent (ISO 4217 gives 2 for USD/EUR/THB, 0 for JPY) and to keep storing amounts as integer main units for JPY, so `sum` and the data model stay in whole yen.

Two ways to get that data:

1. **Small exponent table in `money.ts`** — divide by `10 ** exponent` and format with `toFixed(exponent)`. Explicit and testable, but you maintain the table as currencies are added. (While here: `toFixed` also fixes a latent bug — today `formatPrice(1000)` returns `$1`, not `$10.00`, because template interpolation drops trailing zeros.)
2. **`Intl.NumberFormat('en', { style: 'currency', currency })`** — the exponent and symbol come from the platform for free and you delete the `SYMBOLS` map, but output becomes locale- and runtime-dependent, which can surprise your existing tests and any caller relying on the exact string.

My recommendation: option 1 — it keeps the current exact-string contract and the repo's dependency-free style, and the table is three lines. Say the word and I'll add `JPY: 0`, thread the exponent through `formatPrice`, and cover it with tests.
