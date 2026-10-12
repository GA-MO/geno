---
title: "Model จบ turn เปล่า Geno กระตุ้นหนึ่งครั้ง"
description: โมเดลจบคำตอบด้วย end_turn โดยไม่มีข้อความและไม่เรียก tool loop บันทึกคำกระตุ้นแล้วเรียกโมเดลอีกครั้ง ถ้าเปล่าซ้ำ turn จบแบบ failed
tableOfContents: false
sidebar:
  order: 2
scenario:
  surface: vscode
  given:
    - ผู้ใช้ส่งข้อความในแผงแชตของ VS Code และ turn กำลังทำงาน
    - ยังไม่ถึงขีดจำกัดของรอบ (40 ครั้ง และ $0.40)
  trigger: >-
    โมเดลคิดแล้วจบคำตอบด้วย `stop_reason: end_turn` โดยมีแต่บล็อกความคิด ไม่มีข้อความและไม่มี `tool_use`
  covers: [mstop.empty-answer-nudged]
  related: [mstop.no-reply-continue-retry, turn.text-answer, mstop.limit-max-turns]
  steps:
    - id: empty
      lane: model
      beat:
        title: "Model จบคำตอบโดยไม่มีข้อความ"
        text: >-
          โมเดลคิดอยู่พักหนึ่ง แล้วจบคำตอบด้วยสัญญาณ end_turn โดยไม่มีข้อความให้อ่าน และไม่ขอใช้ tool
        from: model
        to: engine
      do: >-
        โมเดลส่งบล็อกความคิดออกมาแล้วจบด้วย `end_turn` ไม่มีข้อความที่ไม่ว่าง และไม่ขอเรียกเครื่องมือ
      ref: "packages/engine/src/gateway.ts#\"stopReason: message.stop_reason,\""
      emits: [end_turn]
      phase: calling-model

    - id: logged
      lane: loop
      at: drive
      beat:
        title: "แชตยังขึ้นแค่ Thinking"
        text: >-
          Geno บันทึกคำตอบนี้ตามปกติ ความคิดของโมเดลไม่แสดงเป็นข้อความ คุณจึงยังเห็นแค่แถว Thinking
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
          ปกติ end_turn แปลว่า turn จบ แต่คำตอบนี้ไม่มีอะไรให้คุณอ่าน และ Geno ยังไม่เคยกระตุ้นโมเดลใน turn นี้
          จึงเลือกกระตุ้นแทนการจบ
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
          Geno บันทึกคำกระตุ้นที่บอกโมเดลว่าคำตอบที่แล้วว่าง ให้ทำต่อหรือเขียนคำตอบ คำกระตุ้นนี้ไม่ขึ้นในแชต
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
        from: engine
        to: model

    - id: again
      lane: model
      beat:
        title: "Model ตอบอีกครั้ง"
        text: >-
          โมเดลอ่านคำกระตุ้นแล้วตอบใหม่ ลองเลือกว่ารอบนี้มีข้อความหรือยังเปล่าอยู่
        from: model
        to: engine
        ask: "รอบนี้มีข้อความไหม"
      do: >-
        โมเดลอ่านคำกระตุ้นแล้วตอบอีกครั้ง
      ref: "packages/engine/src/gateway.ts#\"stopReason: message.stop_reason,\""
      fork:
        ask: คำตอบรอบที่สองมีข้อความหรือการเรียกเครื่องมือไหม
        options:
          - id: answered
            label: มีข้อความ
            steps:
              - use: answer-streams
                beat:
                  title: "คำตอบขึ้นในแชต"
                  text: >-
                    โมเดลเขียนคำตอบออกมา ข้อความค่อยๆ ขึ้นในแชตเหมือน turn ปกติ
                  from: engine
                  to: panel
                  sees: { kind: message, from: geno, text: เพิ่มเทสต์ให้ parseDate แล้ว 3 กรณี, streaming: true }

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
                    Geno ไม่บันทึก error ลงบันทึกของ session เหตุผลถูกเขียนลง output channel "Geno engine" เท่านั้น แผงรู้แค่ว่า
                    turn ล้มเหลว
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
                    แผงเห็นว่าไม่มีข้อความ ไม่มี error และคุณไม่ได้กด Stop จึงบอกว่าคำตอบสุดท้ายไม่มีข้อความ
                    และให้ปุ่มทำต่อหรือลองใหม่
                  from: panel
                  to: you
                  end: "เปล่าสองครั้ง turn ล้มเหลว"
                  sees: { kind: notice, text: Geno stopped without a reply, detail: Its last reply had no text., actions: [ Continue, Retry ], tone: warning }
                do: >-
                  `missingReply` เห็นว่าไม่มีข้อความ ไม่มีบล็อก error ไม่ได้ถูกหยุด และขั้นสุดท้ายไม่ได้ถูกปฏิเสธ
                  จึงให้เหตุผลว่าคำตอบสุดท้ายไม่มีข้อความ
                sees: >-
                  หัวข้อ "failed after 14s" กล่อง "Geno stopped without a reply · Its last reply had no text."
                  พร้อมปุ่ม [Continue] [Retry] และท้าย turn ขึ้น "Failed"
                ref: packages/extension/src/chat/rail.ts#missingReply
                end: { turn: failed, reason: error }
---

คำตอบที่มีแต่ความคิดไม่ใช่คำตอบ ผู้ใช้ไม่เห็นอะไรเลย Geno จึงไม่ถือว่า turn จบ
แต่บอกโมเดลหนึ่งครั้งว่าคำตอบที่แล้วว่าง ให้ทำต่อหรือเขียนคำตอบ

สิ่งที่ควรสังเกต

- **คำกระตุ้นมองไม่เห็นในแผง** event `report-nudge` อยู่ใน log และในคำขอถัดไป แต่ server ไม่แปลงมันเป็นอัปเดต
  ผู้ใช้เห็นแค่ว่า turn ยังทำงานต่อ ดูได้จาก `gcode session` ซึ่งเขียนว่า "the model ended a turn with no text and no tool call and was nudged once"
- **ครั้งที่สองจบแบบ failed โดยไม่มีบล็อก error** `finish` บันทึก error เฉพาะขีดจำกัด เหตุผลจึงอยู่แค่ใน stderr ของ engine
  แผงบอกผู้ใช้ผ่านกล่อง "Geno stopped without a reply" แทน
- **ขีดจำกัดมาก่อนคำกระตุ้น** ถ้าคำตอบเปล่ามาตอนที่ใช้ครบ 40 ครั้งแล้ว `loopStep` จบด้วย `max-turns` แทนการกระตุ้น
  ดู [ครบ 40 ครั้งของการเรียกโมเดล](/scenarios/mstop/limits/)
