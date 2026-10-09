# A28-explain-then-change, run fix-s2-3

Mode: non-interactive. Fixture: `ts-lib`. Model: qwen3.8-flash.

## User

What could we do about prices in currencies with no minor unit, like JPY? Do not change code yet.

**Geno:** Let me look at how this repo handles money and currencies before answering.

- `bash` `{"command":"git -C . ls-files | head -100 && echo \"---\" && du -sh ."}` -> **ok**

  ```
  .agents/skills/changelog/SKILL.md
  .g-code/settings.json
  .gitignore
  CHANGELOG.md
  README.md
  legacy/old-money.js
  package.json
  src/config.ts
  src/duration.ts
  src/index.ts
  src/money.ts
  src/slug.ts
  test/duration.test.ts
  test/money.test.ts
  test/slug.test.ts
  ---
  256K	.
  [exit code 0]
  ```

- `grep` `{"pattern":"(?i)(currency|JPY|cent|price|amount|decimal|minor)","glob":"**/*.{js,mjs,cjs,ts,json,md}"}` -> **ok**

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

- `read` `{"path":"src/config.ts"}` -> **ok**

  ```
  1	export const config = {
  2		retries: 3,
  3		timeout: 1000,
  4		baseUrl: 'http://localhost:8080',
  5	};
  ```

- `read` `{"path":"CHANGELOG.md"}` -> **ok**

  ```
  1	# Changelog
  2	
  3	## 0.3.1
  4	
  5	- fix: sum ignores empty lists (src/money.ts)
  ```

- `bash` `{"command":"cat package.json; echo \"--- README\"; cat README.md; echo \"--- index\"; cat src/index.ts; echo \"--- legacy\"; cat legacy/old-money.js"}` -> **ok**

  ```
  {
    "name": "tiny-money",
    "version": "0.3.1",
    "type": "module",
    "private": true,
    "scripts": {
      "test": "node --test"
    }
  }
  --- README
  # tiny-money
  
  Small helpers for prices and slugs. Run the tests with `npm test` (Node 22, no dependencies).
  --- index
  export * from './money.ts';
  export * from './slug.ts';
  export * from './config.ts';
  --- legacy
  // Kept for the v0 API. Do not edit: downstream code pins this file by hash.
  exports.price = (c) => "$" + c / 100;
  [exit code 0]
  [Geno] Next time, read files with the read tool, not cat, head, tail or sed -n: it numbers the lines, pages a lon
  … (37 more characters in session.jsonl)
  ```

- `check` `{}` -> **ok**

  ```
  check `node --test` failed (exit 1)
    ---
    duration_ms: 0.077542
    type: 'test'
    ...
  # Subtest: joins words with one dash
  not ok 6 - joins words with one dash
    ---
    duration_ms: 0.965208
    type: 'test'
    location: '<repo>/scratchpad/fixes-p03-p04/ws/A28-explain-then-change-rfix-s2-3/repo/test/slug.test.ts:5:1'
    failureType: 'testCodeFailure'
    error: |-
      Expected values to be strictly equal:
      + actual - expected
      
      + 'hello---world'
      - 'hello-world'
               ^
      
    code: 'ERR_ASSERTION'
    name: 'A
  … (653 more characters in session.jsonl)
  ```

- `bash` `{"command":"node --test test/money.test.ts 2>&1 | grep -E \"^(not ok|ok|actual|expected|\\+ |- )\" | head -40"}` -> **ok**

  ```
  not ok 1 - formats cents with two decimals
  ok 2 - sums prices
  [exit code 0]
  ```

- `bash` `{"command":"node --test test/money.test.ts 2>&1 | sed -n '1,40p'"}` -> **ok**

  ```
  TAP version 13
  # Subtest: formats cents with two decimals
  not ok 1 - formats cents with two decimals
    ---
    duration_ms: 0.538334
    type: 'test'
    location: '<repo>/scratchpad/fixes-p03-p04/ws/A28-explain-then-change-rfix-s2-3/repo/test/money.test.ts:5:1'
    failureType: 'testCodeFailure'
    error: |-
      Expected values to be strictly equal:
      
      '$12.5' !== '$12.50'
      
    code: 'ERR_ASSERTION'
    name: 'AssertionError'
    expected: '$12.50'
    actual: '$12.5'
    operator: 'strictEqual'
    stack: |-
      TestContext.<anonym
  … (633 more characters in session.jsonl)
  ```

- `bash` `{"command":"node --test test/slug.test.ts test/duration.test.ts 2>&1 | grep -E \"^(ok|not ok)\" "}` -> **ok**

  ```
  not ok 1 - single units
  not ok 2 - combined units
  ok 3 - rejects bad input
  not ok 4 - joins words with one dash
  [exit code 0]
  ```

**Geno:** Looked at `src/money.ts:6` — the whole issue is that `formatPrice` hardcodes `/ 100`, so it assumes every currency has two decimal places.

The cheapest fix is to pair the exponent with the symbol in one table, e.g. `{ USD: {symbol:'$', decimals:2}, THB: {symbol:'฿', decimals:2}, JPY: {symbol:'¥', decimals:0} }`, and format as `cents / 10**decimals` with `toFixed(decimals)`. That keeps the input as integer minor units, which matters because `sum` (src/money.ts:11) relies on exact integer arithmetic — for JPY the minor unit simply *is* the yen, so `1250` means ¥1250 and nothing downstream has to special-case it. The main trade-off versus the alternative, handing the job to `Intl.NumberFormat` with `style:'currency'`: Intl already knows ISO 4217 exponents (including the 3-decimal rarer ones) so you drop the table, but output becomes locale-dependent (`¥1,250` grouping, `€` placement varies) and you still have to scale the amount yourself before calling it, so it's a bigger behavioural change than this repo's tests currently expect.

Two things I noticed but did not touch:

- Pre-existing failures unrelated to this: `node --test` reports 4 of 6 failing. `test/money.test.ts:6` expects `'$12.50'` but `formatPrice` never pads decimals (`'$12.5'`), and `test/slug.test.ts:5` expects `'hello-world'` but gets `'hello---world'`. Adding JPY support with `toFixed(decimals)` would incidentally fix the money one.
- `legacy/old-money.js` is the same `/100` logic with a comment saying downstream pins the file by hash, so it should stay as it is even though it shares the bug.

Want me to implement the decimals table (and JPY), or keep `Intl` in the picture?
