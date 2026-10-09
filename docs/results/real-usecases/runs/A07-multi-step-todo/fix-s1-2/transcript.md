# A07-multi-step-todo, run fix-s1-2

Mode: non-interactive. Fixture: `monorepo`. Model: qwen3.8-flash.

## User

Rename getUser to fetchUser everywhere in the monorepo (core, api, web and their tests), make sure all tests still pass, and add a line about the rename under Unreleased in CHANGELOG.md.

**Geno:** I'll start by finding all occurrences of `getUser` in the repo.

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

**Geno:** Seven occurrences across five files. Let me read them all.

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

- `read` `{"path":"packages/core/test/user.test.js"}` -> **ok**

  ```
  1	import { test } from 'node:test';
  2	import assert from 'node:assert/strict';
  3	import { getUser } from '../src/user.js';
  4	test('finds a user', () => assert.equal(getUser(1).name, 'Ada'));
  5	test('misses a user', () => assert.equal(getUser(9), null));
  ```

- `read` `{"path":"packages/web/src/profile.js"}` -> **ok**

  ```
  1	import { getUser } from '../../core/src/user.js';
  2	
  3	export const profileTitle = (id) => `Profile of ${getUser(id)?.name ?? 'nobody'}`;
  ```

- `read` `{"path":"CHANGELOG.md"}` -> **ok**

  ```
  1	# Changelog
  2	
  3	## Unreleased
  ```

- `glob` `{"pattern":"packages/**/*"}` -> **ok**

  ```
  packages/api/src/routes.js
  packages/api/test/routes.test.js
  packages/core/src/user.js
  packages/core/test/user.test.js
  packages/web/src/profile.js
  packages/web/test/profile.test.js
  ```

- `grep` `{"pattern":"getUser|get_user|GetUser","ignore_case":true,"glob":"!packages/**/*.js"}` -> **ok**

  ```
  no matches
  ```

- `glob` `{"pattern":"packages/*/test/*.js"}` -> **ok**

  ```
  packages/api/test/routes.test.js
  packages/core/test/user.test.js
  packages/web/test/profile.test.js
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

- `edit` `{"path":"packages/core/src/user.js","old_str":"export function getUser(id) {","new_str":"export function fetchUser(id) {"}` -> **ok**

  ```
  Edited packages/core/src/user.js. The file state is current in your context; no need to read it back.
  ```

- `edit` `{"path":"packages/api/src/routes.js","old_str":"import { getUser } from '../../core/src/user.js';\n\nexport function userRoute(params) {\n  const user = getUser(Number(params.id));","new_str":"import { fetchUser } from '../../core/src/user.js';\n\nexport function userRoute(params) {\n  const user = 
… (31 more characters in session.jsonl)` -> **ok**

  ```
  Edited packages/api/src/routes.js. The file state is current in your context; no need to read it back.
  ```

- `edit` `{"path":"packages/core/test/user.test.js","old_str":"import { getUser } from '../src/user.js';\ntest('finds a user', () => assert.equal(getUser(1).name, 'Ada'));\ntest('misses a user', () => assert.equal(getUser(9), null));","new_str":"import { fetchUser } from '../src/user.js';\ntest('finds a user'
… (114 more characters in session.jsonl)` -> **ok**

  ```
  Edited packages/core/test/user.test.js. The file state is current in your context; no need to read it back.
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

- `edit` `{"path":"CHANGELOG.md","old_str":"## Unreleased","new_str":"## Unreleased\n\n- Renamed 'getUser' to 'fetchUser' across core, api and web."}` -> **ok**

  ```
  Edited CHANGELOG.md. The file state is current in your context; no need to read it back.
  ```

- `bash` `{"command":"node --test 2>&1 | tail -20","description":"Run the monorepo tests"}` -> **ok**

  ```
  ok 3 - misses a user
    ---
    duration_ms: 0.051375
    type: 'test'
    ...
  # Subtest: titles a profile
  ok 4 - titles a profile
    ---
    duration_ms: 0.292
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
  # duration_ms 47.229792
  [exit code 0]
  ```

**Geno:** Done. Renamed `getUser` to `fetchUser` in all four places it appeared:

- `packages/core/src/user.js:3` — the function definition
- `packages/api/src/routes.js:1,4` — import and call site
- `packages/web/src/profile.js:1,3` — import and call site
- `packages/core/test/user.test.js:3-5` — import and both test assertions

The api and web tests (`routes.test.js`, `profile.test.js`) only exercise `userRoute` and `profileTitle`, so they needed no changes. A case-insensitive search for `getUser`/`get_user`/`GetUser` outside the source files found nothing, including in README and tsconfig.

Added under Unreleased in `CHANGELOG.md`: "Renamed `getUser` to `fetchUser` across core, api and web."

All 4 tests pass (`node --test`: 4 pass, 0 fail).
