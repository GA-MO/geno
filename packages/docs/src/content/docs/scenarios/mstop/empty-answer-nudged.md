---
title: "Model จบ turn เปล่า Geno กระตุ้นหนึ่งครั้ง"
description: model จบคำตอบด้วย end_turn โดยไม่มีข้อความและไม่เรียก tool loop บันทึกคำกระตุ้นแล้วเรียก model อีกครั้ง ถ้าเปล่าซ้ำ turn จบแบบ failed
scenario:
  surface: vscode
  given:
    - ผู้ใช้ส่งข้อความในแผงแชตของ VS Code และ turn กำลังทำงาน
    - ยังไม่ถึงขีดจำกัดของรอบ (40 ครั้ง และ $0.40)
  trigger: >-
    model คิดแล้วจบคำตอบด้วย `stop_reason: end_turn` โดยมีแต่บล็อกความคิด ไม่มีข้อความและไม่มี `tool_use`
  covers: [mstop.empty-answer-nudged]
  related: [mstop.no-reply-continue-retry, turn.text-answer, mstop.limit-max-turns]
  steps:
    - id: empty
      lane: model
      beat:
        title: "Model จบคำตอบโดยไม่มีข้อความ"
        text: >-
          model คิดอยู่พักหนึ่ง แล้วจบคำตอบด้วย `stop_reason` เป็น `end_turn` (`stop_reason` คือ field ท้ายคำตอบที่บอกว่า
          model หยุดเพราะอะไร `end_turn` แปลว่าตอบจบแล้ว) แต่ไม่มีข้อความให้อ่าน และไม่ขอใช้ tool
          การ์ดข้างล่างเป็นคำตอบเปล่าจริงจากการรันหนึ่ง ดู `type` ที่ไฮไลต์ไว้ มันเป็น `thinking` และเป็นบล็อกเดียวใน `content`
          ไม่มีบล็อก `text` หรือ `tool_use` เลย
        from: model
        to: engine
        sees:
          kind: payload
          source: docs/results/real-usecases/runs/A29-thai-big-create/2/session.jsonl#seq=16
          select: content
          highlight: ['[0].type']
      do: >-
        model ส่งบล็อกความคิดออกมาแล้วจบด้วย `end_turn` ไม่มีข้อความที่ไม่ว่าง และไม่ขอเรียก tool
      ref: "packages/engine/src/gateway.ts#\"stopReason: message.stop_reason,\""
      emits: [end_turn]
      phase: calling-model

    - id: logged
      lane: loop
      at: drive
      beat:
        title: "แชตยังขึ้นแค่ Thinking"
        text: >-
          Geno บันทึกคำตอบนี้ตามปกติ ความคิดของ model ไม่แสดงเป็นข้อความ คุณจึงยังเห็นแค่แถว Thinking
        from: panel
        to: you
        sees: { kind: composer, state: working, header: working }
      do: >-
        `drive` บันทึก event `assistant` ตามปกติ ความคิดไม่เคยแสดงเป็นข้อความในแผง ผู้ใช้จึงยังเห็นแค่แถว "Thinking"
      ref: "packages/engine/src/drive.ts#\"await record({ kind: 'assistant', seq: nextSeq(events), at, ...result.turn\""
      emits: [assistant]

    - id: answerless
      lane: loop
      at: step
      beat:
        title: "Geno เห็นว่าคำตอบนี้ไม่มีอะไรให้อ่าน"
        text: >-
          ปกติ `end_turn` แปลว่า turn จบ แต่คำตอบนี้ไม่มีอะไรให้คุณอ่าน Geno จึงเลือกกระตุ้นแทนการจบ
          การกระตุ้น (nudge) คือ Geno ต่อข้อความสั้นๆ ท้ายบทสนทนาเพื่อบอก model ให้ทำต่อ Geno กระตุ้นได้ครั้งเดียวติดกัน
          และคำตอบนี้ไม่ได้ตามหลังคำกระตุ้น
        from: engine
        to: engine
      do: >-
        `loopStep` เห็นว่า `end_turn` ให้ `done(end_turn)` แต่ `answerless` บอกว่าคำตอบนี้ไม่มีอะไรให้ผู้ใช้อ่าน
        event ก่อนหน้าไม่ใช่คำกระตุ้นแบบเปล่า และยังไม่ถึงขีดจำกัด จึงตัดสิน `nudge` แบบ `empty` แทนการจบ
      ref: packages/core/src/loop.ts#answerless
      emits: [nudge]

    - id: nudge
      lane: loop
      at: drive
      beat:
        title: "Geno เขียนคำกระตุ้นลงบันทึก"
        text: >-
          Geno บันทึกคำกระตุ้นที่บอก model ว่าคำตอบที่แล้วว่าง ให้ทำต่อหรือเขียนคำตอบ คำกระตุ้นนี้ไม่ขึ้นในแชต
          คุณเห็นแค่ว่า turn ยังทำงานต่อ
        from: engine
        to: engine
      do: >-
        `drive` บันทึก event `report-nudge` ที่มี `empty: true` server ไม่ส่ง event ชนิดนี้ให้ editor แผงจึงไม่เห็นอะไรเปลี่ยน
        แต่คำขอถัดไปจะมีข้อความ `EMPTY_TURN_NUDGE` ต่อท้าย ("Your last response ended with no text and no tool call...")
      ref: "packages/engine/src/drive.ts#\"await record({ kind: 'report-nudge'\""
      emits: [report-nudge]

    - use: model-call
      beat:
        title: "Geno เรียก model อีกรอบ"
        text: >-
          คำขอรอบนี้มีคำกระตุ้นต่อท้ายบทสนทนา การเรียกนี้นับเป็นหนึ่งในขีดจำกัดของ turn เหมือนการเรียกอื่น
          การ์ดข้างล่างมาจากการบันทึกที่รัน Geno จริงกับ model จำลองที่ตอบตามบทที่เขียนไว้ก่อน ไม่ใช่การรันเดียวกับการ์ดแรก ดูสองข้อความท้ายที่ไฮไลต์ไว้ ข้อความ `assistant` คือคำตอบเปล่าที่มีแต่ `thinking`
          ข้อความสุดท้ายคือคำกระตุ้นที่ขึ้นต้นด้วย "[Geno] Your last response ended with no text and no tool call"
        from: engine
        to: model
        sees:
          kind: payload
          source: packages/docs/src/data/recorded/empty-answer-nudged.jsonl#line=4
          select: messages
          collapse: ['[0]']
          highlight: ['[1]', '[2]']

    - id: again
      lane: model
      beat:
        title: "Model ตอบอีกครั้ง"
        text: >-
          model อ่านคำกระตุ้นแล้วตอบใหม่ ลองเลือกว่ารอบนี้มีข้อความหรือยังเปล่าอยู่
          การ์ดข้างล่างมาจากการบันทึกเดียวกับการ์ดก่อน ซึ่ง model ทำตามที่คิดไว้: เขียนข้อความสั้นๆ แล้วขอ `read` ไฟล์ `src/version.ts`
          ดู `type` ที่ไฮไลต์ รอบนี้ block แรกเป็น `text` เลย ไม่มี `thinking` นำหน้า
        from: model
        to: engine
        sees:
          kind: payload
          source: packages/docs/src/data/recorded/empty-answer-nudged.jsonl#line=5
          select: '[1]'
          highlight: [data.content_block.type]
        ask: "รอบนี้มีข้อความไหม"
      do: >-
        model อ่านคำกระตุ้นแล้วตอบอีกครั้ง
      ref: "packages/engine/src/gateway.ts#\"stopReason: message.stop_reason,\""
      fork:
        ask: คำตอบรอบที่สองมีข้อความหรือการเรียก tool ไหม
        options:
          - id: answered
            label: มีข้อความ
            steps:
              - use: answer-streams
                beat:
                  title: "คำตอบขึ้นในแชต"
                  text: >-
                    model เขียนคำตอบออกมา ข้อความค่อยๆ ขึ้นในแชตเหมือน turn ปกติ ในการบันทึก model อ่าน `src/version.ts` ก่อน
                    แล้วจึงตอบจากสิ่งที่อ่านได้
                  from: engine
                  to: panel
                  sees: { kind: message, from: geno, text: "parseVersion returns [0, 0, 0] for an empty string (src/version.ts:2).", streaming: true }

              - use: turn-ends
                beat:
                  title: "Turn จบ"
                  text: >-
                    Geno จบ turn ตามปกติ ปุ่ม Send กลับมาแทน Stop
                  from: engine
                  to: panel
                  end: "Model ตอบ turn จบ"
                  sees: { kind: composer, state: idle }

          - id: empty-again
            label: เปล่าอีกครั้ง
            steps:
              - lane: loop
                at: step
                beat:
                  title: "เปล่าอีกครั้ง Geno เลิกกระตุ้น"
                  text: >-
                    คำตอบรอบนี้ก็เปล่าอีก และสิ่งที่อยู่ก่อนหน้าคือคำกระตุ้น Geno จึงไม่กระตุ้นซ้ำ แต่จบ turn แบบ error
                  from: engine
                  to: engine
                do: >-
                  `loopStep` เห็นคำตอบเปล่าอีกครั้ง และ event ก่อนหน้าคือคำกระตุ้นแบบเปล่า จึงตัดสิน `done(error)`
                  ไม่กระตุ้นซ้ำเป็นครั้งที่สอง
                ref: packages/core/src/loop.ts#loopStep
                emits: [error]
                phase: ending
              - lane: loop
                at: drive
                beat:
                  title: "เหตุผลไปอยู่แค่ใน output channel"
                  text: >-
                    Geno ไม่บันทึก error ลงบันทึกของ session เหตุผลถูกเขียนลง output channel "Geno engine" เท่านั้น
                    (ช่องในแผง Output ของ VS Code ที่รับข้อความ log ของ engine) แผงแชตรู้แค่ว่า turn ล้มเหลว
                  from: engine
                  to: panel
                do: >-
                  `finish` ไม่บันทึก event `error` เพราะไม่ใช่ขีดจำกัด มันแค่เขียนลง stderr ของ engine
                  ("the model ended its turn twice with no text and no tool call...") ซึ่งไปอยู่ใน output channel "Geno engine"
                ref: packages/engine/src/drive.ts#finish
              - lane: server
                at: turns
                do: >-
                  `runTurn` แปลง `error` ด้วย `TURN_ENDS`: ACP ได้ `stopReason: end_turn` แต่ meta บอกว่างานจบแบบ `failed`
                ref: packages/engine/src/serve.ts#TURN_ENDS
                emits: [TURN_END_META, failed]
              - lane: editor
                at: chat
                do: >-
                  `turnEndOf` เชื่อ meta มากกว่า stop reason `prompt()` จึงส่ง action `turn-end` สถานะ `failed`
                  stop reason `end_turn` ไม่มีข้อความใน `STOP_MESSAGES` จึงไม่มีบล็อก error
                ref: "packages/extension/src/chat/chat.ts#\"const status = turnEndOf(response);\""
                emits: [turn-end]
              - lane: panel
                at: rail
                beat:
                  title: "แชตขึ้นว่า Geno หยุดโดยไม่มีคำตอบ"
                  text: >-
                    แผงเห็นว่าไม่มีข้อความ ไม่มีบล็อก error ในแชต และคุณไม่ได้กด Stop จึงบอกว่าคำตอบสุดท้ายไม่มีข้อความ
                    และให้ปุ่มทำต่อหรือลองใหม่
                  from: panel
                  to: you
                  end: "เปล่าสองครั้ง turn ล้มเหลว"
                  sees: { kind: notice, text: Geno stopped without a reply, detail: Its last reply had no text., actions: [ Continue, Retry ], tone: warning }
                do: >-
                  `missingReply` เห็นว่าไม่มีข้อความ ไม่มีบล็อก error ไม่ได้ถูกหยุด และขั้นสุดท้ายไม่ได้ถูกปฏิเสธ
                  จึงให้เหตุผลว่าคำตอบสุดท้ายไม่มีข้อความ
                sees: >-
                  หัวข้อ "failed after ..." กล่อง "Geno stopped without a reply · Its last reply had no text."
                  พร้อมปุ่ม [Continue] [Retry] และท้าย turn ขึ้น "Failed"
                ref: packages/extension/src/chat/rail.ts#missingReply
                end: { turn: failed, reason: error }
