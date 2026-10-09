# A28-explain-then-change, run 2

Mode: non-interactive. Fixture: `ts-lib`. Model: qwen3.8-flash.

## User

What could we do about prices in currencies with no minor unit, like JPY? Do not change code yet.

**Geno:** Let me look at how prices and currencies are handled in this repo before answering.

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

- `grep` `{"pattern":"price|currency|cents|JPY|USD|amount","ignore_case":true}` -> **ok**

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

**Geno:** The current design hardcodes two decimal places: `src/money.ts:7` always divides by 100. Let me check whether the existing tests even pass, since the format on line 8 looks like it drops trailing zeros.

- `bash` `{"command":"npm test 2>&1 | tail -20","description":"Run the test suite"}` -> **ok**

  ```
    name: 'AssertionError'
    expected: 'hello-world'
    actual: 'hello---world'
    operator: 'strictEqual'
    stack: |-
      TestContext.<anonymous> (file:///Users/me/Development/g-code/.claude/worktrees/agent-a9d5362ddfbbd2023/scratchpad/real-usecases/ws/A28-explain-then-change-r2/repo/test/slug.test.ts:7:10)
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

- `bash` `{"command":"npm test 2>&1 | grep -A6 'money'","description":"Show money test failures"}` -> **ok**

  ```
  > tiny-money@0.3.1 test
  > node --test
  
  TAP version 13
  # Subtest: single units
  not ok 1 - single units
    ---
  --
    location: '/Users/me/Development/g-code/.claude/worktrees/agent-a9d5362ddfbbd2023/scratchpad/real-usecases/ws/A28-explain-then-change-r2/repo/test/money.test.ts:5:1'
    failureType: 'testCodeFailure'
    error: |-
      Expected values to be strictly equal:
      
      '$12.5' !== '$12.50'
      
  --
      TestContext.<anonymous> (file:///Users/me/Development/g-code/.claude/worktrees/agent-a9d5362ddfbbd2023/scratchpad/real-usecases/ws/A28-explain-then-change-r2/repo/test/money.te
  … (288 more characters in session.jsonl)
  ```

**Geno:** Short answer: put the fraction-digit count on the currency itself (ISO 4217 minor units), and let `Intl.NumberFormat` do the rendering. Details:

**Where we are.** `src/money.ts:6-9` hardcodes the assumption: every amount is "cents", always divided by 100, and `USD | THB | EUR` are all 2-decimal currencies. Related finding: 4 of 6 tests already fail — `formatPrice(1250)` returns `$12.5`, not `$12.50`, because the template uses raw number interpolation instead of fixed decimals. So the display precision is already an open bug; JPY just makes it structural.

**Options:**

1. **Digits-per-currency table (the standard fix).** Replace the symbol map with a spec map:
   ```ts
   const CURRENCIES = {
     USD: { symbol: '$', digits: 2 },
     JPY: { symbol: '¥', digits: 0 },
   };
   ```
   Amounts stay integers, but in *each currency's smallest unit* (¥1250 is stored as `1250`, not `125000`), and format divides by `10 ** digits`. Cheap, explicit, and `sum` keeps working since it's unit-agnostic per currency.
2. **`Intl.NumberFormat` with `style: 'currency'`.** You still need the digits table to convert stored units to major units, but then CLDR gives you symbol, locale, and the zero-decimal rule for free — and grouping, which matters for JPY/KRW/VND where prices read `¥1,250`. Trade-off: output becomes locale-dependent, so snapshot tests and any parsing of the string get messier.
3. **Store everything in major units with a decimal type.** Cleanest semantics, but a real migration of `formatPrice`'s contract and all callers — overkill here.

**My recommendation:** option 1 plus `Intl` for formatting (1 and 2 combined): one `Record<Currency, { symbol, digits }>` (or just map currency codes straight to `Intl`, keeping the table only for the divide), rename the `cents` parameter to something like `minorUnits`, and fix the two-decimal truncation bug in the same pass. The main trade-off to accept is that the integer's *meaning* becomes currency-dependent — a `1250` means $12.50 in USD but ¥1250 in JPY — so any place that mixes amounts across currencies would need care (there is none in this repo today; `sum` assumes one currency).

Say the word and I'll implement it, including the currently-failing money tests.
