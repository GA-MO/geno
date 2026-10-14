# A20-thai-question, run sonnet-1

Mode: non-interactive. Fixture: `game`. Model: claude-sonnet-5-5.

## User

โปรเจกต์นี้คืออะไร ทำงานยังไง อธิบายสั้นๆ ไม่ต้องแก้โค้ด

- `list` `{"depth":2}` -> **ok**

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

- `read` `{"path":"package.json"}` -> **ok**

  ```
   1	{
   2	  "name": "coin-dash",
   3	  "version": "0.1.0",
   4	  "type": "module",
   5	  "private": true,
   6	  "scripts": {
   7	    "dev": "node server.js",
   8	    "test": "node --test"
   9	  }
  10	}
  ```

- `read` `{"path":"README.md"}` -> **ok**

  ```
  1	# Coin Dash
  2	
  3	เกมเก็บเหรียญเล็กๆ ด้วย Phaser 3 (โหลดจาก CDN ใน index.html)
  4	
  5	- `npm run dev` เปิดเซิร์ฟเวอร์ที่ http://localhost:5173 (มี `/health`)
  6	- `npm test` รันเทสของ logic ใน `src/logic`
  ```

- `read` `{"path":"server.js"}` -> **ok**

  ```
   1	import { createServer } from 'node:http';
   2	import { readFile } from 'node:fs/promises';
   3	
   4	const server = createServer(async (req, res) => {
   5	  if (req.url === '/health') return res.writeHead(200, { 'content-type': 'application/json' }).end('{"status":"ok","game":"coin-dash"}');
   6	  try {
   7	    res.end(await readFile(new URL('.' + (req.url === '/' ? '/index.html' : req.url), import.meta.url)));
   8	  } catch {
   9	    res.writeHead(404).end('not found');
  10	  }
  11	});
  12	
  13	console.log('warming up the asset cache...');
  14	setTimeout(() => server.listen(5173, () => console.log('list
  … (41 more characters in session.jsonl)
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

- `glob` `{"pattern":"src/**/*.js"}` -> **ok**

  ```
  src/logic/score.js
  src/main.js
  src/scenes/GameScene.js
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

**Geno:** Coin Dash เป็นเกมเก็บเหรียญเล็กๆ ที่เล่นในเบราว์เซอร์ สร้างด้วย Phaser 3 ซึ่งโหลดจาก CDN ใน `index.html`

**วิธีทำงาน**
- `server.js` เป็นเซิร์ฟเวอร์ Node ธรรมดา (`node:http`) ที่เสิร์ฟไฟล์ static จากโฟลเดอร์โปรเจกต์ และมี `/health` ที่ตอบ JSON
  - พอรัน `npm run dev` มันจะพิมพ์ "warming up…" แล้วรอ 3 วินาทีก่อนเริ่มฟังที่พอร์ต 5173 การรอนี้ไม่ได้ทำอะไรจริง
  - เซิร์ฟเวอร์ไม่ได้กันการอ่านไฟล์นอกโฟลเดอร์ เช่น path แบบ `..` ผมยังไม่ได้ทดสอบว่าถูกใช้ได้จริงไหม
- `src/main.js` สร้าง `Phaser.Game` ขนาด 800×600 ใช้ physics แบบ arcade และโหลดฉาก `GameScene`
- `src/scenes/GameScene.js` เป็นตัวเกม
  - ผู้เล่นเป็นสี่เหลี่ยมสีเหลืองกลางจอ เคลื่อนที่ด้วยปุ่มลูกศรที่ความเร็ว 200
  - เหรียญเป็นวงกลมสีขาว 8 เหรียญเรียงแถวบนจอ
  - เมื่อผู้เล่นชนเหรียญ เหรียญจะหายไปและเรียก `collectCoin`
- `src/logic/score.js` เป็น logic ล้วนที่ไม่พึ่ง Phaser มีแค่ `createState` และ `collectCoin` (บวก `coins` ทีละ 1) ฟิลด์ `score` มีอยู่แต่ยังไม่ถูกใช้
- `test/score.test.js` เป็นเทสของ logic รันด้วย `npm test` (`node --test`) ผมยังไม่ได้รันมัน

**สิ่งที่ยังไม่มี:** ยังไม่มี UI แสดงคะแนน ไม่มีเงื่อนไขชนะหรือแพ้ และไม่มีศัตรู
