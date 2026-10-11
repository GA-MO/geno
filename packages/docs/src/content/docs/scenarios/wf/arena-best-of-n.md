---
title: Arena best-of-N
description: ผู้ใช้สั่ง /best-of-n Geno รันงานเดียวกันใน 2 ถึง 4 lane พร้อมกัน ตรวจแต่ละ lane ด้วย check ของโปรเจกต์ ให้ review จัดอันดับ แล้วผู้ใช้เลือก Pick หรือ Graft
tableOfContents: false
sidebar:
  order: 3
scenario:
  surface: vscode
  given:
    - workspace เป็น git repository ที่ตั้ง check ของโปรเจกต์ไว้ (เช่น `pnpm test`)
    - แชตที่แสดงอยู่เป็นของ checkout หลัก
  trigger: >-
    ผู้ใช้พิมพ์ `/best-of-n 3 --vary models migrate src/log.ts to pino` แล้วกด Enter
  covers: [wf.arena-best-of-n]
  related: [wf.lane-apply, sub.worktree-lane, wf.spinoff, ext.slash-builtin-editor]
  steps:
    - id: type
      lane: user
      do: ผู้ใช้พิมพ์คำสั่งแล้วกด Enter
      phase: idle

    - id: route
      lane: editor
      at: chat
      do: >-
        `routeText` เห็นว่า `best-of-n` เป็นคำสั่งที่ editor ทำเอง จึงไม่ส่ง prompt ไป engine
        `ArenaHost.begin` แยกอาร์กิวเมนต์ด้วย `parseBestOfN`: จำนวน 2 ถึง 4 และ `--vary seeds|effort|models`
      ref: packages/core/src/arena.ts#parseBestOfN

    - id: preview
      lane: editor
      at: engine-link
      do: >-
        `ArenaHost` ส่งคำขอ `_gcode/arena/preview` engine ประมาณราคาจากค่าใช้จ่ายของ session ล่าสุดๆ และคิดราคา review รวมไว้
        แล้วตอบพร้อมรายการ variant ของแต่ละ lane (ที่นี่คือโมเดลต่างกัน)
      ref: packages/engine/src/arena.ts#arenaPreview
      emits: [_gcode/arena/preview]

    - id: card
      lane: panel
      at: arena
      do: >-
        แผง Arena เปิดขึ้นพร้อมการ์ดก่อนเริ่ม: งาน lane แต่ละตัวกับ variant ของมัน และราคาประมาณ
      sees: การ์ดของ best-of-3 ที่มี lane A B C กับโมเดลของแต่ละตัว ราคาประมาณ และปุ่ม [Start] [Cancel]
      ref: packages/extension/src/chat/arena-panel.ts#arenaPanel

    - id: start
      lane: user
      do: ผู้ใช้กด Start

    - id: new
      lane: editor
      at: engine-link
      do: >-
        `ArenaHost` ส่งคำขอ `_gcode/arena/new` พร้อมงาน จำนวน variety และโหมดเริ่มต้นของแชต
      ref: packages/extension/src/chat/arena-host.ts#ArenaHost
      emits: [_gcode/arena/new]

    - id: lanes
      lane: server
      at: sessions
      do: >-
        `startArena` สร้าง lane ทีละตัว (`<slug>-a`, `-b`, `-c`) ด้วย `laneFor` แล้วเปิด session เบื้องหลังของแต่ละ lane
        พร้อมกัน งานของ arena ขึ้นในแผง Tasks เป็น "Best of 3: ..." สถานะของ run ถูกบันทึกใน `<git common dir>/geno/arenas/<id>.json`
        และทุกการเปลี่ยนไปถึงหน้าต่างเป็น `_gcode/arenaUpdate`
      ref: packages/engine/src/arena.ts#startArena
      emits: [_gcode/arenaUpdate]
      phase: running-tools

    - id: race-a
      lane: child@lane-a
      at: model
      do: >-
        lane A รันงานด้วยโมเดลของตัวเองใน worktree ของตัวเอง เป็น session ระดับบนสุดที่ไม่มีแชตไหนรอ
      ref: packages/core/src/arena.ts#variantPrompt

    - id: race-b
      lane: child@lane-b
      at: model
      alongside: true
      do: lane B รันงานเดียวกันพร้อมกันด้วยโมเดลอีกตัว
      ref: packages/core/src/arena.ts#variantPrompt

    - id: race-c
      lane: child@lane-c
      at: model
      alongside: true
      do: lane C รันงานเดียวกันพร้อมกันด้วยโมเดลตัวที่สาม
      ref: packages/core/src/arena.ts#variantPrompt
      fork:
        ask: ผู้ใช้รอหรือหยุด
        options:
          - id: wait
            label: รอ
            then: checked

          - id: stop
            label: กด Stop
            steps:
              - lane: user
                do: ผู้ใช้กด Stop ในแผง Arena ระหว่างที่ lane ยังรัน
              - lane: editor
                at: engine-link
                do: >-
                  `ArenaHost` ส่ง notification ACP `session/cancel` ให้ทุก lane ที่ยัง Running
                ref: packages/extension/src/chat/arena-host.ts#ArenaHost
                emits: [session/cancel]
              - lane: server
                at: turns
                do: >-
                  turn ของแต่ละ lane ถูก abort lane ที่หยุดได้สถานะ stopped ไม่ถูกตรวจและไม่ถูกจัดอันดับ ทุก lane ยังรันอยู่ จึงหยุดหมด run จบแบบ stopped lane ยังอยู่ให้เปิดดู (ถ้ามี lane ที่จบไปก่อนแล้ว lane นั้นยังถูกตรวจและจัดอันดับ)
                ref: packages/engine/src/arena.ts#startArena
                emits: [stopped]
                phase: ending
              - lane: panel
                at: arena
                do: แผง Arena แสดง run ที่หยุด
                sees: ป้าย "Stopped" บน run และบนแต่ละ lane
                ref: packages/extension/src/chat/arena-panel.ts#arenaPanel
                end: { turn: stopped }

    - id: checked
      lane: server
      at: sessions
      do: >-
        lane ที่จบแบบ done หรือชนเพดานถูกตรวจด้วย `checkLane`: check ของโปรเจกต์รันใน sandbox ของ lane นั้น
        แผงแสดงแต่ละ lane เป็น Checking แล้ว Passed หรือ Failed
      ref: packages/engine/src/arena.ts#checkLane

    - id: rank
      lane: server
      at: sessions
      do: >-
        เมื่อทุก lane จบ engine นับ lane ที่ผ่าน
      ref: packages/engine/src/arena.ts#startArena
      fork:
        ask: มี lane ผ่านกี่ตัว
        options:
          - id: two-plus
            label: 2 ตัวขึ้นไป
            then: review

          - id: fewer
            label: 1 ตัว หรือไม่มี
            then: results
            steps:
              - lane: server
                at: sessions
                do: >-
                  ไม่มีอะไรให้เทียบ `trivialRanking` ให้ lane เดียวที่ผ่านเป็นที่หนึ่งโดยไม่เรียก review
                  ถ้าไม่มี lane ผ่านเลย run ได้ป้าย "No lane passed"
                ref: packages/engine/src/arena.ts#startArena

    - id: review
      lane: child@review
      at: model
      runs: 1
      do: >-
        `reviewArena` เปิด session ของ checkout หลักแบบไม่มีใครตอบการ์ด แล้วออก call `agent: review` ในนามผู้ใช้
        พร้อม diff ของทุก lane ที่ผ่าน review จัดอันดับและให้เหตุผล `parseRanking` อ่านอันดับจากรายงาน
      ref: packages/engine/src/arena.ts#reviewArena
      emits: [agent]

    - id: results
      lane: panel
      at: arena
      do: >-
        แผง Arena แสดงผล: lane เรียงตามอันดับพร้อมเหตุผล ผลของ check ค่าใช้จ่าย และ diff เทียบกันจาก `_gcode/arena/compare`
        ปุ่ม Pick ของอันดับหนึ่งเป็นปุ่มหลัก และติ๊ก hunk ของ lane อื่นเพื่อ Graft ได้
      sees: ป้าย "Ranked" แถว lane B ป้าย "Winner" ปุ่ม [Pick B] และปุ่ม "Graft hunks"
      ref: packages/extension/src/chat/arena-model.ts#RUN_BADGES
      phase: idle

    - id: choose
      lane: user
      do: ผู้ใช้อ่านเหตุผลและ diff แล้วเลือก
      fork:
        ask: ผู้ใช้ทำอะไร
        options:
          - id: pick
            label: Pick
            steps:
              - lane: editor
                at: chat
                do: >-
                  `ArenaHost.pick` ส่ง `_gcode/arena/pick` ให้ engine บันทึกผู้ชนะ แล้วเรียก `Chat.applyLane` กับ lane นั้น
                  แผงขึ้น "Applying lane B in the chat…"
                ref: packages/extension/src/chat/arena-host.ts#ArenaHost
                emits: [_gcode/arena/pick]
                goto: wf.lane-apply

          - id: graft
            label: Graft hunk ที่เลือก
            steps:
              - lane: editor
                at: chat
                do: >-
                  ผู้ใช้ติ๊ก hunk ของ lane C แล้วกด Graft `graftLane` ส่ง prompt "Graft 2 hunks from lane ..." ที่มี `gcode/laneGraft`
                  engine ใช้ `applyLaneTurn` แบบเลือก hunk ซึ่งเขียนเฉพาะ hunk เหล่านั้นผ่าน review เหมือน Apply
                ref: "packages/extension/src/chat/chat.ts#\"async graftLane(name: string, hunks: readonly string[]): Promise<acp.StopReason>\""
                emits: [gcode/laneGraft]
                goto: wf.lane-apply
