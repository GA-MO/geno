# @g-code/docs

เว็บ "Geno ทำงานอย่างไร" สร้างด้วย Astro กับ Fumadocs ทุกหน้าอยู่ใน `src/content/docs` รายละเอียดของ data shape,
story layer, payload card, motion และ check ทั้งหมดอยู่ใน [DESIGN-story.md](DESIGN-story.md)

## รัน dev server

รันจาก root ของ repo:

```sh
env -u ELECTRON_RUN_AS_NODE pnpm --filter @g-code/docs dev --port 4347
```

เปิด `http://localhost:4347` แล้วหยุด server ด้วย `pnpm exec astro dev stop` ใน `packages/docs`
ถ้าจะ build ทั้งเว็บ ใช้ `pnpm docs:build`

## เขียนหน้าใหม่

1. สร้างไฟล์ `.md` หรือ `.mdx` ในโฟลเดอร์ของหมวด เช่น `src/content/docs/concepts/`
2. ใส่ frontmatter ได้แค่ `title`, `description`, `full`, `scenario` และ `payloads`
   key อื่น เช่น `sidebar` ของ Starlight ทำให้ build และ `docs:check` ล้ม
3. รัน `pnpm --filter @g-code/docs meta` หน้าใหม่จะต่อท้ายใน `meta.json` ของโฟลเดอร์
   ถ้าอยากให้อยู่ตำแหน่งอื่น ย้ายชื่อหน้าใน `meta.json` เอง
4. เขียน Thai และใช้คำ English เฉพาะคำที่ developer ไทยพูดเป็น English อยู่แล้ว เช่น model, tool call, session

## เพิ่มทัวร์

ทัวร์คือหน้าที่มี `scenario:` ใน frontmatter อยู่ใน `src/content/docs/scenarios/<หมวด>/`

1. เลือก id จาก `src/data/catalog.yaml` ที่ยังไม่มีหน้า แล้วใส่ใน `covers`
2. เขียน `steps` ทีละขั้น แต่ละขั้นมี `lane`, `do` และ `ref` ที่ชี้ไปยังโค้ดจริง (`path#Symbol`)
   ขั้นที่หลายหน้าใช้ร่วมกันอยู่ใน `src/data/fragments/` เรียกด้วย `use:`
3. ใส่ `beat:` ที่ขั้นแรก ที่ขั้นแรกของทุกทางแยก และทุกจุดที่ผู้อ่านจะพูดว่า "แล้วไงต่อ"
   ทุก beat ต้องมี `title`, `text`, `from` และ `to`
4. ลูกศรของ beat ต้องเป็นคู่ actor ที่ `links:` ใน `src/data/lanes.yaml` อนุญาต
   คำตอบของ model ไปที่ engine เสมอ (`model` → `engine`) แล้ว engine จึงแสดงที่แผง (`engine` → `panel`)
5. ใส่ `sees:` ตรงที่หน้าจอของผู้ใช้เปลี่ยน ใช้ mock ที่ตรงกับ UI จริง หรือ `kind: payload` ที่ชี้ไปยังข้อมูลจากการรันจริง

ดูตัวอย่างครบทุกส่วนได้ที่ `src/content/docs/scenarios/perm/ask-mode-bash-approval.md`

## บันทึก flow ใหม่

ถ้าไม่มีการรันจริงที่แสดงช่วงที่ต้องการ ให้เขียน flow ในไฟล์ `packages/engine/test/docs-record/flows-<ชื่อ>.ts` ที่ import จาก `kit.ts` เท่านั้น แล้วเพิ่มไฟล์นั้นในรายการ `FLOWS` ของ `flows.ts`
flow ใช้ engine จริงกับ model จำลองที่ตอบตาม script แล้วรัน:

```sh
pnpm docs:record <ชื่อ flow>
```

ไม่ใส่ชื่อ flow จะบันทึกทุก flow ผลอยู่ที่ `src/data/recorded/<flow>.jsonl` แล้วหน้าชี้ไปที่บรรทัดด้วย `#line=N`
รันซ้ำได้ไบต์เดิมทุกครั้ง ยกเว้น commit ของ engine หลังบันทึกใหม่ให้รัน `pnpm docs:check` เพราะเลขบรรทัดอาจเลื่อน

## Check ก่อน commit

รันจาก root ของ repo check ที่เปิด browser ต้องมี dev server รันอยู่

| command | ใช้เมื่อ |
| --- | --- |
| `pnpm docs:check` | ทุกครั้ง |
| `pnpm vitest run packages/docs scripts` | ทุกครั้ง |
| `pnpm --filter @g-code/docs walk <url> <page> ...` | แก้ทัวร์ ใส่ path ของแต่ละหน้าแยกกัน เช่น `/scenarios/bg/watch-pr/` |
| `pnpm --filter @g-code/docs cards <url>` | แก้ payload card หรือ `src/scenario/payload.ts` |
| `pnpm --filter @g-code/docs motion <url>` | แก้ `Story.tsx`, `motion.ts` หรือ `docs.css` |
| `pnpm typecheck` และ `pnpm docs:build` | ก่อน push |
