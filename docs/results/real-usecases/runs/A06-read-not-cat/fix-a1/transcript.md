# A06-read-not-cat, run fix-a1

Mode: non-interactive. Fixture: `ts-lib`. Model: qwen3.8-flash.

## User

Show me what the package.json scripts are, list the files under src, and tell me which test files exist.

**Geno:** I'll read the package.json and list the source tree.

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

**Geno:** The src listing shows no test files there, so I'll search the whole repo for test files.

- `glob` `{"pattern":"**/*.{test,spec}.*"}` -> **ok**

  ```
  test/duration.test.ts
  test/money.test.ts
  test/slug.test.ts
  ```

- `list` `{"depth":2}` -> **ok**

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

**Geno:** Here's the full picture:

**package.json scripts** — only one:
```json
"test": "node --test"
```
(package `tiny-money` v0.3.1, ESM, private; no dependencies or devDependencies declared.)

**Files under `src/`** — 5 TypeScript modules:
- `src/config.ts`
- `src/duration.ts`
- `src/index.ts`
- `src/money.ts`
- `src/slug.ts`

**Test files** — 3, in a top-level `test/` directory (none under `src/`):
- `test/duration.test.ts`
- `test/money.test.ts`
- `test/slug.test.ts`

One thing worth noting: `node --test` discovers tests under `test/`, but the files are `.ts` and package.json has no TypeScript loader or dev dependency. Running them needs Node's native type-stripping (Node 22.6+ with `--experimental-strip-types`, or Node 23+ where it's on by default), so plain `npm test` may fail depending on your Node version. There's also a `legacy/old-money.js` file that no test covers.
