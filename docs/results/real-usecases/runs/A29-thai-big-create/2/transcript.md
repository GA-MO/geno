# A29-thai-big-create, run 2

Mode: non-interactive. Fixture: `game`. Model: qwen3.8-flash.

## User

สร้างไฟล์ src/scenes/PacmanScene.js ใหม่ทั้งไฟล์ในครั้งเดียว: ฉาก Phaser ของ Pac-Man แบบต้นฉบับ มีแผนที่ 28x31 แบบเกมจริงฝังอยู่ในไฟล์ (เป็น array ของ string ครบทุกแถว), ผีครบ 4 ตัวพร้อมโหมด scatter/chase/frightened, ระบบชีวิต, คะแนน และ power pellet แล้วเพิ่มฉากนี้ใน src/main.js

**Geno:** I'll look at the repo structure first, then write the scene and wire it into main.js.

- `list` `{"directory":"."}` -> **ok**

  ```
  .gitignore
  README.md
  index.html
  package.json
  server.js
  src/
  src/logic/ (1 file)
  src/main.js
  src/scenes/ (1 file)
  test/
  test/score.test.js
  ```

- `glob` `{"pattern":"src/**/*"}` -> **ok**

  ```
  src/logic/score.js
  src/main.js
  src/scenes/GameScene.js
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
