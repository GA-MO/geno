# A28-explain-then-change, run sonnet-1

Mode: non-interactive. Fixture: `ts-lib`. Model: claude-sonnet-5-5.

## User

What could we do about prices in currencies with no minor unit, like JPY? Do not change code yet.

- `grep` `{"pattern":"cents|currency|toFixed|/ 100|\\* 100","ignore_case":true}` -> **ok**

  ```
  legacy/old-money.js:2:exports.price = (c) => "$" + c / 100;
  src/money.ts:1:export type Currency = 'USD' | 'THB' | 'EUR';
  src/money.ts:3:const SYMBOLS: Record<Currency, string> = { USD: '$', THB: '฿', EUR: '€' };
  src/money.ts:5:/** Formats an amount in cents, such as 1250 -> "$12.50". */
  src/money.ts:6:export function formatPrice(cents: number, currency: Currency = 'USD'): string {
  src/money.ts:7:  const amount = cents / 100;
  src/money.ts:8:  return `${SYMBOLS[currency]}${amount}`;
  test/money.test.ts:5:test('formats cents with two decimals', () => {
  ```

**Geno:** I'd put the exponent in a table next to `SYMBOLS` in `src/money.ts` and stop hardcoding `/ 100` in `formatPrice`. I've only read the code, not changed it.

`formatPrice` at `src/money.ts:7` divides every amount by 100. For JPY, a stored value of 1500 would display as "¥15", which is 100 times too small. Adding `'JPY'` to `Currency` would not fix that on its own.

- **Exponent table:** add `const MINOR_UNITS: Record<Currency, number> = { USD: 2, THB: 2, EUR: 2, JPY: 0 }`. Use `10 ** exponent` as the divisor and `toFixed(exponent)` for display. The `Record` type makes the compiler force an entry whenever a currency is added.
- **`Intl.NumberFormat`:** this is the alternative. It handles exponents, symbols and grouping from ISO codes. The trade-off is that its output differs from the current format, for example `฿` placement and locale-dependent separators, so existing tests would need updating.
- **Pre-existing bug:** the current code prints `$12.5` instead of `$12.50`, because `amount` is never fixed to 2 decimals. The `toFixed` change would fix that too.
- **Naming:** the parameter is called `cents`, which is misleading for JPY. Renaming it to `minorUnits` would be clearer.
- **Legacy code:** `legacy/old-money.js` has the same `/ 100` assumption. I'd leave it alone unless something still uses it.

I'd go with the exponent table. It's the smallest change and keeps the current output style. Want me to implement it, with a JPY test?
