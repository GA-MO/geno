# A18-project-skill, run 1

Mode: non-interactive. Fixture: `ts-lib`. Model: qwen3.8-flash.

## User

Fix formatPrice so it always shows two decimals, then add a changelog entry for it.

**Geno:** I'll look at the repo first to find `formatPrice` and the changelog format.

- `bash` `{"command":"find . -type f -not -path './.git/*' | head -50","description":"List files in the repo"}` -> **ok**

  ```
  ./test/money.test.ts
  ./test/slug.test.ts
  ./test/duration.test.ts
  ./CHANGELOG.md
  ./.agents/skills/changelog/SKILL.md
  ./legacy/old-money.js
  ./README.md
  ./.g-code/settings.json
  ./.gitignore
  ./package.json
  ./src/slug.ts
  ./src/money.ts
  ./src/duration.ts
  ./src/index.ts
  ./src/config.ts
  [exit code 0]
  ```

- `grep` `{"pattern":"formatPrice"}` -> **ok**

  ```
  src/money.ts:6:export function formatPrice(cents: number, currency: Currency = 'USD'): string {
  test/money.test.ts:3:import { formatPrice, sum } from '../src/money.ts';
  test/money.test.ts:6:  assert.equal(formatPrice(1250), '$12.50');
  test/money.test.ts:7:  assert.equal(formatPrice(99900, 'THB'), '฿999.00');
  test/money.test.ts:8:  assert.equal(formatPrice(5), '$0.05');
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

- `read` `{"path":"CHANGELOG.md"}` -> **ok**

  ```
  1	# Changelog
  2	
  3	## 0.3.1
  4	
  5	- fix: sum ignores empty lists (src/money.ts)
  ```

- `read` `{"path":".agents/skills/changelog/SKILL.md"}` -> **ok**

  ```
   1	---
   2	name: changelog
   3	description: Add an entry to CHANGELOG.md in this project's format. Use whenever the user asks for a changelog or release note.
   4	---
   5	
   6	# Changelog entries
   7	
   8	1. Read CHANGELOG.md first.
   9	2. Add the entry under the `## Unreleased` heading, creating it at the top if it is missing.
  10	3. Each entry is one line: `- <area>: <what changed, past tense> (<file>)`, where area is one of fix, feat, chore.
  11	4. End the turn by quoting the exact line you added, prefixed with `Changelog:`.
  ```

- `edit` `{"path":"src/money.ts","old_str":"  return '${SYMBOLS[currency]}${amount}';","new_str":"  return '${SYMBOLS[currency]}${amount.toFixed(2)}';"}` -> **ok**

  ```
  Edited src/money.ts. The file state is current in your context; no need to read it back.
  
  check `node --test` failed (exit 1)
    ---
    duration_ms: 0.059292
    type: 'test'
    ...
  # Subtest: joins words with one dash
  not ok 6 - joins words with one dash
    ---
    duration_ms: 1.752709
    type: 'test'
    location: '/Users/me/Development/g-code/.claude/worktrees/agent-a9d5362ddfbbd2023/scratchpad/real-usecases/ws/A18-project-skill-r1/repo/test/slug.test.ts:5:1'
    failureType: 'testCodeFailure'
    error: |-
      Expected values to be strictly equal:
      + actual - expected
      
      + 'hello---worl
  … (717 more characters in session.jsonl)
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

- `bash` `{"command":"node --test test/money.test.ts","description":"Run the money tests"}` -> **ok**

  ```
  TAP version 13
  # Subtest: formats cents with two decimals
  ok 1 - formats cents with two decimals
    ---
    duration_ms: 0.315792
    type: 'test'
    ...
  # Subtest: sums prices
  ok 2 - sums prices
    ---
    duration_ms: 0.051083
    type: 'test'
    ...
  1..2
  # tests 2
  # suites 0
  # pass 2
  # fail 0
  # cancelled 0
  # skipped 0
  # todo 0
  # duration_ms 61.889291
  [exit code 0]
  ```

- `bash` `{"command":"git stash && node --test test/slug.test.ts; echo \"exit=$?\"; git stash pop","description":"Check if slug test fails before my change"}` -> **ok**

  ```
  Saved working directory and index state WIP on main: 94bba95 Initial commit
  TAP version 13
  # Subtest: joins words with one dash
  not ok 1 - joins words with one dash
    ---
    duration_ms: 0.876
    type: 'test'
    location: '/Users/me/Development/g-code/.claude/worktrees/agent-a9d5362ddfbbd2023/scratchpad/real-usecases/ws/A18-project-skill-r1/repo/test/slug.test.ts:5:1'
    failureType: 'testCodeFailure'
    error: |-
      Expected values to be strictly equal:
      + actual - expected
      
      + 'hello---world'
      - 'hello-world'
               ^
      
    code: 'ERR_ASSERTION'
    name: 'AssertionErro
  … (987 more characters in session.jsonl)
  ```

- `edit` `{"path":"CHANGELOG.md","old_str":"# Changelog\n\n## 0.3.1","new_str":"# Changelog\n\n## Unreleased\n\n- fix: formatPrice always shows two decimals (src/money.ts)\n\n## 0.3.1"}` -> **ok**

  ```
  Edited CHANGELOG.md. The file state is current in your context; no need to read it back.
  
  check `node --test` failed (exit 1)
    ---
    duration_ms: 0.056542
    type: 'test'
    ...
  # Subtest: joins words with one dash
  not ok 6 - joins words with one dash
    ---
    duration_ms: 1.015291
    type: 'test'
    location: '/Users/me/Development/g-code/.claude/worktrees/agent-a9d5362ddfbbd2023/scratchpad/real-usecases/ws/A18-project-skill-r1/repo/test/slug.test.ts:5:1'
    failureType: 'testCodeFailure'
    error: |-
      Expected values to be strictly equal:
      + actual - expected
      
      + 'hello---worl
  … (717 more characters in session.jsonl)
  ```

**Geno:** Done. Two changes:

- **src/money.ts:8** — `formatPrice` now uses `amount.toFixed(2)`, so 1250 renders `$12.50` instead of `$12.5`. All money tests pass (`node --test test/money.test.ts`).
- **CHANGELOG.md** — created the missing `## Unreleased` section at the top and added the entry in the project's skill format.

Note: the full `node --test` still reports 3 failures, all in `test/slug.test.ts` and `test/duration.test.ts`. I verified on the clean tree (via stash) that the slug failure predates my change; neither suite touches `money.ts`, so these are pre-existing and I left them alone.

Changelog: `- fix: formatPrice always shows two decimals (src/money.ts)`
