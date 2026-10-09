# A28-explain-then-change, run fix-a1

Mode: non-interactive. Fixture: `ts-lib`. Model: qwen3.8-flash.

## User

What could we do about prices in currencies with no minor unit, like JPY? Do not change code yet.

**Geno:** Let me look at how prices and currencies are currently handled in this repo.

- `bash` `{"command":"ls -R . | head -50","description":"Show repository layout"}` -> **ok**

  ```
  CHANGELOG.md
  README.md
  legacy
  package.json
  src
  test
  
  ./legacy:
  old-money.js
  
  ./src:
  config.ts
  duration.ts
  index.ts
  money.ts
  slug.ts
  
  ./test:
  duration.test.ts
  money.test.ts
  slug.test.ts
  [exit code 0]
  ```

- `grep` `{"pattern":"price|currency|JPY|amount|cents","ignore_case":true}` -> **ok**

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

**Geno:** The tests may not even pass as-is. Let me run them to confirm the current state before answering.

- `bash` `{"command":"npm test 2>&1 | tail -20","description":"Run the test suite"}` -> **ok**

  ```
    name: 'AssertionError'
    expected: 'hello-world'
    actual: 'hello---world'
    operator: 'strictEqual'
    stack: |-
      TestContext.<anonymous> (file://<repo>/scratchpad/fixes-r1/ws/A28-explain-then-change-rfix-a1/repo/test/slug.test.ts:7:10)
      Test.runInAsyncScope (node:async_hooks:214:14)
      Test.run (node:internal/test_runner/test:1047:25)
      Test.start (node:internal/test_runner/test:944:17)
      startSubtestAfterBootstrap (node:internal/test_runner/harness:296:17)
    ...
  1..6
  # tests 6
  # suites 0
  # pass 2
  # fail 4
  # 
  … (71 more characters in session.jsonl)
  ```

**Geno:** Two things came out of looking at this. First, the immediate context: `formatPrice` in src/money.ts:6 hardcodes the cents→units divide-by-100 and a hand-rolled `SYMBOLS` table, so a unit-less currency like JPY can't be added without the same `100 JPY` being stored as `10000` and printed as `¥100` — the exponent is baked into both the storage convention and the formatter. (Side note: 4 of 6 tests already fail on this commit, including the money ones, because the formatter never does fixed-2-decimal output — `formatPrice(1250)` gives `$12.5`, not `$12.50`. Worth deciding whether that's part of this change.)

For JPY itself, the real options are:

1. **Per-currency exponent table** (recommended): keep integer smallest-unit amounts, add `'JPY'` with a units-per-major map (`USD: 100, JPY: 1, KWD: 1000`), and divide by that instead of the hardcoded 100. Small, explicit, matches the current style; the cost is maintaining the table as currencies are added.
2. **Delegate to `Intl.NumberFormat`** with `style: 'currency'`: it knows ISO 4217 exponents and symbols for free, so you delete `SYMBOLS` and the `/100`. Cleaner long-term, but output becomes locale-dependent (e.g. `JP¥1,000` vs `¥1,000`), which matters if these strings are stored, compared, or snapshotted in tests.
3. **Switch amounts to a major-unit decimal or a `{ amount, currency }` struct**: most correct eventually, but a breaking API change across `sum` and callers — I'd not do it just for JPY.

My pick: option 1 now since it fits the existing code and fixes the formatting tests at the same time; move to option 2 if you ever need more than a handful of currencies and can pin the locale in tests. Want me to implement option 1?
