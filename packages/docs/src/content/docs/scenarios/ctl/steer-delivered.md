---
title: ส่งข้อความแทรกเข้าเทิร์นที่กำลังทำงาน
description: ผู้ใช้กด Send now ระหว่างที่คำสั่งรันอยู่ ข้อความรอที่ inbox ของ turn แล้วเข้าสู่ log ที่จุดปลอดภัยก่อนการเรียกโมเดลครั้งถัดไป
tableOfContents: false
sidebar:
  order: 4
scenario:
  surface: vscode
  given:
    - turn ของแชตนี้กำลังทำงาน และ `bash` กำลังรัน `pnpm test` ในชุดของตัวเอง
    - ช่องพิมพ์ไม่มีข้อความรอในคิว และข้อความที่จะส่งไม่มีไฟล์แนบหรือ `@` mention
  trigger: >-
    ผู้ใช้พิมพ์ "อย่าแก้ไฟล์ test นะ" แล้วคลิกปุ่ม Send now (ลูกศรขึ้นข้างปุ่ม Stop) หรือกด Cmd-Enter
  covers: [ctl.steer-delivered]
  related: [ctl.queued-followup, ctl.stop-while-tools-run, turn.with-tools]
  steps:
    - id: type
      lane: user
      do: ผู้ใช้พิมพ์ข้อความแล้วกด Send now ขณะที่คำสั่งยังรันอยู่
      phase: running-tools

    - id: steer
      lane: panel
      at: composer
      do: >-
        `steerNow` ย้ายข้อความออกจากช่องพิมพ์ไปเป็นข้อความที่กำลังส่ง แล้วโพสต์ `steer` ถึงแชตนี้ไปให้ extension host
      sees: >-
        ช่องพิมพ์ว่าง ป้าย "Sending now" เหนือช่องพิมพ์ (ชี้แล้วขึ้น "Lands at the next tool round, between the step running now and the model’s next answer")
      ref: packages/extension/src/chat/webview.ts#steerNow
      emits: [steer]

    - id: request
      lane: editor
      at: chat
      do: >-
        `SteerHost.steerChat` เห็นว่ามี turn ทำงานอยู่ จึงส่งคำขอ ACP `session/prompt` ที่มี `_meta` `STEER_META` เป็น `true`
        (ถ้าไม่มี turn ทำงานแล้ว ข้อความจะถูกส่งเป็น prompt ธรรมดา)
      ref: packages/extension/src/chat/steer-host.ts#SteerHost.steerChat
      emits: [STEER_META]

    - id: inbox
      lane: server
      at: turns
      do: >-
        engine เห็น `STEER_META` จึงไม่เริ่ม turn ใหม่ `steerRunning` ตรวจว่าเป็นข้อความล้วนและไม่ว่าง แล้วใส่ไว้ใน inbox ของ turn
        คำขอนี้ค้างอยู่จนกว่า loop จะรับข้อความ
      ref: packages/engine/src/steer.ts#steerRunning

    - id: hold
      lane: loop
      at: tools
      do: >-
        loop กำลังรันเครื่องมือ ตาราง `STEER_AT` บอกว่าระหว่าง `run-tools` ให้ถือข้อความไว้ก่อน คำสั่งที่รันอยู่ไม่ถูกขัด
      ref: packages/core/src/steer.ts#STEER_AT

    - use: tool-result-returns

    - id: decide
      lane: loop
      at: step
      do: >-
        `loopStep` เห็น `tool-result` ล่าสุดจึงตัดสิน `call-model` ซึ่งเป็นจุดเดียวที่ `STEER_AT` ให้ส่งข้อความเข้า
      ref: packages/core/src/loop.ts#loopStep
      emits: [call-model]
      phase: calling-model

    - id: deliver
      lane: loop
      at: drive
      do: >-
        `deliver()` รับข้อความจาก inbox บันทึกเป็น event `user` ที่มี `steer: true` ต่อจากผลของเครื่องมือ
        แล้วตอบ inbox ว่า `delivered` พร้อม seq เพราะมีของมาถึง loop จึงวนอ่าน log อีกรอบก่อนเรียกโมเดล
      ref: packages/engine/src/drive.ts#deliver
      emits: [user, delivered]

    - id: update
      lane: server
      at: updates
      do: >-
        `steerUpdate` ส่ง event นั้นเป็น `session/update` ชนิด `user_message_chunk` พร้อม `STEER_META` ที่บอก seq
      ref: packages/engine/src/session-replay.ts#steerUpdate
      emits: [user_message_chunk]

    - id: action
      lane: editor
      at: chat
      alongside: true
      do: >-
        `steerActionOf` เห็น `STEER_META` จึงแปลงเป็น action `steer` แทนข้อความของผู้ใช้ธรรมดา
      ref: packages/extension/src/chat/steer-host.ts#steerActionOf

    - id: bubble
      lane: panel
      at: rail
      alongside: true
      do: >-
        ข้อความขึ้นเป็นบับเบิลในตำแหน่งที่มันเข้า turn จริง คือหลังขั้นของคำสั่ง
      sees: บับเบิลป้าย "Sent mid-turn" ข้อความ "อย่าแก้ไฟล์ test นะ" อยู่ใต้ขั้น "pnpm test"
      ref: "packages/extension/src/chat/steer-model.ts#\"user: ({ text }) => ({ kind: 'bubble', label: 'Sent mid-turn', text }),\""

    - id: answered
      lane: server
      at: turns
      do: >-
        คำขอ steer ได้คำตอบทันทีที่ส่งถึง: `stopReason: end_turn` พร้อม `STEER_META` ชนิด `delivered`
        คำตอบนี้ไม่ได้แปลว่า turn จบ turn ยังทำงานต่อ
      ref: "packages/engine/src/serve.ts#\"if (outcome.kind === 'delivered') return { stopReason: 'end_turn', _meta: { [STEER_META]: outcome } };\""

    - id: settled
      lane: editor
      at: chat
      do: >-
        `steerResultOf` อ่านได้ `delivered` `SteerHost` โพสต์ `steered` ให้แผง ป้าย "Sending now" หายไป
      ref: packages/extension/src/chat/steer-host.ts#steerResultOf
      emits: [steered]

    - use: model-call

    - id: reads
      lane: model
      do: >-
        คำขอนี้มีผลของ `pnpm test` ตามด้วยข้อความของผู้ใช้ห่อด้วย `userSteerText`
        ("The user sent a new message while you were working: ...") โมเดลปรับงานตามนั้นใน turn เดิม
      ref: packages/core/src/fence.ts#userSteerText
      end: { turn: continues, reason: call-model }
