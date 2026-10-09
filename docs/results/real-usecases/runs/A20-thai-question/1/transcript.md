# A20-thai-question, run 1

Mode: non-interactive. Fixture: `game`. Model: qwen3.8-flash.

## User

โปรเจกต์นี้คืออะไร ทำงานยังไง อธิบายสั้นๆ ไม่ต้องแก้โค้ด

**Geno:** ฉันจะดูไฟล์ในโปรเจกต์ก่อนตอบ

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

- `bash` `{"command":"wc -l package.json server.js 2>/dev/null; ls","description":"Check file sizes and list directory"}` -> **ok**

  ```
        10 package.json
        14 server.js
        24 total
  README.md
  index.html
  package.json
  server.js
  src
  test
  [exit code 0]
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

- `bash` `{"command":"ls src/logic src/scenes; cat README.md package.json","description":"List src subfolders and show README/package.json"}` -> **ok**

  ```
  src/logic:
  score.js
  
  src/scenes:
  GameScene.js
  # Coin Dash
  
  เกมเก็บเหรียญเล็กๆ ด้วย Phaser 3 (โหลดจาก CDN ใน index.html)
  
  - `npm run dev` เปิดเซิร์ฟเวอร์ที่ http://localhost:5173 (มี `/health`)
  - `npm test` รันเทสของ logic ใน `src/logic`
  {
    "name": "coin-dash",
    "version": "0.1.0",
    "type": "module",
    "private": true,
    "scripts": {
      "dev": "node server.js",
      "test": "node --test"
    }
  }
  [exit code 0]
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

**Geno:** **Coin Dash** — เกมเก็บเหรียญเล็กๆ บนเบราว์เซอร์ เขียนด้วย Phaser 3 โหลดจาก CDN ใน `index.html` ไม่ได้ติดตั้ง dependency อะไรเลย

ทำงานแบบนี้:

- `npm run dev` รัน `server.js` ซึ่งเป็น static file server ด้วย `node:http` อย่างเดียว (ฟังพอร์ต 5173 มี `/health` ตอบ JSON) แล้วเบราว์เซอร์โหลด `index.html` → `src/main.js` สร้าง `Phaser.Game` ขนาด 800×600 ใส่ scene เดียวคือ `GameScene`
- `src/scenes/GameScene.js` สร้างสี่เหลี่ยมสีเหลืองเป็นผู้เล่นกับเหรียญ 8 วง ใช้ arcade physics ตรวจ overlap เจอเหรียญก็ทำลายเหรียญและเรียก `collectCoin` อัปเดต state
- `src/logic/score.js` เป็น logic ล้วนๆ (no browser API) แยกออกมาเพื่อให้เทสได้ ด้วย `npm test` (`node --test` รัน `test/score.test.js`)

จุดสังเกต: ตอนนี้ score ยังไม่แสดงบนหน้าจอ — `GameScene.js` อัปเดต `this.state` แต่ไม่มี text object ที่ hiển thịคะแนนหรือจำนวนเหรียญที่เก็บได้ ถ้าอยากให้เห็นผลในเกมต้องเพิ่ม HUD อีกนิดหน่อย
