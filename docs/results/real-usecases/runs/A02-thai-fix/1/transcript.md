# A02-thai-fix, run 1

Mode: non-interactive. Fixture: `ts-lib`. Model: qwen3.8-flash.

## User

เทสของ slugify พังอยู่ ช่วยแก้โค้ดให้ผ่านหน่อย แล้วสรุปสั้นๆ ว่าแก้อะไร

**Geno:** ดูโค้ดและเทสของ slugify ก่อนครับ

- `grep` `{"pattern":"slugify"}` -> **ok**

  ```
  src/slug.ts:2:export function slugify(title: string): string {
  test/slug.test.ts:3:import { slugify } from '../src/slug.ts';
  test/slug.test.ts:6:  assert.equal(slugify('Hello World'), 'hello-world');
  test/slug.test.ts:7:  assert.equal(slugify('  Hello   World  '), 'hello-world');
  test/slug.test.ts:8:  assert.equal(slugify('Rock & Roll!'), 'rock-roll');
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

- `read` `{"path":"src/slug.ts"}` -> **ok**

  ```
  1	/** Turns a title into a URL slug: lower case, words joined by single dashes. */
  2	export function slugify(title: string): string {
  3	  return title.trim().toLowerCase().replace(/[^a-z0-9 ]/g, '').replace(/ /g, '-');
  4	}
  ```

- `read` `{"path":"test/slug.test.ts"}` -> **ok**

  ```
  1	import { test } from 'node:test';
  2	import assert from 'node:assert/strict';
  3	import { slugify } from '../src/slug.ts';
  4	
  5	test('joins words with one dash', () => {
  6	  assert.equal(slugify('Hello World'), 'hello-world');
  7	  assert.equal(slugify('  Hello   World  '), 'hello-world');
  8	  assert.equal(slugify('Rock & Roll!'), 'rock-roll');
  9	});
  ```

**Geno:** The bug is clear: `.replace(/ /g, '-')` replaces each single space individually, so consecutive spaces become multiple hyphens, and when you remove symbols like `&` or `!`, the spaces get left behind. Let's run the tests first to see what the actual failures look like.

- `bash` `{"command":"node --test test/slug.test.ts 2>&1 | tail -20","description":"Run the slugify test to confirm failure"}` -> **ok**

  ```
    name: 'AssertionError'
    expected: 'hello-world'
    actual: 'hello---world'
    operator: 'strictEqual'
    stack: |-
      TestContext.<anonymous> (file:///Users/me/Development/g-code/.claude/worktrees/agent-a9d5362ddfbbd2023/scratchpad/real-usecases/ws/A02-thai-fix-r1/repo/test/slug.test.ts:7:10)
      Test.runInAsyncScope (node:async_hooks:214:14)
      Test.run (node:internal/test_runner/test:1047:25)
      Test.start (node:internal/test_runner/test:944:17)
      startSubtestAfterBootstrap (node:internal/test_runner/harness:296:17)
    ...
  1..1
  # tests 1
  # suites 0
  # pass 0
  # fail 1
  # cancelled 0
  … (59 more characters in session.jsonl)
  ```

**Geno:** ตรงคาด แก้ให้ collapses ช่องว่างหลายตัวเป็นขีดเดียว และจัด trim ใหม่อีกทีครับ

- `edit` `{"path":"src/slug.ts","old_str":"  return title.trim().toLowerCase().replace(/[^a-z0-9 ]/g, '').replace(/ /g, '-');","new_str":"  return title\n    .toLowerCase()\n    .replace(/[^a-z0-9 ]+/g, ' ')\n    .trim()\n    .replace(/ +/g, '-');"}` -> **ok**

  ```
  Edited src/slug.ts. The file state is current in your context; no need to read it back.
  
  check `node --test` failed (exit 1)
    location: '/Users/me/Development/g-code/.claude/worktrees/agent-a9d5362ddfbbd2023/scratchpad/real-usecases/ws/A02-thai-fix-r1/repo/test/money.test.ts:5:1'
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
      TestContext.<anonymous> (file:///Users/me/Developm
  … (683 more characters in session.jsonl)
  ```

- `bash` `{"command":"node --test test/slug.test.ts 2>&1 | tail -8 && git stash -q && node --test test/money.test.ts 2>&1 | grep -E '^# (pass|fail)'; git stash pop -q","description":"Run slug test; confirm money failure predates my change"}` -> **ok**

  ```
  # tests 1
  # suites 0
  # pass 1
  # fail 0
  # cancelled 0
  # skipped 0
  # todo 0
  # duration_ms 74.057083
  # pass 1
  # fail 1
  [exit code 0]
  ```

**Geno:** แก้เสร็จแล้ว — เทส slugify ผ่าน

**สิ่งที่แก้** (`src/slug.ts:3`): ตัวเดิมใช้ `.replace(/ /g, '-')` ซึ่งแปลงช่องว่างทีละตัว ทำให้ `'  Hello   World  '` ได้ `hello---world` (ช่องซ้ำกลายเป็นขีดซ้ำ) และ `'Rock & Roll!'` ได้ `rock--roll-` (ลบ `&` `!` แล้วช่องว่างที่เหลือไม่ถูกยุบ) โค้ดใหม่:

```ts
return title
  .toLowerCase()
  .replace(/[^a-z0-9 ]+/g, ' ')  // ยุบอักขระที่ไม่ใช้ทุกชนิดรวมกัน เป็นช่องเดียว
  .trim()
  .replace(/ +/g, '-');          // ยุบช่องว่างติดกันเป็นขีดเดียว
```

**หมายเหตุ:** `test/money.test.ts` ยังพังอยู่ 1 เคส (`formatMoney` คืน `$12.5` แทน `$12.50`) — ผมเช็คด้วย git stash แล้วว่าพังมาก่อนที่ผมแตะโค้ด ไม่ได้แก้ให้เพราะอยู่นอกขอบเขตที่สั่ง ถ้าต้องการให้แก้ด้วยบอกได้ครับ
