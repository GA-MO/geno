# A28-explain-then-change, run fix-a2

Mode: non-interactive. Fixture: `ts-lib`. Model: qwen3.8-flash.

## User

What could we do about prices in currencies with no minor unit, like JPY? Do not change code yet.

**Geno:** Let me look at how prices and currencies are handled in this repo first.

- `list` `{"directory":""}` -> **ok**

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

- `grep` `{"pattern":"currency|currencies|JPY|price","ignore_case":true}` -> **ok**

  ```
  README.md:3:Small helpers for prices and slugs. Run the tests with `npm test` (Node 22, no dependencies).
  legacy/old-money.js:2:exports.price = (c) => "$" + c / 100;
  src/money.ts:1:export type Currency = 'USD' | 'THB' | 'EUR';
  src/money.ts:3:const SYMBOLS: Record<Currency, string> = { USD: '$', THB: '฿', EUR: '€' };
  src/money.ts:6:export function formatPrice(cents: number, currency: Currency = 'USD'): string {
  src/money.ts:8:  return `${SYMBOLS[currency]}${amount}`;
  src/money.ts:11:export function sum(prices: readonly number[]): number {
  src/money.ts:12:  return prices.reduce((total, price) =>
  … (380 more characters in session.jsonl)
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

**Geno:** Right now `formatPrice` (src/money.ts:7) hard-codes the divide-by-100 rule, which breaks for JPY where the smallest unit *is* the yen — ¥1250 must display as "¥1250", not "¥12.5". The standard fix is to replace the magic 100 with a per-currency minor-unit exponent table (ISO 4217 gives this: 2 for USD/EUR/THB, 0 for JPY, and there are even 3-exponent currencies like BHD), so amounts stay "integer units of the smallest coin" and formatting does `cents / 10**exponent[currency]`. The main trade-off is that this changes what "1250" means per call site — for JPY, callers must pass 1250 meaning ¥1250 rather than a cents-style value — so the convention (always integer minor units) has to be documented in the signature and tests, and `sum` and the legacy `formatPrice` in legacy/old-money.js would need to follow the same rule if you ever retire that file. If you want, I can make that change with tests for a zero-decimal case like JPY.
