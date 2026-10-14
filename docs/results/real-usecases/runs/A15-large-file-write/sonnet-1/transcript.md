# A15-large-file-write, run sonnet-1

Mode: non-interactive. Fixture: `game`. Model: claude-sonnet-5-5.

## User

Create src/logic/levels.js exporting LEVELS: an array of 12 Pac-Man style mazes. Each level is { id, name, speed, maze } where maze is an array of 31 strings of exactly 28 characters using # for walls, . for dots, o for power pellets and space for empty. Write the whole file in one go, then add a test that checks every maze is 31x28.

- `list` `{"depth":3}` -> **ok**

  ```
  .gitignore
  README.md
  index.html
  package.json
  server.js
  src/
  src/logic/
  src/logic/score.js
  src/main.js
  src/scenes/
  src/scenes/GameScene.js
  test/
  test/score.test.js
  ```

- `read` `{"path":"src/logic/score.js"}` -> **ok**

  ```
  1	export const createState = () => ({ coins: 0, score: 0 });
  2	
  3	export function collectCoin(state) {
  4	  return { ...state, coins: state.coins + 1 };
  5	}
  ```

- `read` `{"path":"test/score.test.js"}` -> **ok**

  ```
  1	import { test } from 'node:test';
  2	import assert from 'node:assert/strict';
  3	import { collectCoin, createState } from '../src/logic/score.js';
  4	
  5	test('collecting a coin counts it', () => {
  6	  assert.equal(collectCoin(createState()).coins, 1);
  7	});
  ```

- `edit` `{"path":"src/logic/levels.js","create":true,"new_str":"// Each maze is 31 rows x 28 columns: '#' wall, '.' dot, 'o' power pellet, ' ' empty.\n// Mazes are vertically symmetric and assembled from shared rows so every row\n// stays exactly 28 characters wide; only the rows that differ per level vary.\
… (1483 more characters in session.jsonl)` -> **ok**

  ```
  Created src/logic/levels.js. The file state is current in your context; no need to read it back.
  ```

- `edit` `{"path":"test/levels.test.js","create":true,"new_str":"import { test } from 'node:test';\nimport assert from 'node:assert/strict';\nimport { LEVELS } from '../src/logic/levels.js';\n\ntest('there are 12 levels', () => {\n  assert.equal(LEVELS.length, 12);\n});\n\ntest('every maze is 31x28 and uses o
… (312 more characters in session.jsonl)` -> **ok**

  ```
  Created test/levels.test.js. The file state is current in your context; no need to read it back.
  ```

- `bash` `{"command":"npm test 2>&1 | tail -20"}` -> **ok**

  ```
  ok 2 - every maze is 31x28 and uses only valid tiles
    ---
    duration_ms: 2.0015
    type: 'test'
    ...
  # Subtest: collecting a coin counts it
  ok 3 - collecting a coin counts it
    ---
    duration_ms: 0.851875
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
  # duration_ms 122.882084
  [exit code 0]
  ```

**Geno:** I added `src/logic/levels.js`, which exports `LEVELS`, and `test/levels.test.js`. `npm test` passes all 3 tests, including the new ones.

- **Deviation from your spec:** I didn't write out 12 × 31 literal strings. I defined the 28-character rows once as constants and `buildMaze` assembles them into 31-row arrays. I did this to avoid width typos, and the test checks the result either way. If you want fully literal mazes, say so and I'll expand them.
- **Maze shape:** each maze is vertically symmetric, with a tunnel row at row 14 and again at row 16.
- **How the 12 levels differ:** 9 of them combine three open-lane rows with three middle-row layouts. The other 3 move the power pellets to the top row. Apart from those rows the mazes are identical, so the layouts are only mildly varied.
- **Placeholder values:** names are `Level N`, and speed is `1 + index * 0.1`. You didn't specify either, so change them if you have real values.
- **Tests:** they check that there are 12 levels, that each maze has 31 rows of exactly 28 characters, and that every tile is one of `# . o` or space.
- **Not checked:** I haven't checked that the mazes play well, for example that every dot is reachable.
