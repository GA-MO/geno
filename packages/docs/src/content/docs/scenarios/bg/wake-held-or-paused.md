---
title: การปลุกถูกรอหรือถูกพัก
description: รายงานมาถึงตอน session ว่าง แต่ประตูของตัวปลุกยังไม่เปิด เพราะมีการ์ดค้าง ไม่มีหน้าต่าง turn ก่อนจบด้วย error หรือปลุกครบ 12 ครั้งแล้ว สิ่งที่มาถึงรออยู่ใน log
scenario:
  surface: vscode
  given:
    - การปลุกอัตโนมัติเปิดอยู่ session นี้ไม่มี turn ทำงาน
    - session รอลูก `explore` แบบเบื้องหลังที่เริ่มไว้ใน turn ก่อน
  trigger: >-
    explore รายงานเสร็จ
  covers: [bg.wake-held-or-paused]
  related: [bg.child-wakes-parent, bg.user-cancels-wakes, bg.task-attention, bg.monitor-wakes]
  steps:
    - id: report
      beat:
        title: explore รายงานเสร็จ
        text: session นี้ไม่มี turn ทำงาน แต่รอ explore ที่เริ่มไว้ใน turn ก่อน explore ส่งรายงานแล้วจบ
        from: model
        to: engine
      lane: child@explore
      at: model
      do: >-
        explore เรียก `report` แล้วจบแบบ `done`
      ref: packages/engine/src/subagents.ts#reportExecutor
      emits: [report]
      phase: idle

    - id: logged
      beat:
        title: Geno บันทึกรายงานลง log ทันที
        text: ไม่มี turn รับรายงาน Geno จึงบันทึกมันลง log ก่อน แล้วค่อยดูว่าปลุกได้ไหม
        from: engine
        to: engine
      lane: server
      at: wakes
      do: >-
        รายงานเข้ากล่องข้อความของ session ไม่มี turn รับ `logArrivals` จึงบันทึก `child-end` และรายงาน (`from: 'child'`) ลง log ทันที
        แล้วให้ตัวปลุกดูประตู
      ref: packages/engine/src/background-hooks.ts#logArrivals
      emits: [child-end, user]

    - id: gate
      beat:
        title: Geno ดูว่าปลุกได้ไหม
        text: Geno ไล่กฎตามลำดับ การปลุกปิดอยู่ไหม มี turn รัน การปลุกถูกพัก มีการ์ดค้าง คุณกำลังพิมพ์ หรือไม่มีหน้าต่าง
        from: engine
        to: engine
        ask: ปลุกได้ไหม
      lane: server
      at: wakes
      do: >-
        `WakeDriver.look` ถาม `wakeGate` ซึ่งไล่กฎตามลำดับ: ไม่มีอะไรมาถึง การปลุกปิด มี turn รัน การปลุกถูกพัก มีการ์ดค้าง
        ผู้ใช้กำลังพิมพ์ ยังไม่ครบ 2 วินาที ไม่มีหน้าต่าง ข้อแรกที่ตรงชนะ ผลแต่ละครั้งไปที่งานของ session ในแผง Tasks
      ref: packages/core/src/wake.ts#wakeGate
      fork:
        ask: ประตูตอบอะไร
        options:
          - id: card
            label: hold เพราะมีการ์ดค้าง
            then: wake
            steps:
              - lane: server
                beat:
                  title: รอ เพราะมีการ์ดค้าง
                  text: subagent อีกตัวของ session นี้รอการ์ด permission Geno ไม่ให้ turn ใหม่แทรกขณะคุณตัดสินใจ
                  from: engine
                  to: engine
                at: tasks
                do: >-
                  ลูกอีกตัวของ session นี้รอการ์ดขออนุญาตอยู่ งานจึงเป็น `needs-input` `Tasks.asks` ตอบว่าใช่
                  ประตูตอบ `hold` (`card`) เพื่อไม่ให้ turn ใหม่แทรกขณะผู้ใช้กำลังตัดสินใจ
                ref: packages/engine/src/tasks.ts#Tasks.asks
              - lane: user
                beat:
                  title: คุณตอบการ์ด
                  text: งานใน Tasks เปลี่ยน Geno ดูอีกครั้ง ไม่มีอะไรกันแล้ว
                  from: you
                  to: panel
                do: ผู้ใช้ตอบการ์ดนั้น
              - lane: server
                at: wakes
                do: >-
                  การตอบการ์ดเปลี่ยนงานในแผง Tasks ตัวปลุกดูประตูอีกครั้ง ไม่มีอะไรกันแล้ว
                ref: packages/engine/src/wake-hooks.ts#WakeDriver.soon

          - id: window
            label: hold เพราะไม่มีหน้าต่าง
            then: wake
            steps:
              - lane: server
                beat:
                  title: รอ เพราะไม่มีหน้าต่าง
                  text: คุณปิดหน้าต่าง VS Code ทุกบาน engine ยังรัน explore จนเสร็จ แต่ไม่มีหน้าต่างให้รัน turn
                  from: engine
                  to: engine
                at: wakes
                do: >-
                  ผู้ใช้ปิดหน้าต่าง VS Code ทุกบาน engine ยังรันลูกจนเสร็จ แต่ไม่มีหน้าต่างให้รัน turn ที่ถูกปลุก
                  ประตูตอบ `hold` (`window`)
                ref: packages/core/src/wake.ts#wakeGate
              - lane: user
                beat:
                  title: คุณเปิดโฟลเดอร์อีกครั้ง
                  text: หน้าต่างต่อ engine ก่อนมันจบ Geno ดูทุก session ที่รออยู่ คราวนี้มีหน้าต่างแล้ว
                  from: you
                  to: panel
                do: ผู้ใช้เปิดโฟลเดอร์เดิมใน VS Code อีกครั้งก่อนที่ engine จะจบ
              - lane: server
                at: wakes
                do: >-
                  หน้าต่างต่อ engine `WakeDriver.connected` ดูประตูของทุก session ที่รออยู่ คราวนี้มีหน้าต่างแล้ว
                ref: packages/engine/src/wake-hooks.ts#WakeDriver.connected

          - id: failed
            label: paused เพราะ turn ก่อนจบด้วย error
            steps:
              - lane: server
                beat:
                  title: พัก เพราะ turn ก่อนจบด้วย error
                  text: turn ล่าสุดจบด้วย Stop ขีดจำกัด หรือ error อื่น การปลุกพักไว้จนคุณส่ง prompt ทางนี้ไม่มีอะไรรอต่อ แผง Tasks จึงไม่บอกว่าพัก
                  from: engine
                  to: engine
                  sees: แถวของ session ขึ้นเหมือนงานที่จบแล้วตามปกติ
                at: wakes
                do: >-
                  turn ล่าสุดของ session จบด้วย error (ผู้ใช้กด Stop ขีดจำกัด หรือ error อื่น) `wakePauseOf` ตอบว่าพักไว้จนผู้ใช้ส่ง prompt
                  ประตูตอบ `paused` ไม่มี turn ถูกปลุก
                ref: packages/core/src/wake.ts#wakePauseOf
                emits: [paused]
                phase: idle
              - lane: panel
                at: tasks
                do: >-
                  แผง Tasks แสดงข้อความพักเฉพาะเมื่อ session ยังรออย่างอื่นอยู่ หรือเมื่อพักเพราะครบเพดาน
                  ในทางนี้ explore รายงานแล้วและไม่มีอะไรรอต่อ งานของ session จึงไม่แสดงอะไรเกี่ยวกับรายงานที่มาถึง
                sees: แถวของ session ขึ้นเหมือนงานที่จบแล้วตามปกติ ไม่มีบรรทัด "Wake-ups paused after Stop"
                ref: packages/extension/src/chat/lanes-model.ts#taskRowOf
              - lane: user
                beat:
                  title: คุณส่ง prompt ใหม่
                  text: รายงานอยู่ใน log แล้ว จึงไปกับ prompt นี้ในคำขอแรก prompt ของคุณยังปลดการพักด้วย
                  from: you
                  to: panel
                  end: prompt ของคุณพารายงานไป
                do: ภายหลังผู้ใช้ส่ง prompt ใหม่ใน session นี้
              - lane: loop
                at: drive
                do: >-
                  รายงานอยู่ใน log แล้ว จึงไปกับ prompt นี้ในคำขอแรก model อ่านทั้งสองอย่างพร้อมกัน prompt ของผู้ใช้ยังปลดการพักด้วย
                ref: packages/core/src/wake.ts#lastUserPromptSeq
                phase: calling-model
                end: { turn: continues, reason: call-model }

          - id: cap
            label: paused เพราะปลุกครบ 12 ครั้งในชั่วโมงนี้
            steps:
              - lane: server
                beat:
                  title: พัก เพราะปลุกครบ 12 ครั้ง
                  text: นับจาก prompt ล่าสุดของคุณ session ถูกปลุกไปแล้ว 12 ครั้งในหนึ่งชั่วโมง งานย้ายไปกลุ่ม Needs you
                  from: engine
                  to: panel
                  sees: ป้าย "Wake-ups paused" และบรรทัด "Paused after 12 wake-ups in an hour"
                  end: รอคุณใน Needs you
                at: wakes
                do: >-
                  นับจาก prompt ล่าสุดของผู้ใช้ session ถูกปลุกไปแล้ว 12 ครั้งในหนึ่งชั่วโมง `wakePauseOf` ตอบ `cap` ประตูตอบ `paused`
                ref: packages/core/src/wake.ts#wakesInWindow
                emits: [paused]
                phase: idle
              - lane: panel
                at: tasks
                do: >-
                  การพักเพราะเพดานย้ายงานไปอยู่ในกลุ่ม Needs you พร้อมป้ายและบรรทัดอธิบาย
                sees: ป้าย "Wake-ups paused" และบรรทัด "Paused after 12 wake-ups in an hour"
                ref: packages/core/src/attention.ts#ownAttention
                end: { turn: waits, reason: cap }

    - id: wake
      beat:
        title: Geno เปิด turn ใหม่เอง
        text: แชตเปิด turn ที่หัวมีกระดิ่งแทนข้อความของคุณ
        from: engine
        to: panel
        sees: 'กระดิ่งกับ "woke: 1 task finished"'
      lane: server
      at: wakes
      do: >-
        ประตูตอบ `wake` `wakeTurn` เรียก `runTurn` แบบ `wake` และ `logWake` บันทึกข้อความแรกของ turn จาก engine
        เป็น event `user` ที่มี `from: 'wake'` แล้ว `runTurn` ส่งข้อความนั้นเป็น `user_message_chunk` พร้อม `WAKE_META`
      ref: packages/engine/src/serve.ts#logWake
      emits: [user, user_message_chunk, WAKE_META]
      phase: starting

    - id: adopt
      lane: editor
      at: chat
      do: >-
        `woken` เปิด turn ใหม่ในแผงโดยไม่มีข้อความของผู้ใช้
      ref: packages/extension/src/chat/chat.ts#Chat.woken
      emits: [turn-start]

    - id: head
      lane: panel
      at: rail
      alongside: true
      do: หัวของ turn มีกระดิ่งกับเหตุที่ปลุก
      sees: >-
        กระดิ่งกับ "woke: 1 task finished"
      ref: packages/extension/src/chat/render.ts#turnHead

    - use: model-call

    - id: relays
      beat:
        title: Model เล่าผลของ explore
        text: model อ่านรายงานแล้วเขียนผลถึงคุณ
        from: model
        to: engine
      lane: model
      do: >-
        model อ่านรายงานของ explore แล้วเล่าผลให้ผู้ใช้ จบด้วย `stop_reason: end_turn`
      ref: packages/core/src/wake.ts#wakeNotice
      emits: [end_turn]
      phase: calling-model

    - use: bg-woken-ends
      beat:
        title: Geno จบ turn แผงแสดงคำตอบ
        text: Geno จบ turn ที่ตัวเองเริ่ม แผงอ่านการจบจากงานในแผง Tasks แล้วแสดงคำตอบของ model ใต้หัวที่มีกระดิ่ง
        from: engine
        to: panel
        end: Turn ที่ถูกปลุกจบ
