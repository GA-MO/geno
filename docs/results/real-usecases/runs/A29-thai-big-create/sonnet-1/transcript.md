# A29-thai-big-create, run sonnet-1

Mode: non-interactive. Fixture: `game`. Model: claude-sonnet-5-5.

## User

สร้างไฟล์ src/scenes/PacmanScene.js ใหม่ทั้งไฟล์ในครั้งเดียว: ฉาก Phaser ของ Pac-Man แบบต้นฉบับ มีแผนที่ 28x31 แบบเกมจริงฝังอยู่ในไฟล์ (เป็น array ของ string ครบทุกแถว), ผีครบ 4 ตัวพร้อมโหมด scatter/chase/frightened, ระบบชีวิต, คะแนน และ power pellet แล้วเพิ่มฉากนี้ใน src/main.js

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

- `read` `{"path":"src/main.js"}` -> **ok**

  ```
  1	import { GameScene } from './scenes/GameScene.js';
  2	
  3	new Phaser.Game({
  4	  type: Phaser.AUTO,
  5	  width: 800,
  6	  height: 600,
  7	  physics: { default: 'arcade', arcade: { debug: false } },
  8	  scene: [GameScene],
  9	});
  ```

- `read` `{"path":"src/scenes/GameScene.js"}` -> **ok**

  ```
   1	import { createState, collectCoin } from '../logic/score.js';
   2	
   3	export class GameScene extends Phaser.Scene {
   4	  constructor() {
   5	    super('game');
   6	    this.state = createState();
   7	  }
   8	
   9	  create() {
  10	    this.player = this.add.rectangle(400, 300, 24, 24, 0xffcc00);
  11	    this.physics.add.existing(this.player);
  12	    this.coins = this.physics.add.group();
  13	    for (let i = 0; i < 8; i++) this.coins.add(this.add.circle(80 + i * 90, 120, 8, 0xffffff));
  14	    this.physics.add.overlap(this.player, this.coins, (_player, coin) => {
  15	      coin.destroy();
  16	      this
  … (490 more characters in session.jsonl)
  ```

- `read` `{"path":"src/logic/score.js"}` -> **ok**

  ```
  1	export const createState = () => ({ coins: 0, score: 0 });
  2	
  3	export function collectCoin(state) {
  4	  return { ...state, coins: state.coins + 1 };
  5	}
  ```

- `read` `{"path":"index.html"}` -> **ok**

  ```
  1	<!doctype html>
  2	<html>
  3	<head><meta charset="utf-8"><title>Coin Dash</title></head>
  4	<body>
  5	<script src="https://cdn.jsdelivr.net/npm/phaser@3.80.1/dist/phaser.min.js"></script>
  6	<script type="module" src="./src/main.js"></script>
  7	</body>
  8	</html>
  ```

- `edit` `{"path":"src/scenes/PacmanScene.js","create":true,"new_str":"// Tile legend: '#' wall, '.' dot, 'o' power pellet, '-' ghost-house door, ' ' empty floor.\nexport const MAP = [\n  '############################',\n  '#............##............#',\n  '#.####.#####.##.#####.####.#',\n  '#o####.#####.##.
… (15409 more characters in session.jsonl)` -> **ok**

  ```
  Created src/scenes/PacmanScene.js. The file state is current in your context; no need to read it back.
  ```

- `edit` `{"path":"src/main.js","old_str":"import { GameScene } from './scenes/GameScene.js';","new_str":"import { GameScene } from './scenes/GameScene.js';\nimport { PacmanScene } from './scenes/PacmanScene.js';"}` -> **ok**

  ```
  Edited src/main.js. The file state is current in your context; no need to read it back.
  ```

- `edit` `{"path":"src/main.js","old_str":"[GameScene]","new_str":"[PacmanScene, GameScene]"}` -> **ok**

  ```
  Edited src/main.js. The file state is current in your context; no need to read it back.
  ```

- `bash` `{"command":"cat > $TMPDIR/v.mjs <<'E'\nglobalThis.Phaser={Scene:class{}};\nconst m=await import(process.cwd()+'/src/scenes/PacmanScene.js');\nconsole.log(m.MAP.length,m.MAP.every(r=>r.length===28));\nE\nnode $TMPDIR/v.mjs; node --test 2>&1 | tail -5"}` -> **ok**

  ```
  31 true
  # fail 0
  # cancelled 0
  # skipped 0
  # todo 0
  # duration_ms 41.959584
  [exit code 0]
  ```

**Geno:** Remove the duplicate eat call.

- `edit` `{"path":"src/scenes/PacmanScene.js","old_str":"    this.movePac(dt);\n    this.eatAtPac();\n    this.releaseGhosts","new_str":"    this.movePac(dt);\n    this.releaseGhosts"}` -> **ok**

  ```
  Edited src/scenes/PacmanScene.js. The file state is current in your context; no need to read it back.
  ```

**Geno:** I created `src/scenes/PacmanScene.js` in one go and registered it in `src/main.js`. I have not run the game in a browser, so none of the gameplay has been tested.

What I did check: the module loads under Node with a stub `Phaser`, the map is 31 rows × 28 columns, and `node --test` still passes. The existing test only covers `score.js`, so it says nothing about the new scene.

**What's in the scene**
- **Map:** the full 28×31 map is embedded as a `MAP` array of strings. It includes the ghost house with its door and the side tunnel on row 14.
- **Ghosts:** all four, with the original-style targets. Blinky chases directly, Pinky aims 4 tiles ahead, Inky uses a vector from Blinky, and Clyde goes to his corner when within 8 tiles. The three in the house are released after 2, 6 and 10 seconds.
- **Modes:** scatter and chase follow the usual schedule (7/20/7/20/5/20/5, then chase for good), and ghosts reverse direction on each switch. Frightened mode lasts 6 seconds with flashing at the end and pauses the mode clock. An eaten ghost runs back to the house as eyes and comes out again.
- **Lives and score:** 3 lives. Dots are 10 points and power pellets 50. Ghosts score 200, 400, 800, then 1600 in a row. There is a death animation, a game-over screen and a win screen, and SPACE restarts from either.
- **Controls:** arrow keys. You can reverse mid-tile, and a turn is buffered until the next tile where it is possible.

**Things to know**
- I put `PacmanScene` first in the scene array in `src/main.js`, because Phaser starts only the first scene and it would otherwise never show. `GameScene` is still registered but no longer starts automatically. Swap the order if you want the old scene to stay the default.
- The scene doesn't use `score.js`. Its score and lives live in the scene itself.
- I left out ghost slowdown in the tunnel, the original's no-upward-turn zones, and per-level speed increases.
- Speeds, timers and the ghost-AI details are my approximation of the original. I tuned them by reading the code, not by playing it.
