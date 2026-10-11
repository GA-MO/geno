---
title: steer มาไม่ทัน turn
description: ผู้ใช้กด Send now ระหว่างที่โมเดลเขียนคำตอบสุดท้าย turn จบก่อนถึงจุดปลอดภัย ถ้า turn จบเอง ข้อความกลายเป็น turn ถัดไป ถ้าผู้ใช้กด Stop ข้อความกลับไปที่ช่องพิมพ์
tableOfContents: false
sidebar:
  order: 5
scenario:
  surface: vscode
  given:
    - turn ของแชตนี้กำลังทำงาน เครื่องมือรันเสร็จหมดแล้ว และโมเดลกำลัง stream คำตอบสุดท้ายโดยไม่เรียกเครื่องมืออีก
    - ข้อความที่จะส่งไม่มีไฟล์แนบหรือ `@` mention
  trigger: >-
    ผู้ใช้พิมพ์ "แล้วอัปเดต README ด้วย" แล้วคลิก Send now หรือกด Cmd-Enter
  covers: [ctl.steer-missed-runs-next, ctl.steer-after-stop]
  related: [ctl.steer-delivered, ctl.queued-followup, ctl.stop-while-streaming, ctl.steer-refused]
  steps:
    - id: type
      lane: user
      do: ผู้ใช้กด Send now ขณะที่โมเดลยังเขียนคำตอบอยู่
      phase: calling-model

    - id: steer
      lane: panel
      at: composer
      do: >-
        `steerNow` ย้ายข้อความออกจากช่องพิมพ์ไปเป็นข้อความที่กำลังส่ง แล้วโพสต์ `steer` ถึงแชตนี้ไปให้ extension host
      sees: ช่องพิมพ์ว่าง ป้าย "Sending now" เหนือช่องพิมพ์
      ref: packages/extension/src/chat/webview.ts#steerNow
      emits: [steer]

    - id: request
      lane: editor
      at: chat
      do: >-
        `SteerHost.steerChat` จำข้อความนี้ไว้เป็นข้อความที่ค้างของ turn นี้ แล้วส่งคำขอ ACP `session/prompt` ที่มี `STEER_META`
      ref: packages/extension/src/chat/steer-host.ts#SteerHost.steerChat
      emits: [STEER_META]

    - id: inbox
      lane: server
      at: turns
      do: >-
        `steerRunning` ใส่ข้อความไว้ใน inbox ของ turn คำขอค้างอยู่ จุดปลอดภัยถัดไปคือก่อนการเรียกโมเดลครั้งหน้า
        แต่คำตอบที่กำลัง stream จะไม่มีการเรียกครั้งหน้า
      ref: packages/engine/src/steer.ts#steerRunning

    - id: streaming
      lane: model
      do: >-
        โมเดลเขียนคำตอบต่อ steer ไม่ขัด stream
      ref: "packages/engine/src/drive.ts#\"onText: (delta) => watcher.text(delta),\""
      fork:
        ask: turn จบอย่างไร
        options:
          - id: ends
            label: โมเดลเขียนจนจบเอง
            steps:
              - lane: model
                do: "โมเดลจบคำตอบด้วย `stop_reason: end_turn`"
                ref: "packages/engine/src/gateway.ts#\"stopReason: message.stop_reason,\""
                emits: [end_turn]
              - lane: loop
                at: step
                do: >-
                  `loopStep` ให้ `done(end_turn)` ซึ่ง `STEER_AT` บอกว่า steer ที่ค้างไปเป็น turn ถัดไป `end()` ปิด inbox
                  และตอบข้อความที่ค้างว่า `next-turn`
                ref: packages/core/src/steer.ts#STEER_AT
                emits: [next-turn]
                phase: ending
              - lane: server
                at: turns
                do: >-
                  `finally` ของ `runTurn` บอก `turnEnds` ว่า turn ไม่ได้ถูกหยุด แล้ว `steer` เรียก `prompt()` ด้วยข้อความเดิมที่ตัด
                  `STEER_META` ออก เป็น turn ใหม่ต่อจาก turn ที่จบ คำขอ steer เดิมจะได้คำตอบเมื่อ turn ใหม่นี้จบ
                ref: "packages/engine/src/serve.ts#\"return prompt({ ...params, _meta: meta });\""
                phase: starting
              - lane: editor
                at: chat
                do: >-
                  turn แรกได้คำตอบ `end_turn` แผงได้ `turn-end` สถานะ `done` แล้ว `SteerHost.turnEnded` เห็นว่าข้อความที่ค้างยังไม่ส่งถึง
                  จึงโพสต์ `steered` ผล `next-turn` และ `adopt` แสดง turn ใหม่ที่มีข้อความนั้นเป็น prompt
                ref: packages/extension/src/chat/steer-host.ts#SteerHost.turnEnded
                emits: [turn-end, steered, turn-start]
              - lane: panel
                at: rail
                do: >-
                  ป้าย "Sending now" หายไป turn แรกจบตามปกติ แล้ว turn ใหม่เริ่มด้วยบับเบิลของข้อความที่ส่ง
                sees: >-
                  หัวข้อของ turn แรกเป็น "worked for 21s" ตามด้วย turn ใหม่ที่บับเบิล "แล้วอัปเดต README ด้วย" หัวข้อ "working"
                ref: packages/extension/src/chat/webview.ts#render
              - use: model-call
              - lane: model
                do: >-
                  โมเดลอ่านข้อความเป็น prompt ธรรมดาของ turn ใหม่ ไม่ใช่ข้อความ "sent while you were working"
                ref: "packages/engine/src/gateway.ts#\"stopReason: message.stop_reason,\""
                end: { turn: continues, reason: call-model }

          - id: stop
            label: ผู้ใช้กด Stop
            steps:
              - lane: user
                do: ผู้ใช้กด Stop ก่อนคำตอบจบ
              - lane: editor
                at: chat
                do: >-
                  `Chat.stop` ส่ง notification ACP `session/cancel` engine abort turn
                ref: packages/extension/src/chat/chat.ts#Chat.stop
              - lane: loop
                at: drive
                do: >-
                  gateway คืน `abort` `drive` บันทึก event `error` ชนิด `abort` แล้ว `loopStep` ให้ `done(error)`
                  `end()` ปิด inbox และตอบข้อความที่ค้างว่า `next-turn`
                ref: "packages/engine/src/drive.ts#\"inbox?.close();\""
                emits: [abort, next-turn]
                phase: ending
              - lane: server
                at: turns
                do: >-
                  `finally` ของ `runTurn` บอก `turnEnds` ว่า turn ถูกหยุด `steer` จึงไม่เริ่ม turn ใหม่ แต่ตอบคำขอ steer ด้วย
                  `invalidRequest` "the turn was stopped before the steer landed, so it did not run" เหมือนข้อความ Queued ที่ Stop คืนให้ผู้ใช้
                ref: "packages/engine/src/serve.ts#\"if (stopped === true) throw acp.RequestError.invalidRequest({ sessionId }, 'the turn was stopped before the steer landed, so it did not run');\""
                emits: [cancelled]
              - lane: editor
                at: chat
                do: >-
                  turn ได้คำตอบ `cancelled` แผงได้ `turn-end` สถานะ `stopped` แล้ว `SteerHost.turnEnded` ปิดข้อความที่ค้างเป็น `failed`
                  ("The turn was stopped, so this did not send") ก่อนที่ error ของ engine จะมาถึง
                ref: packages/extension/src/chat/steer-host.ts#SteerHost.turnEnded
                emits: [turn-end, steered]
              - lane: panel
                at: composer
                do: >-
                  `followupSteered` เห็นว่าไม่มี turn ทำงานแล้ว จึงคืนข้อความกลับไปที่ช่องพิมพ์ (ถ้าช่องพิมพ์ยังว่าง)
                  ข้อความ "did not send" ไม่ขึ้นที่ไหน ป้าย "Sending now" แค่หายไป
                sees: >-
                  ท้าย turn ขึ้น "Stopped by you" ป้าย "Sending now" หายไป และ "แล้วอัปเดต README ด้วย" กลับมาอยู่ในช่องพิมพ์
                ref: packages/extension/src/chat/steer-model.ts#followupSteered
                end: { turn: stopped, reason: cancelled }