---

ประตูของตัวปลุกมีหน้าที่เดียว: ไม่ให้ Geno เริ่ม turn เองในจังหวะที่ผู้ใช้ไม่อยากให้เริ่ม
สิ่งที่มาถึงไม่เคยหาย มันอยู่ใน log ตั้งแต่ตอนมาถึง ประตูตัดสินแค่ว่าจะเปิด turn ใหม่ให้มันตอนนี้หรือรอ prompt ถัดไปของผู้ใช้

| ประตูตอบ | เพราะ | เปิดอีกเมื่อ |
| --- | --- | --- |
| `hold` (`off`) | ผู้ใช้ปิด `gcode.wake.auto` | ไม่เปิด รอ prompt ของผู้ใช้ |
| `hold` (`turn`) | มี turn รันอยู่ | turn นั้นจบ (ซึ่งมักรับสิ่งที่มาถึงไปแล้ว) |
| `hold` (`card`) | การ์ดของ session หรือลูกค้าง | ผู้ใช้ตอบการ์ด |
| `hold` (`typing`) | ช่องพิมพ์มีร่างข้อความ | ร่างว่างแล้ว 2 วินาที |
| `hold` (`window`) | ไม่มีหน้าต่างต่อ engine | หน้าต่างต่อเข้ามา |
| `paused` (`stopped`, `limit`, `failed`) | turn ล่าสุดจบด้วย error | ผู้ใช้ส่ง prompt |
| `paused` (`cap`) | ปลุกครบ 12 ครั้งในชั่วโมง | ผู้ใช้ส่ง prompt |

สิ่งที่ควรสังเกต

- **การพักหลัง error อาจเงียบ** (อ่านจากโค้ด) แผง Tasks แสดงข้อความพักเฉพาะเมื่อยังมีอะไรรออยู่ หรือเมื่อพักเพราะเพดาน
  ถ้าสิ่งสุดท้ายที่รออยู่มาถึงหลัง Stop ผู้ใช้ไม่เห็นอะไรบอกว่ามีรายงานรออยู่ใน log จนกว่าจะส่ง prompt
- **engine ไม่รอหน้าต่างตลอดไป** engine จบเองหลังหน้าต่างสุดท้ายปิดไป 10 วินาทีเมื่อไม่มี turn รัน ลูกที่ยังรันทำให้มันอยู่ต่อ
  ถ้า engine จบไปก่อนผู้ใช้กลับมา รายงานที่บันทึกแล้วยังอยู่ใน log แต่ไม่มีใครปลุก
