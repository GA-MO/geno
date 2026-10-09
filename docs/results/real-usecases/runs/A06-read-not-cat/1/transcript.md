# A06-read-not-cat, run 1

Mode: non-interactive. Fixture: `ts-lib`. Model: qwen3.8-flash.

## User

Show me what the package.json scripts are, list the files under src, and tell me which test files exist.

**Geno:** I'll look at package.json, the src tree, and the test files.

- `read` `{"path":"package.json"}` -> **ok**

  ```
  1	{
  2	  "name": "tiny-money",
  3	  "version": "0.3.1",
  4	  "type": "module",
  5	  "private": true,
  6	  "scripts": {
  7	    "test": "node --test"
  8	  }
  9	}
  ```

- `list` `{"directory":"src","depth":3}` -> **ok**

  ```
  src/config.ts
  src/duration.ts
  src/index.ts
  src/money.ts
  src/slug.ts
  ```

- `glob` `{"pattern":"**/*test*"}` -> **ok**

  ```
  test/duration.test.ts
  test/money.test.ts
  test/slug.test.ts
  ```

**Geno:** Here's what's in the repo:

**package.json scripts** (`package.json:6-8`) — just one:
- `test`: `node --test`

**Files under `src/`** — five TypeScript modules:
- `src/config.ts`
- `src/duration.ts`
- `src/index.ts`
- `src/money.ts`
- `src/slug.ts`

**Test files** — three, all in `test/` (not `src/`), matching the `node --test` default lookup:
- `test/duration.test.ts`
- `test/money.test.ts`
- `test/slug.test.ts`

Note there's no test file covering `src/config.ts` or `src/index.ts`.