---

steer ส่งถึงได้เฉพาะที่จุดปลอดภัยก่อนการเรียกโมเดล ถ้าโมเดลกำลังเขียนคำตอบสุดท้าย จะไม่มีจุดนั้นอีกใน turn นี้
engine ไม่ทิ้งข้อความ แต่ถือไว้จนรู้ว่า turn จบอย่างไร ดูทางที่ส่งถึงได้ทันที่ [ส่งข้อความแทรกเข้าเทิร์นที่กำลังทำงาน](/scenarios/ctl/steer-delivered/)

| turn จบแบบ | ข้อความ |
| --- | --- |
| `done` | เป็น prompt ของ turn ถัดไป แผงแสดง turn ใหม่ทันที |
| `stopped` | ไม่ส่ง กลับไปที่ช่องพิมพ์ |
| `failed` | เป็น prompt ของ turn ถัดไป เพราะ engine ถือว่าเฉพาะ Stop เท่านั้นที่คืนข้อความ |

สิ่งที่ควรสังเกต

- **Stop คืนข้อความเหมือน Queued** ข้อความ Queued ที่รออยู่กลับไปที่ช่องพิมพ์เมื่อ turn ถูกหยุดหรือล้ม
  steer ที่ค้างกลับไปเฉพาะเมื่อถูกหยุด เมื่อ turn ล้ม engine รันมันเป็น turn ถัดไป ทั้งที่ข้อความ Queued ในกรณีเดียวกันไม่ถูกส่ง
- **แผงไม่บอกว่าไม่ได้ส่ง** ผล `failed` ของ steer ถึงแชตไม่ขึ้นเป็นข้อความ ผู้ใช้เห็นแค่ข้อความกลับมาในช่องพิมพ์
  ถ้าผู้ใช้พิมพ์อะไรไว้ในช่องพิมพ์แล้ว ข้อความเดิมไม่ทับ และหายไปเงียบๆ
- **turn ถัดไปจากหลาย steer** ถ้ามี steer ค้างหลายข้อความ `nextTurns` เรียงให้รันทีละ turn ตามลำดับที่มาถึง
