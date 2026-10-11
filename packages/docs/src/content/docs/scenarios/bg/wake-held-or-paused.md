---
title: การปลุกถูกรอหรือถูกพัก
description: รายงานมาถึงตอน session ว่าง แต่ประตูของตัวปลุกยังไม่เปิด เพราะมีการ์ดค้าง ไม่มีหน้าต่าง turn ก่อนจบด้วย error หรือปลุกครบ 12 ครั้งแล้ว สิ่งที่มาถึงรออยู่ใน log
tableOfContents: false
sidebar:
  order: 10
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
      lane: child@explore
      at: model
      do: >-
        explore เรียก `report` แล้วจบแบบ `done`
      ref: packages/engine/src/subagents.ts#reportExecutor
      emits: [report]
      phase: idle

    - id: logged
      lane: server
      at: wakes
      do: >-
        รายงานเข้ากล่องข้อความของ session ไม่มี turn รับ `logArrivals` จึงบันทึก `child-end` และรายงาน (`from: 'child'`) ลง log ทันที
        แล้วให้ตัวปลุกดูประตู
      ref: packages/engine/src/background-hooks.ts#logArrivals
      emits: [child-end, user]

    - id: gate
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
                at: tasks
                do: >-
                  ลูกอีกตัวของ session นี้รอการ์ดขออนุญาตอยู่ งานจึงเป็น `needs-input` `Tasks.asks` ตอบว่าใช่
                  ประตูตอบ `hold` (`card`) เพื่อไม่ให้ turn ใหม่แทรกขณะผู้ใช้กำลังตัดสินใจ
                ref: packages/engine/src/tasks.ts#Tasks.asks
              - lane: user
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
                at: wakes
                do: >-
                  ผู้ใช้ปิดหน้าต่าง VS Code ทุกบาน engine ยังรันลูกจนเสร็จ แต่ไม่มีหน้าต่างให้รัน turn ที่ถูกปลุก
                  ประตูตอบ `hold` (`window`)
                ref: packages/core/src/wake.ts#wakeGate
              - lane: user
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
                do: ภายหลังผู้ใช้ส่ง prompt ใหม่ใน session นี้
              - lane: loop
                at: drive
                do: >-
                  รายงานอยู่ใน log แล้ว จึงไปกับ prompt นี้ในคำขอแรก โมเดลอ่านทั้งสองอย่างพร้อมกัน prompt ของผู้ใช้ยังปลดการพักด้วย
                ref: packages/core/src/wake.ts#lastUserPromptSeq
                phase: calling-model
                end: { turn: continues, reason: call-model }

          - id: cap
            label: paused เพราะปลุกครบ 12 ครั้งในชั่วโมงนี้
            steps:
              - lane: server
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
      lane: server
      at: wakes
      do: >-
        ประตูตอบ `wake` `wakeTurn` เรียก `runTurn` แบบ `wake` และ `logWake` บันทึกข้อความแรกของ turn จาก engine
      ref: packages/engine/src/serve.ts#logWake
      emits: [wake, user_message_chunk, WAKE_META]
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
      lane: model
      do: >-
        โมเดลอ่านรายงานของ explore แล้วเล่าผลให้ผู้ใช้ จบด้วย `stop_reason: end_turn`
      ref: packages/core/src/wake.ts#wakeNotice
      emits: [end_turn]
      phase: calling-model

    - use: bg-woken-ends
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