---

steer คือข้อความที่ผู้ใช้ส่งเข้า turn ที่กำลังทำงาน แทนที่จะรอให้ turn จบแบบข้อความ Queued
ข้อความไม่ได้ไปถึงโมเดลทันที มันรอที่ inbox ของ turn จนถึงจุดปลอดภัย `deliver()` ซึ่งอยู่ระหว่างผลของเครื่องมือชุดล่าสุดกับการเรียกโมเดลครั้งถัดไป

| loop กำลังทำอะไรตอนข้อความมาถึง | ผล |
| --- | --- |
| รันเครื่องมือ หรือตอบ call ที่รันไม่ได้ | ถือไว้จนถึงการเรียกโมเดลครั้งถัดไป |
| จะเรียกโมเดล | ส่งเข้า log ทันทีที่ `deliver()` |
| turn จบแล้ว | กลายเป็น turn ถัดไป |

สิ่งที่ควรสังเกต

- **ไม่มีการขัดกลาง stream** steer เข้าได้เฉพาะก่อนการเรียกโมเดล ถ้าโมเดลกำลังเขียนคำตอบสุดท้ายอยู่ steer จะไม่ทัน
  และกลายเป็น turn ถัดไปแทน
- **ส่งถึงแล้ว loop ตรวจขีดจำกัดอีกรอบ** `deliver()` คืนค่า true เมื่อมีของมาถึง loop จึงเรียก `loopStep` ใหม่ก่อนเรียกโมเดล
  Stop และขีดจำกัดของรอบจึงยังมีผลกับข้อความที่เพิ่งเข้า
- **steer เป็นข้อความล้วน** ข้อความที่มีไฟล์แนบหรือ `@` mention กด Send now ไม่ได้ ต้องรอในคิวเป็นข้อความ Queued
