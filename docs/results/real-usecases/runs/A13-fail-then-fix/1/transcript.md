# A13-fail-then-fix, run 1

Mode: non-interactive. Fixture: `ts-lib`. Model: qwen3.8-flash.

## User

Implement parseDuration in src/duration.ts so test/duration.test.ts passes.

**Geno:** I'll look at the test and the stub first.

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

**Geno:** The tests cover single units, combined units with optional spaces, and rejection of malformed input. I'll implement with a scan that requires contiguous matches.

- `edit` `{"path":"src/duration.ts","old_str":"/** Parses a duration such as \"1h30m\", \"45s\" or \"2d\" into seconds. Throws on anything else. */\nexport function parseDuration(text: string): number {\n  throw new Error('not implemented');\n}","new_str":"const UNIT_SECONDS: Record<string, number> = { s: 1, 
… (624 more characters in session.jsonl)` -> **ok**

  ```
  Edited src/duration.ts. The file state is current in your context; no need to read it back.
  
  check `node --test` failed (exit 1)
    ---
    duration_ms: 0.079042
    type: 'test'
    ...
  # Subtest: joins words with one dash
  not ok 6 - joins words with one dash
    ---
    duration_ms: 0.913375
    type: 'test'
    location: '/Users/me/Development/g-code/.claude/worktrees/agent-a9d5362ddfbbd2023/scratchpad/real-usecases/ws/A13-fail-then-fix-r1/repo/test/slug.test.ts:5:1'
    failureType: 'testCodeFailure'
    error: |-
      Expected values to be strictly equal:
      + actual - expected
      
      + 'hello---w
  … (719 more characters in session.jsonl)
  ```

- `bash` `{"command":"node --test test/duration.test.ts; echo \"exit=$?\"; git status --short","description":"Run duration tests and show git status"}` -> **ok**

  ```
  TAP version 13
  # Subtest: single units
  ok 1 - single units
    ---
    duration_ms: 0.351375
    type: 'test'
    ...
  # Subtest: combined units
  ok 2 - combined units
    ---
    duration_ms: 0.050875
    type: 'test'
    ...
  # Subtest: rejects bad input
  ok 3 - rejects bad input
    ---
    duration_ms: 0.089416
    type: 'test'
    ...
  1..3
  # tests 3
  # suites 0
  # pass 3
  # fail 0
  # cancelled 0
  # skipped 0
  # todo 0
  # duration_ms 58.125208
  exit=0
   M src/duration.ts
  [exit code 0]
  ```

**Geno:** Done. `parseDuration` in src/duration.ts:23 is implemented: it scans the string with a sticky-on-position loop over `\s*(\d+)([dhms])`, summing `d`/`h`/`m`/`s` values, and throws if anything fails to match contiguously (empty input, a bare number, an unknown unit, or leftover text). All 3 tests in test/duration.test.ts pass.

One note: the full `node --test` run also picks up test/slug.test.ts, which fails on a pre-existing `slug` implementation (`'hello---world'` vs `'hello-world'`). That's outside this task's scope, so I left it alone; the only file I changed is src/duration.ts.
