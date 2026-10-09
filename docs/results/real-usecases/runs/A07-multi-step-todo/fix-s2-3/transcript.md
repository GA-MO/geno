# A07-multi-step-todo, run fix-s2-3

Mode: non-interactive. Fixture: `monorepo`. Model: qwen3.8-flash.

## User

Rename getUser to fetchUser everywhere in the monorepo (core, api, web and their tests), make sure all tests still pass, and add a line about the rename under Unreleased in CHANGELOG.md.

**Geno:** I'll start by mapping the repo and finding all `getUser` occurrences.

- `list` `{"directory":"","depth":3}` -> **ok**

  ```
  .gitignore
  CHANGELOG.md
  README.md
  package.json
  packages/
  packages/api/
  packages/api/src/ (1 file)
  packages/api/test/ (1 file)
  packages/core/
  packages/core/src/ (1 file)
  packages/core/test/ (1 file)
  packages/web/
  packages/web/src/ (1 file)
  packages/web/test/ (1 file)
  tsconfig.json
  ```

- `grep` `{"pattern":"getUser"}` -> **ok**

  ```
  packages/api/src/routes.js:1:import { getUser } from '../../core/src/user.js';
  packages/api/src/routes.js:4:  const user = getUser(Number(params.id));
  packages/core/src/user.js:3:export function getUser(id) {
  packages/core/test/user.test.js:3:import { getUser } from '../src/user.js';
  packages/core/test/user.test.js:4:test('finds a user', () => assert.equal(getUser(1).name, 'Ada'));
  packages/core/test/user.test.js:5:test('misses a user', () => assert.equal(getUser(9), null));
  packages/web/src/profile.js:1:import { getUser } from '../../core/src/user.js';
  packages/web/src/profile.js:3:export con
  … (72 more characters in session.jsonl)
  ```

**Geno:** Small set of files. Reading them all before editing.

- `read` `{"path":"packages/core/src/user.js"}` -> **ok**

  ```
  1	const USERS = new Map([[1, { id: 1, name: 'Ada' }], [2, { id: 2, name: 'Grace' }]]);
  2	
  3	export function getUser(id) {
  4	  return USERS.get(id) ?? null;
  5	}
  6	
  7	export function listUsers() {
  8	  return [...USERS.values()];
  9	}
  ```

- `read` `{"path":"packages/api/src/routes.js"}` -> **ok**

  ```
  1	import { getUser } from '../../core/src/user.js';
  2	
  3	export function userRoute(params) {
  4	  const user = getUser(Number(params.id));
  5	  return user ? { status: 200, body: user } : { status: 404, body: { error: 'not found' } };
  6	}
  ```

- `read` `{"path":"packages/web/src/profile.js"}` -> **ok**

  ```
  1	import { getUser } from '../../core/src/user.js';
  2	
  3	export const profileTitle = (id) => `Profile of ${getUser(id)?.name ?? 'nobody'}`;
  ```

- `read` `{"path":"packages/core/test/user.test.js"}` -> **ok**

  ```
  1	import { test } from 'node:test';
  2	import assert from 'node:assert/strict';
  3	import { getUser } from '../src/user.js';
  4	test('finds a user', () => assert.equal(getUser(1).name, 'Ada'));
  5	test('misses a user', () => assert.equal(getUser(9), null));
  ```

- `read` `{"path":"CHANGELOG.md"}` -> **ok**

  ```
  1	# Changelog
  2	
  3	## Unreleased
  ```

- `grep` `{"pattern":"getUser","glob":"*.md"}` -> **ok**

  ```
  no matches
  ```

**Geno:** Now the rename across the four files.

- `edit` `{"path":"packages/core/src/user.js","old_str":"export function getUser(id) {","new_str":"export function fetchUser(id) {"}` -> **ok**

  ```
  Edited packages/core/src/user.js. The file state is current in your context; no need to read it back.
  ```