---

คำตอบที่มีแต่ความคิด ([thinking](/start/glossary/)) ไม่ใช่คำตอบ ผู้ใช้ไม่เห็นอะไรเลย Geno จึงไม่ถือว่า turn จบ
แต่บอก model หนึ่งครั้งว่าคำตอบที่แล้วว่าง ให้ทำต่อหรือเขียนคำตอบ ความหมายของ `stop_reason` และ turn ดูที่[คำศัพท์](/start/glossary/)

สิ่งที่ควรสังเกต

- **คำกระตุ้นมองไม่เห็นในแผง** event `report-nudge` อยู่ใน log และในคำขอถัดไป แต่ server ไม่แปลงมันเป็นอัปเดต
  ผู้ใช้เห็นแค่ว่า turn ยังทำงานต่อ ดูได้จาก `gcode session` ซึ่งเขียนว่า "the model ended a turn with no text and no tool call and was nudged once"
- **ครั้งที่สองจบแบบ failed โดยไม่มีบล็อก error** `finish` บันทึก error เฉพาะขีดจำกัด เหตุผลจึงอยู่แค่ใน stderr ของ engine
  แผงบอกผู้ใช้ผ่านกล่อง "Geno stopped without a reply" แทน
- **ขีดจำกัดมาก่อนคำกระตุ้น** ถ้าคำตอบเปล่ามาตอนที่ใช้ครบ 40 ครั้งแล้ว `loopStep` จบด้วย `max-turns` แทนการกระตุ้น
  ดู [ครบ 40 ครั้งของการเรียก model](/scenarios/mstop/limits/)
