# A28-explain-then-change, run 1

Mode: non-interactive. Fixture: `ts-lib`. Model: qwen3.8-flash.

## User

What could we do about prices in currencies with no minor unit, like JPY? Do not change code yet.

**Geno:** Let me look at how the repo currently handles prices and currencies before answering.

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

- `grep` `{"pattern":"price|currency|JPY|cent|minor","ignore_case":true}` -> **ok**

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

- `bash` `{"command":"npm test 2>&1 | tail -20; cat src/config.ts","description":"Run tests and view config"}` -> **ok**

  ```
    name: 'AssertionError'
    expected: 'hello-world'
    actual: 'hello---world'
    operator: 'strictEqual'
    stack: |-
      TestContext.<anonymous> (file:///Users/me/Development/g-code/.claude/worktrees/agent-a9d5362ddfbbd2023/scratchpad/real-usecases/ws/A28-explain-then-change-r1/repo/test/slug.test.ts:7:10)
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
  … (161 more characters in session.jsonl)
  ```

**Geno:** Quick grounding first: `src/money.ts` stores every amount as integer "cents" and hard-codes `cents / 100`, so a JPY price of ¥1,250 would be stored as 125000 and formatted as `¥1250` — the exponent is baked in. (Also worth knowing: the money tests already fail today, since the code emits `$12.5` instead of `$12.50` — 4 of 6 tests in the suite are red, in money and slug.)

Two reasonable moves:

1. **Add a per-currency exponent to the currency table** (e.g. `{ USD: 2, EUR: 2, THB: 2, JPY: 0 }`), divide by `10**exponent`, and render with that many decimals. Amounts stay integers in the smallest real unit (1 yen, not 1/100 yen), and `formatPrice(1250, 'JPY')` becomes `¥1250`.
2. **Delegate formatting to `Intl.NumberFormat`** with the currency code and let ICU's built-in ISO 4217 exponent data do everything — no hand-maintained table, and you get proper grouping like `¥1,250`.

I'd recommend option 1 for this repo: it's a dozen lines, fits the existing symbol-map style and the no-dependency spirit, and fixes the missing-decimals bug at the same time by making decimal count data-driven. The main trade-off is that you own the exponent table and must remember it when adding currencies, whereas `Intl` (option 2) knows all of ISO 4217 for free but changes output format everywhere (grouping, spacing, `฿999.00` vs locale rules) and gives you less control over exact rendering. One decision to make either way: division of rounding — unit-denominated integer storage (¥1 = 1) is the sane choice over a fake 1/100- yen unit.

Say the word and I'll implement option 1 (or 2), including the rounding/formatting fix and tests.