---

Arena คือการแข่งของหลาย lane บนงานเดียว ไม่มีแชตไหนรอผล ผลอยู่ในแผง Arena และกลับเข้า checkout หลักเมื่อผู้ใช้ Pick หรือ Graft เท่านั้น

| ขั้น | ที่ทำ | ใครทำ |
| --- | --- | --- |
| race | แต่ละ lane รันงานใน worktree ของตัวเอง | session ระดับบนสุด หนึ่งตัวต่อ lane |
| check | check ของโปรเจกต์ใน sandbox ของ lane | engine |
| rank | review จัดอันดับ lane ที่ผ่าน (เมื่อผ่าน 2 ตัวขึ้นไป) | เอเจนต์ `review` ใน session ที่ไม่มีใครตอบการ์ด |
| pick หรือ graft | merge lane ที่เลือก หรือ hunk ที่เลือก เข้าแชตของ checkout หลัก | turn ของแชตที่ไม่มีโมเดล |

สิ่งที่ควรสังเกต

- **`/best-of-n` ไม่ถึงโมเดลของแชต** editor จัดการเองทั้งหมด แชตไม่มี turn จนกว่าผู้ใช้จะ Pick หรือ Graft
- **lane ที่แพ้ยังอยู่** แผง Lanes ยังแสดงทุก lane ผู้ใช้ Discard เองหรือใช้ `gcode lane sweep` ลบ lane ที่ไม่มีอะไรจะเสีย
- **lane ที่ชนเพดานยังถูกตรวจ** งานที่ไม่เสร็จแต่ผ่าน check ก็ได้ลงแข่งในอันดับ
