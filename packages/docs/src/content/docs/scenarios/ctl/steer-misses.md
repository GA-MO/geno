---
title: "Steer มาไม่ทัน turn"
description: ผู้ใช้กด Send now ระหว่างที่ model เขียนคำตอบสุดท้าย turn จบก่อนถึงจุดปลอดภัย ถ้า turn จบเอง ข้อความกลายเป็น turn ถัดไป ถ้าผู้ใช้กด Stop ข้อความกลับไปที่ช่องพิมพ์
scenario:
  surface: vscode
  given:
    - turn ของแชตนี้กำลังทำงาน tool รันเสร็จหมดแล้ว และ model กำลัง stream คำตอบสุดท้ายโดยไม่เรียก tool อีก
    - ข้อความที่จะส่งไม่มีไฟล์แนบหรือ `@` mention
  trigger: >-
    ผู้ใช้พิมพ์ "แล้วอัปเดต README ด้วย" แล้วคลิก Send now หรือกด Cmd-Enter
  covers: [ctl.steer-missed-runs-next, ctl.steer-after-stop]
  related: [ctl.steer-delivered, ctl.queued-followup, ctl.stop-while-streaming, ctl.steer-refused]
  steps:
    - id: type
      lane: user
      beat:
        title: "คุณกด Send now ระหว่างคำตอบสุดท้าย"
        text: >-
          tool รันเสร็จหมดแล้ว และ model กำลังเขียนคำตอบสุดท้าย คุณพิมพ์ "แล้วอัปเดต README ด้วย" แล้วกด Send now
        from: you
        to: panel
        sees: { kind: message, from: geno, text: เพิ่มเทสต์ให้ parseDate แล้ว 3 กรณี, streaming: true }
      do: ผู้ใช้กด Send now ขณะที่ model ยังเขียนคำตอบอยู่
      phase: calling-model

    - id: steer
      lane: panel
      at: composer
      beat:
        title: "แผงขึ้นป้าย Sending now"
        text: >-
          ข้อความย้ายออกจากช่องพิมพ์ไปเป็นข้อความที่กำลังส่ง VS Code จำข้อความนี้ไว้แล้วส่งเป็น steer
        from: panel
        to: engine
        sees: "ช่องพิมพ์ว่าง ป้าย \"Sending now\" เหนือช่องพิมพ์"
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
      beat:
        title: "ข้อความรอใน inbox แต่ไม่มีรอบหน้า"
        text: >-
          engine ใส่ข้อความไว้ใน inbox ของ turn จุดที่มันจะเข้า turn ได้คือก่อนเรียก model ครั้งหน้า
          แต่คำตอบที่กำลังเขียนนี้จะไม่มีครั้งหน้า
        from: engine
        to: engine
      do: >-
        `steerRunning` ใส่ข้อความไว้ใน inbox ของ turn คำขอค้างอยู่ จุดปลอดภัยถัดไปคือก่อนการเรียก model ครั้งหน้า
        แต่คำตอบที่กำลัง stream จะไม่มีการเรียกครั้งหน้า
      ref: packages/engine/src/steer.ts#steerRunning

    - id: streaming
      lane: model
      beat:
        title: "Model เขียนต่อโดยไม่ถูกขัด"
        text: >-
          steer ไม่ขัดคำตอบที่กำลัง stream ลองเลือกว่า turn นี้จบอย่างไร
        from: model
        to: engine
        ask: "turn จบอย่างไร"
      do: >-
        model เขียนคำตอบต่อ steer ไม่ขัด stream
      ref: "packages/engine/src/drive.ts#\"onText: (delta) => watcher.text(delta),\""
      fork:
        ask: turn จบอย่างไร
        options:
          - id: ends
            label: model เขียนจนจบเอง
            steps:
              - lane: model
                beat:
                  title: "Model เขียนจนจบเอง"
                  text: >-
                    model จบคำตอบด้วย end_turn Geno จบ turn และย้ายข้อความที่ค้างไปเป็น turn ถัดไป
                  from: model
                  to: engine
                do: "model จบคำตอบด้วย `stop_reason: end_turn`"
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
                beat:
                  title: "Geno เริ่ม turn ใหม่ด้วยข้อความของคุณ"
                  text: >-
                    turn แรกไม่ได้ถูกหยุด engine จึงเริ่ม turn ใหม่ทันที โดยใช้ข้อความของคุณเป็น prompt ธรรมดา
                  from: engine
                  to: engine
                do: >-
                  `finally` ของ `runTurn` บอก `turnEnds` ว่า turn ไม่ได้ถูกหยุด แล้ว `steer` เรียก `prompt()` ด้วยข้อความเดิมที่ตัด
                  `STEER_META` ออก เป็น turn ใหม่ต่อจาก turn ที่จบ คำขอ steer เดิมจะได้คำตอบเมื่อ turn ใหม่นี้จบ
                ref: "packages/engine/src/serve.ts#\"return prompt({ ...params, _meta: meta });\""
                phase: starting
              - lane: editor
                at: chat
                beat:
                  title: "แชตขึ้น turn ใหม่ต่อจาก turn ที่จบ"
                  text: >-
                    ป้าย Sending now หายไป turn แรกจบตามปกติ แล้ว turn ใหม่เริ่มด้วยบับเบิลของข้อความที่คุณส่ง
                  from: panel
                  to: you
                  sees: { kind: message, from: you, text: แล้วอัปเดต README ด้วย }
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
                beat:
                  title: "Model อ่านข้อความเป็น prompt ใหม่"
                  text: >-
                    model เห็นข้อความของคุณเป็นคำขอของ turn ใหม่ ไม่ใช่ข้อความที่แทรกเข้ามาระหว่างทำงาน
                  from: engine
                  to: model
                  end: "กลายเป็น turn ถัดไป"

              - lane: model
                do: >-
                  model อ่านข้อความเป็น prompt ธรรมดาของ turn ใหม่ ไม่ใช่ข้อความ "sent while you were working"
                ref: "packages/engine/src/gateway.ts#\"stopReason: message.stop_reason,\""
                end: { turn: continues, reason: call-model }

          - id: stop
            label: ผู้ใช้กด Stop
            steps:
              - lane: user
                beat:
                  title: "คุณกด Stop ก่อนคำตอบจบ"
                  text: >-
                    คุณกด Stop แผงสั่ง engine ให้หยุด turn ทันที
                  from: you
                  to: panel
                do: ผู้ใช้กด Stop ก่อนคำตอบจบ
              - lane: editor
                at: chat
                do: >-
                  `Chat.stop` ส่ง notification ACP `session/cancel` engine abort turn
                ref: packages/extension/src/chat/chat.ts#Chat.stop
              - lane: loop
                at: drive
                beat:
                  title: "Geno หยุด turn และไม่เริ่ม turn ใหม่"
                  text: >-
                    Geno บันทึกว่าถูกหยุดแล้วจบ turn คุณเป็นคนหยุด Geno จึงไม่ส่งข้อความที่ค้างต่อเป็น turn ใหม่ เหมือนข้อความ
                    Queued ที่ Stop คืนให้คุณ
                  from: engine
                  to: engine
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
                beat:
                  title: "VS Code ปิดข้อความที่ค้างว่าไม่ได้ส่ง"
                  text: >-
                    turn จบแบบ stopped VS Code ปิดข้อความที่ค้างว่าไม่ได้ส่ง ก่อนที่คำปฏิเสธของ engine จะมาถึง
                  from: panel
                  to: panel
                do: >-
                  turn ได้คำตอบ `cancelled` แผงได้ `turn-end` สถานะ `stopped` แล้ว `SteerHost.turnEnded` ปิดข้อความที่ค้างเป็น `failed`
                  ("The turn was stopped, so this did not send") ก่อนที่ error ของ engine จะมาถึง
                ref: packages/extension/src/chat/steer-host.ts#SteerHost.turnEnded
                emits: [turn-end, steered]
              - lane: panel
                at: composer
                beat:
                  title: "ข้อความกลับไปที่ช่องพิมพ์"
                  text: >-
                    ไม่มี turn ทำงานแล้ว แผงจึงคืนข้อความไปที่ช่องพิมพ์ถ้าช่องยังว่าง ป้าย Sending now แค่หายไป ไม่มีข้อความอธิบาย
                  from: panel
                  to: you
                  end: "คุณหยุด ข้อความกลับมา"
                  sees: { kind: composer, state: idle, text: แล้วอัปเดต README ด้วย }
                do: >-
                  `followupSteered` เห็นว่าไม่มี turn ทำงานแล้ว จึงคืนข้อความกลับไปที่ช่องพิมพ์ (ถ้าช่องพิมพ์ยังว่าง)
                  ข้อความ "did not send" ไม่ขึ้นที่ไหน ป้าย "Sending now" แค่หายไป
                sees: >-
                  ท้าย turn ขึ้น "Stopped by you" ป้าย "Sending now" หายไป และ "แล้วอัปเดต README ด้วย" กลับมาอยู่ในช่องพิมพ์
                ref: packages/extension/src/chat/steer-model.ts#followupSteered
                end: { turn: stopped, reason: cancelled }
---

steer ส่งถึงได้เฉพาะที่จุดปลอดภัยก่อนการเรียก model ถ้า model กำลังเขียนคำตอบสุดท้าย จะไม่มีจุดนั้นอีกใน turn นี้
engine ไม่ทิ้งข้อความ แต่ถือไว้จนรู้ว่า turn จบอย่างไร ดูทางที่ส่งถึงได้ทันที่ [ส่งข้อความแทรก (steer) เข้า turn ที่กำลังทำงาน](/scenarios/ctl/steer-delivered/)

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

steer ที่ไม่ได้ออกจากแผงเลย ดู [Steer ที่ไม่ถูกส่ง](/scenarios/ctl/steer-refused/)
