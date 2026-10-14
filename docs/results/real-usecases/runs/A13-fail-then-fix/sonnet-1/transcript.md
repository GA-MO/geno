# A13-fail-then-fix, run sonnet-1

Mode: non-interactive. Fixture: `ts-lib`. Model: claude-sonnet-5-5.

## User

Implement parseDuration in src/duration.ts so test/duration.test.ts passes.

- `read` `{"path":"src/duration.ts"}` -> **ok**

  ```
  1	/** Parses a duration such as "1h30m", "45s" or "2d" into seconds. Throws on anything else. */
  2	export function parseDuration(text: string): number {
  3	  throw new Error('not implemented');
  4	}
  ```

- `read` `{"path":"test/duration.test.ts"}` -> **ok**

  ```
   1	import { test } from 'node:test';
   2	import assert from 'node:assert/strict';
   3	import { parseDuration } from '../src/duration.ts';
   4	
   5	test('single units', () => {
   6	  assert.equal(parseDuration('45s'), 45);
   7	  assert.equal(parseDuration('2h'), 7200);
   8	  assert.equal(parseDuration('90m'), 5400);
   9	  assert.equal(parseDuration('2d'), 172800);
  10	});
  11	
  12	test('combined units', () => {
  13	  assert.equal(parseDuration('1h30m'), 5400);
  14	  assert.equal(parseDuration('1d2h3m4s'), 93784);
  15	  assert.equal(parseDuration('1h 30m'), 5400);
  16	});
  17	
  18	test('rejects bad input', () =>
  … (196 more characters in session.jsonl)
  ```

**Geno:** Allow optional whitespace between parts; require full match.

- `edit` `{"path":"src/duration.ts","create":true,"new_str":"const SECONDS_PER_UNIT: Record<string, number> = { d: 86400, h: 3600, m: 60, s: 1 };\n\n/** Parses a duration such as \"1h30m\", \"45s\" or \"2d\" into seconds. Throws on anything else. */\nexport function parseDuration(text: string): number {\n  co
… (302 more characters in session.jsonl)` -> **ok**

  ```
  Edited src/duration.ts. The file state is current in your context; no need to read it back.
  
  check `node --test` failed (exit 1)
    ---
    duration_ms: 0.218292
    type: 'test'
    ...
  # Subtest: joins words with one dash
  not ok 6 - joins words with one dash
    ---
    duration_ms: 3.313667
    type: 'test'
    location: '/private/tmp/claude-501/-Users-sbpdigital-Development-g-code/ec3e6529-0122-4973-a86e-dc3119e42c47/scratchpad/sonnet-final/ws/A13-fail-then-fix-rsonnet-1/repo/test/slug.test.ts:5:1'
    failureType: 'testCodeFailure'
    error: |-
      Expected values to be strictly equal:
      + actual - expec
  … (769 more characters in session.jsonl)
  ```

- `bash` `{"command":"npm test 2>&1 | tail -15"}` -> **ok**

  ```
      TestContext.<anonymous> (file:///private/tmp/claude-501/-Users-sbpdigital-Development-g-code/ec3e6529-0122-4973-a86e-dc3119e42c47/scratchpad/sonnet-final/ws/A13-fail-then-fix-rsonnet-1/repo/test/slug.test.ts:7:10)
      Test.runInAsyncScope (node:async_hooks:214:14)
      Test.run (node:internal/test_runner/test:1047:25)
      Test.start (node:internal/test_runner/test:944:17)
      startSubtestAfterBootstrap (node:internal/test_runner/harness:296:17)
    ...
  1..6
  # tests 6
  # suites 0
  # pass 4
  # fail 2
  # cancelled 0
  # skipped 0
  # todo 0
  # duration_ms 184.87775
  [exit code 0]
  ```

**Geno:** Two failures; check whether they're duration ones.

- `bash` `{"command":"npm test 2>&1 | grep -E \"^(not )?ok\""}` -> **ok**

  ```
  ok 1 - single units
  ok 2 - combined units
  ok 3 - rejects bad input
  not ok 4 - formats cents with two decimals
  ok 5 - sums prices
  not ok 6 - joins words with one dash
  [exit code 0]
  ```

**Geno:** I implemented `parseDuration` in `src/duration.ts`, and all three tests in `test/duration.test.ts` now pass. The full `npm test` run still has 2 failures, in other test files.

The function trims the input and requires one or more `<digits><d|h|m|s>` parts, with optional whitespace between them. Anything else throws. It sums the parts in seconds, so `"1h 30m"` works as the tests expect.

The two failing tests are "formats cents with two decimals" and "joins words with one dash". The second is in `test/slug.test.ts`, where it gets `hello---world` instead of `hello-world`. I didn't touch either one or look at the code behind them.
