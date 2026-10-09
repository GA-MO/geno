# A28-explain-then-change, run fix-b2

Mode: non-interactive. Fixture: `ts-lib`. Model: qwen3.8-flash.

## User

What could we do about prices in currencies with no minor unit, like JPY? Do not change code yet.

**Geno:** Let me look at how prices are currently handled in the codebase before answering.

- `bash` `{"command":"ls -R . | head -50","description":"List repository files"}` -> **ok**

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

- `grep` `{"pattern":"price|currency|JPY|cents|minor","ignore_case":true}` -> **ok**

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

- `read` `{"path":"src/config.ts"}` -> **ok**

  ```
  1	export const config = {
  2		retries: 3,
  3		timeout: 1000,
  4		baseUrl: 'http://localhost:8080',
  5	};
  ```

**Geno:** Right now `formatPrice` hard-codes "divide by 100, always" (src/money.ts:6), so a JPY amount stored as 1000 units would wrongly print `¥10` instead of `¥1000`. I'd add a per-currency exponent map next to `SYMBOLS` — e.g. `{ USD: 2, EUR: 2, THB: 2, JPY: 0 }` — and have `formatPrice` divide by `10 ** exponent` and pad to that many decimals. That keeps the existing "integers in the smallest unit" convention and the tests deterministic, with the trade-off that you hand-maintain exponents per currency.

The alternative is delegating to `Intl.NumberFormat` with the currency code, which knows exponents (and grouping, and symbol placement) for free — but it would change current output (locale-dependent, and `฿999.00` may render as `THB 999.00`), so it's a bigger behavioral shift than this small helper probably needs.

One thing to flag: THB does have a minor unit (satang, exponent 2), so it's fine as-is; the only real gap is currencies like JPY, KRW, VND with exponent 0. Happy to make the exponent-map change if you want it.