- `edit` `{"path":"packages/api/src/routes.js","old_str":"import { getUser } from '../../core/src/user.js';\n\nexport function userRoute(params) {\n  const user = getUser(Number(params.id));","new_str":"import { fetchUser } from '../../core/src/user.js';\n\nexport function userRoute(params) {\n  const user = 
… (31 more characters in session.jsonl)` -> **ok**

  ```
  Edited packages/api/src/routes.js. The file state is current in your context; no need to read it back.
  ```

- `edit` `{"path":"packages/web/src/profile.js","old_str":"import { getUser } from '../../core/src/user.js';\n\nexport const profileTitle = (id) => 'Profile of ${getUser(id)?.name ?? 'nobody'}';","new_str":"import { fetchUser } from '../../core/src/user.js';\n\nexport const profileTitle = (id) => 'Profile of 
… (38 more characters in session.jsonl)` -> **ok**

  ```
  Edited packages/web/src/profile.js. The file state is current in your context; no need to read it back.
  ```

- `edit` `{"path":"packages/core/test/user.test.js","old_str":"import { getUser } from '../src/user.js';\ntest('finds a user', () => assert.equal(getUser(1).name, 'Ada'));\ntest('misses a user', () => assert.equal(getUser(9), null));","new_str":"import { fetchUser } from '../src/user.js';\ntest('finds a user'
… (114 more characters in session.jsonl)` -> **ok**

  ```
  Edited packages/core/test/user.test.js. The file state is current in your context; no need to read it back.
  ```

- `edit` `{"new_str":"## Unreleased\n- Renamed 'getUser' to 'fetchUser' across core, api and web.","old_str":"## Unreleased","path":"CHANGELOG.md"}` -> **ok**

  ```
  Edited CHANGELOG.md. The file state is current in your context; no need to read it back.
  ```

- `grep` `{"pattern":"getUser"}` -> **ok**

  ```
  CHANGELOG.md:4:- Renamed `getUser` to `fetchUser` across core, api and web.
  ```

**Geno:** The only remaining `getUser` mention is the CHANGELOG entry itself. Running the tests.

- `check` `{}` -> **ok**

  ```
  This workspace has no check command. Run its tests or type checker with bash instead.
  ```

- `bash` `{"command":"npm test 2>&1","description":"Run the monorepo tests"}` -> **ok**

  ```
  
  > test
  > node --test
  
  TAP version 13
  # Subtest: 404s a missing user
  ok 1 - 404s a missing user
    ---
    duration_ms: 0.276292
    type: 'test'
    ...
  # Subtest: finds a user
  ok 2 - finds a user
    ---
    duration_ms: 0.33325
    type: 'test'
    ...
  # Subtest: misses a user
  ok 3 - misses a user
    ---
    duration_ms: 0.052041
    type: 'test'
    ...
  # Subtest: titles a profile
  ok 4 - titles a profile
    ---
    duration_ms: 0.264459
    type: 'test'
    ...
  1..4
  # tests 4
  # suites 0
  # pass 4
  # fail 0
  # cancelled 0
  # skipped 0
  # todo 0
  # duration_ms 40.8815
  [exit code 0]
  ```

**Geno:** Done. Renamed `getUser` to `fetchUser` in all five source locations:

- `packages/core/src/user.js:3` — the definition
- `packages/api/src/routes.js:1,4` — import and call
- `packages/web/src/profile.js:1,3` — import and call
- `packages/core/test/user.test.js:3-5` — import and both test calls

The api and web tests (`packages/api/test`, `packages/web/test`) only exercise `userRoute`/`profileTitle` and never named `getUser`, so they needed no changes — a repo-wide grep confirms the only remaining mention of the old name is the CHANGELOG entry itself.

Added under Unreleased in `CHANGELOG.md`: "Renamed `getUser` to `fetchUser` across core, api and web."

All 4 tests pass with `npm test` (`node --test`): 4 passed, 0 failed.
