# A28-explain-then-change, run fix-s3-1

Mode: non-interactive. Fixture: `ts-lib`. Model: qwen3.8-flash.

## User

What could we do about prices in currencies with no minor unit, like JPY? Do not change code yet.

**Geno:** I'll look for the cent/halving logic in this repo first.

- `grep` `{"pattern":"cent|Cent|halv|price|Price|amount|Amount","glob":"*.{js,mjs,cjs,ts}"}` -> **ok**

  ```
  legacy/old-money.js:2:exports.price = (c) => "$" + c / 100;
  src/money.ts:5:/** Formats an amount in cents, such as 1250 -> "$12.50". */
  src/money.ts:6:export function formatPrice(cents: number, currency: Currency = 'USD'): string {
  src/money.ts:7:  const amount = cents / 100;
  src/money.ts:8:  return `${SYMBOLS[currency]}${amount}`;
  src/money.ts:11:export function sum(prices: readonly number[]): number {
  src/money.ts:12:  return prices.reduce((total, price) => total + price, 0);
  test/money.test.ts:3:import { formatPrice, sum } from '../src/money.ts';
  test/money.test.ts:5:test('formats cents wit
  … (312 more characters in session.jsonl)
  ```

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

**Geno:** The issue is that `formatPrice` in src/money.ts:7 hardcodes `cents / 100`, but JPY has no minor unit — ¥100 is stored as 100, not 10000, so the divisor should be 1 for it. The natural fix is an ISO 4217-style table of per-currency exponents (`USD: 2, EUR: 2, JPY: 0`) alongside `SYMBOLS` in src/money.ts:3, keeping amounts as integers in the smallest unit and only using the exponent at the format/parse edges. The alternative is delegating to `Intl.NumberFormat` with a currency code, which handles exponents and locale formatting for free but makes output depend on the runtime locale and gives up control of the exact symbol. My recommendation is the exponent table: it's a small change, composes with the odd-cent rounding fix we discussed (rounding rules can use the same exponent), and stays deterministic — want me to go ahead with that?
