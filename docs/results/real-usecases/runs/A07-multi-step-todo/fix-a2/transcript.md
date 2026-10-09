# A07-multi-step-todo, run fix-a2

Mode: non-interactive. Fixture: `monorepo`. Model: qwen3.8-flash.

## User

Rename getUser to fetchUser everywhere in the monorepo (core, api, web and their tests), make sure all tests still pass, and add a line about the rename under Unreleased in CHANGELOG.md.

**Geno:** I'll start by looking at the repo structure and finding all occurrences of `getUser`.

- `list` `{"directory":""}` -> **ok**

  ```
  .gitignore
  CHANGELOG.md
  README.md
  package.json
  packages/
  packages/api/ (2 files)
  packages/core/ (2 files)
  packages/web/ (2 files)
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

**Geno:** Small monorepo. Let me read the relevant files.

- `bash` `{"command":"find packages -type f | sort","description":"List all files in packages"}` -> **ok**

  ```
  packages/api/src/routes.js
  packages/api/test/routes.test.js
  packages/core/src/user.js
  packages/core/test/user.test.js
  packages/web/src/profile.js
  packages/web/test/profile.test.js
  [exit code 0]
  ```

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

- `read` `{"path":"packages/api/test/routes.test.js"}` -> **ok**

  ```
  1	import { test } from 'node:test';
  2	import assert from 'node:assert/strict';
  3	import { userRoute } from '../src/routes.js';
  4	test('404s a missing user', () => assert.equal(userRoute({ id: '7' }).status, 404));
  ```

- `read` `{"path":"packages/web/test/profile.test.js"}` -> **ok**

  ```
  1	import { test } from 'node:test';
  2	import assert from 'node:assert/strict';
  3	import { profileTitle } from '../src/profile.js';
  4	test('titles a profile', () => assert.equal(profileTitle(2), 'Profile of Grace'));
  ```

- `read` `{"path":"CHANGELOG.md"}` -> **ok**

  ```
  1	# Changelog
  2	
  3	## Unreleased
  ```

**Geno:** The rename touches four files: `packages/core/src/user.js`, its test, `packages/api/src/routes.js`, and `packages/web/src/profile.js`. Applying it now.

- `edit` `{"path":"packages/core/src/user.js","old_str":"export function getUser(id) {","new_str":"export function fetchUser(id) {"}` -> **ok**

  ```
  Edited packages/core/src/user.js. The file state is current in your context; no need to read it back.
  ```

- `edit` `{"path":"packages/core/test/user.test.js","old_str":"import { getUser } from '../src/user.js';\ntest('finds a user', () => assert.equal(getUser(1).name, 'Ada'));\ntest('misses a user', () => assert.equal(getUser(9), null));","new_str":"import { fetchUser } from '../src/user.js';\ntest('finds a user'
… (114 more characters in session.jsonl)` -> **ok**

  ```
  Edited packages/core/test/user.test.js. The file state is current in your context; no need to read it back.
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

- `grep` `{"pattern":"getUser"}` -> **ok**

  ```
  no matches
  ```

- `bash` `{"command":"npm test 2>&1","description":"Run the test suite"}` -> **ok**

  ```
  
  > test
  > node --test
  
  TAP version 13
  # Subtest: 404s a missing user
  ok 1 - 404s a missing user
    ---
    duration_ms: 0.476625
    type: 'test'
    ...
  # Subtest: finds a user
  ok 2 - finds a user
    ---
    duration_ms: 0.6495
    type: 'test'
    ...
  # Subtest: misses a user
  ok 3 - misses a user
    ---
    duration_ms: 0.089959
    type: 'test'
    ...
  # Subtest: titles a profile
  ok 4 - titles a profile
    ---
    duration_ms: 0.47275
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
  # duration_ms 89.068375
  [exit code 0]
  ```

**Geno:** All `getUser` references are gone and the 4 tests pass. Adding the changelog line.

- `edit` `{"new_str":"## Unreleased\n- Rename 'getUser' to 'fetchUser' across core, api and web.","old_str":"## Unreleased","path":"CHANGELOG.md"}` -> **ok**

  ```
  Edited CHANGELOG.md. The file state is current in your context; no need to read it back.
  ```

**Geno:** Done. Renamed `getUser` to `fetchUser` everywhere:

- `packages/core/src/user.js:3` — the definition
- `packages/api/src/routes.js:1,4` — import and call site
- `packages/web/src/profile.js:1,3` — import and call site
- `packages/core/test/user.test.js:3-5` — import and both assertions

The api and web tests only exercise `userRoute`/`profileTitle`, so they needed no changes. Verified with a repo-wide grep (no `getUser` matches remain) and `npm test` — all 4 tests pass. Added under Unreleased in `CHANGELOG.md:4`: "Rename `getUser` to `fetchUser` across core, api and web."
