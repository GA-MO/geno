# A06-read-not-cat, run sonnet-1

Mode: non-interactive. Fixture: `ts-lib`. Model: claude-sonnet-5-5.

## User

Show me what the package.json scripts are, list the files under src, and tell me which test files exist.

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

- `list` `{"directory":"src","depth":5}` -> **ok**

  ```
  src/config.ts
  src/duration.ts
  src/index.ts
  src/money.ts
  src/slug.ts
  ```

- `glob` `{"pattern":"**/*.{test,spec}.*"}` -> **ok**

  ```
  test/duration.test.ts
  test/money.test.ts
  test/slug.test.ts
  ```

**Geno:** **package.json scripts** (`package.json:6-8`): there is one script, `test`, which runs `node --test`.

**Files under `src`:**
- `src/config.ts`
- `src/duration.ts`
- `src/index.ts`
- `src/money.ts`
- `src/slug.ts`

**Test files** (all in `test/`):
- `test/duration.test.ts`
- `test/money.test.ts`
- `test/slug.test.ts`

Nothing tests `src/config.ts` or `src/index.ts`. I only matched `*.test.*` and `*.spec.*` names, so a test file with a different name would not show up here.
