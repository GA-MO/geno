# A28-explain-then-change, run fix-s1-1

Mode: non-interactive. Fixture: `ts-lib`. Model: qwen3.8-flash.

## User

What could we do about prices in currencies with no minor unit, like JPY? Do not change code yet.

**Geno:** Let me look at how prices and currencies are handled in this repo first.

- `list` `{}` -> **ok**

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

- `grep` `{"pattern":"JPY|currency|CURRENCY","ignore_case":true}` -> **ok**

  ```
  src/money.ts:1:export type Currency = 'USD' | 'THB' | 'EUR';
  src/money.ts:3:const SYMBOLS: Record<Currency, string> = { USD: '$', THB: '฿', EUR: '€' };
  src/money.ts:6:export function formatPrice(cents: number, currency: Currency = 'USD'): string {
  src/money.ts:8:  return `${SYMBOLS[currency]}${amount}`;
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

- `read` `{"path":"legacy/old-money.js"}` -> **ok**

  ```
  1	// Kept for the v0 API. Do not edit: downstream code pins this file by hash.
  2	exports.price = (c) => "$" + c / 100;
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

- `read` `{"path":"src/index.ts"}` -> **ok**

  ```
  1	export * from './money.ts';
  2	export * from './slug.ts';
  3	export * from './config.ts';
  ```

- `read` `{"path":"README.md"}` -> **ok**

  ```
  1	# tiny-money
  2	
  3	Small helpers for prices and slugs. Run the tests with `npm test` (Node 22, no dependencies).
  ```

- `read` `{"path":"CHANGELOG.md"}` -> **ok**

  ```
  1	# Changelog
  2	
  3	## 0.3.1
  4	
  5	- fix: sum ignores empty lists (src/money.ts)
  ```

- `bash` `{"command":"node --test 2>&1 | tail -25","description":"Run the test suite"}` -> **ok**

  ```
      + 'hello---world'
      - 'hello-world'
               ^
      
    code: 'ERR_ASSERTION'
    name: 'AssertionError'
    expected: 'hello-world'
    actual: 'hello---world'
    operator: 'strictEqual'
    stack: |-
      TestContext.<anonymous> (file://<repo>/scratchpad/fixes-p03-p04/ws/A28-explain-then-change-rfix-s1-1/repo/test/slug.test.ts:7:10)
      Test.runInAsyncScope (node:async_hooks:214:14)
      Test.run (node:internal/test_runner/test:1047:25)
      Test.start (node:internal/test_runner/test:944:17)
      startSubtestAfterBootstrap (n
  … (163 more characters in session.jsonl)
  ```

- `bash` `{"command":"node --test 2>&1 | grep -E \"^(ok|not ok|# (tests|pass|fail))\" | head -20","description":"List which tests pass and fail"}` -> **ok**

  ```
  not ok 1 - single units
  not ok 2 - combined units
  ok 3 - rejects bad input
  not ok 4 - formats cents with two decimals
  ok 5 - sums prices
  not ok 6 - joins words with one dash
  # tests 6
  # pass 2
  # fail 4
  [exit code 0]
  ```

**Geno:** Looked at `src/money.ts` — right now every amount is an integer number of cents and `formatPrice` hardcodes `cents / 100` plus a fixed symbol map (`src/money.ts:3,7`), so a currency with no minor unit can't be expressed at all: JPY ¥500 would have to be passed as `50000` to print "¥500.00".

Two reasonable directions:

- **Per-currency exponent table** (ISO 4217 minor-unit counts): `USD/THB/EUR: 2, JPY/KRW/VND: 0, KWD/BHD/OMR: 3`, then divide by `10 ** exponent` and set `minimumFractionDigits` to that exponent. Keeps the existing "amounts are in minor units" contract, so `sum` and every caller stay unchanged; you only add `JPY` to the `Currency` union.
- **Delegate formatting to `Intl.NumberFormat(undefined, { style: 'currency', currency })`** instead of the `SYMBOLS` map, which gives the right fraction digits, grouping (`¥500`, not `¥500.00`) and locale for free, and derives the exponent itself. The trade-off is output that varies by locale and CI machine, so you'd want `en-US` pinned if the tests must stay exact.

I'd combine them: store an exponent map as the source of truth for arithmetic/validation, and use it with `Intl` for formatting, with a note in the docs that a `cents` argument means "minor units of that currency". Related pre-existing issue: the money test already fails on `formatPrice(1250)` because `1250 / 100` renders `12.5`, not `12.50` — either approach fixes that too, since trailing zeros come from fraction digits rather than string concatenation. (4 of 6 tests fail at HEAD, including two in `duration` and one in `slug`, none of them from this discussion.)
