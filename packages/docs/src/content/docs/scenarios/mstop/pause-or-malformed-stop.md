---
title: "Model จบด้วย stop reason ที่ไม่ใช่การตอบหรือเรียก tool"
description: ผู้ให้บริการพัก turn ด้วย pause_turn แล้ว Geno เรียกต่อทันที หรือคำตอบบอก tool_use โดยไม่มีการเรียก หรือไม่มี stop reason เลย ซึ่งจบ turn แบบ failed
tableOfContents: false
sidebar:
  order: 6
scenario:
  surface: vscode
  given:
    - ผู้ใช้ส่งข้อความในแผงแชตของ VS Code และ turn กำลังทำงาน
    - ยังไม่ถึงขีดจำกัดของรอบ (40 ครั้ง และ $0.40)
  trigger: >-
    คำตอบของโมเดลจบด้วย stop reason ที่ไม่ใช่ `end_turn` และไม่ใช่ `tool_use` ที่มีบล็อก `tool_use` ตามมา
  covers: [mstop.pause-turn, mstop.tool-use-without-calls]
  related: [mstop.max-tokens-text, mstop.refusal, mstop.empty-answer-nudged, turn.with-tools]
  steps:
    - use: model-call
      beat:
        title: "Geno ส่งบทสนทนาให้ model"
        text: >-
          turn กำลังทำงาน Geno ตรวจขีดจำกัดของ turn แล้วส่งคำขอให้โมเดลตามปกติ
        to: model

    - id: answer
      lane: model
      beat:
        title: "Model ตอบแล้วจบด้วย stop reason แปลกๆ"
        text: >-
          โมเดลเขียนคำตอบออกมา ข้อความขึ้นในแชตทีละส่วน แต่สัญญาณท้ายคำตอบไม่ใช่ end_turn และไม่ใช่ tool_use
          ที่มีการเรียก tool ตามมา
        sees: { kind: message, from: geno, text: กำลังดูโครงสร้างของโปรเจกต์, streaming: true }
      do: >-
        โมเดล stream คำตอบออกมา gateway เก็บ stop reason ของผู้ให้บริการไว้ตามที่ได้มา
      ref: "packages/engine/src/gateway.ts#\"stopReason: message.stop_reason,\""

    - use: answer-streams

    - id: decide
      lane: loop
      at: step
      beat:
        title: "Geno ดู stop reason ว่าทำอะไรต่อ"
        text: >-
          Geno ตัดสินขั้นต่อไปจาก stop reason ของคำตอบล่าสุดด้วยตาราง ทุก stop reason มีแถวของมัน
          ลองเลือกว่าคำตอบนี้จบด้วยอะไร
        ask: "stop reason อะไร"
      do: >-
        `loopStep` อ่านคำตอบล่าสุด ไม่มี `tool_use` ค้าง จึงถาม `AFTER_EVENT.assistant` ว่าหลัง stop reason นี้ทำอะไรต่อ
      ref: packages/core/src/loop.ts#AFTER_EVENT
      fork:
        ask: คำตอบจบด้วย stop reason อะไร
        options:
          - id: pause
            label: pause_turn
            steps:
              - lane: loop
                at: step
                beat:
                  title: "ผู้ให้บริการพัก turn ไว้ Geno เรียกต่อ"
                  text: >-
                    pause_turn แปลว่าผู้ให้บริการพัก turn ที่ยาวไว้กลางทาง Geno เรียกโมเดลต่อทันทีโดยไม่ตอบอะไรแทน
                    คำขอถัดไปมีคำตอบที่พักไว้อยู่ท้ายบทสนทนา
                  to: model
                do: >-
                  `pause_turn` แปลว่าผู้ให้บริการพัก turn ที่ยาวไว้กลางทาง (เกิดกับเครื่องมือฝั่งเซิร์ฟเวอร์ของ Anthropic)
                  `AFTER_STOP.pause_turn` เป็น `call-model` ไม่มีอะไรถูกตอบแทนโมเดล คำขอถัดไปมีคำตอบที่พักไว้อยู่ท้าย history
                ref: packages/core/src/loop.ts#AFTER_STOP
                emits: [pause_turn, call-model]
              - use: model-call
              - lane: model
                beat:
                  title: "Model ทำต่อจากจุดเดิม"
                  text: >-
                    ผู้ให้บริการทำ turn ที่พักไว้ต่อ ในแชตคุณเห็นแค่ข้อความที่ขึ้นต่อไป การเรียกนี้นับเป็นหนึ่งในขีดจำกัดของ turn
                  end: "turn ทำต่อ"
                do: >-
                  ผู้ให้บริการทำ turn ที่พักไว้ต่อจากจุดเดิม การเรียกนี้นับเป็นหนึ่งใน 40 ครั้งของรอบเหมือนการเรียกอื่น
                ref: "packages/engine/src/gateway.ts#\"stopReason: message.stop_reason,\""
                end: { turn: continues, reason: call-model }

          - id: malformed
            label: tool_use ที่ไม่มีการเรียก หรือไม่มี stop reason
            steps:
              - lane: loop
                at: step
                beat:
                  title: "Geno ไม่เดา จึงจบ turn"
                  text: >-
                    คำตอบบอก tool_use แต่ไม่มี tool ให้รัน หรือไม่มี stop reason เลย Geno ไม่เดาว่าโมเดลตั้งใจจบหรือยัง จึงจบ turn
                    แบบ error
                do: >-
                  `tool_use` ที่ไม่มีบล็อก `tool_use` เหลือให้รัน ได้ `AFTER_STOP.tool_use` ซึ่งเป็น `done(error)`
                  คำตอบที่ stop reason เป็น `null` ก็ได้ `done(error)` เช่นกัน loop ไม่เดาว่าโมเดลตั้งใจจบหรือยังไม่จบ
                ref: packages/core/src/loop.ts#AFTER_EVENT
                emits: [tool_use, error]
                phase: ending
              - use: mstop-fails-quietly
                beat:
                  title: "เหตุผลไปอยู่แค่ใน output channel"
                  text: >-
                    Geno ไม่บันทึก error ลงบันทึกของ session เหตุผลถูกเขียนลง output channel "Geno engine" เท่านั้น แผงรู้แค่ว่า
                    turn ล้มเหลว
                  to: panel

              - lane: panel
                at: rail
                beat:
                  title: "หัวข้อขึ้น failed โดยไม่มีแถบ error"
                  text: >-
                    ถ้าคำตอบมีข้อความ แผงไม่แสดงอะไรเพิ่ม คุณเห็นแค่คำว่า Failed ถ้าไม่มีข้อความ
                    แผงขึ้นประกาศพร้อมปุ่มทำต่อหรือลองใหม่
                  end: "turn ล้มเหลว"
                  sees: { kind: notice, text: Geno stopped without a reply, detail: Its last reply had no text., actions: [ Continue, Retry ], tone: warning }
                do: >-
                  `headerOf` เปลี่ยนหัวข้อเป็น "failed after ..." ถ้ามีข้อความหลังขั้นสุดท้าย `missingReply` ไม่แสดงอะไรเพิ่ม
                  ถ้าไม่มี จะแสดงประกาศว่าคำตอบสุดท้ายไม่มีข้อความ
                sees: >-
                  หัวข้อ "failed after 19s" ท้าย turn ขึ้น "Failed" ไม่มีแถบ error และถ้าคำตอบไม่มีข้อความ
                  ขึ้นกล่อง "Geno stopped without a reply · Its last reply had no text." พร้อมปุ่ม [Continue] [Retry]
                ref: packages/extension/src/chat/rail.ts#missingReply
                end: { turn: failed, reason: error }
---

`loopStep` ตัดสินขั้นต่อไปจาก stop reason ของคำตอบล่าสุดด้วยตาราง `AFTER_STOP` ทุก stop reason ของ Anthropic มีแถวของมัน

| stop reason | ขั้นต่อไป | หน้า |
| --- | --- | --- |
| `end_turn`, `stop_sequence` | จบ (`done`) | [ถามแล้วได้คำตอบเป็นข้อความ](/scenarios/turn/text-answer/) |
| `tool_use` ที่มีการเรียก | รันเครื่องมือ | [โมเดลเรียกเครื่องมือแล้วตอบ](/scenarios/turn/with-tools/) |
| `pause_turn` | เรียกโมเดลอีกครั้ง | หน้านี้ |
| `tool_use` ที่ไม่มีการเรียก, ไม่มี stop reason | `failed` | หน้านี้ |
| `max_tokens` | `failed` หรือลองใหม่หนึ่งครั้ง | [คำตอบชนเพดาน output](/scenarios/mstop/max-tokens/) |
| `refusal` | `failed` | [โมเดลปฏิเสธ](/scenarios/mstop/refusal/) |
| `model_context_window_exceeded` | สรุปบริบทแล้วส่งใหม่ | [context เกินหน้าต่าง](/scenarios/ctx/overflow-compact-resend/) |

สิ่งที่ควรสังเกต

- **`pause_turn` ไม่มีผลที่ผู้ใช้เห็น** การเรียกครั้งที่สองต่อจากคำตอบเดิม แผงเห็นเป็นข้อความที่ stream ต่อไปเท่านั้น
- **ทางที่ล้มไม่มีเหตุผลในแผง** เหมือน [คำตอบชนเพดาน output](/scenarios/mstop/max-tokens/) เหตุผล
  ("error: the model stopped with tool_use" หรือ "error: the model stopped with no stop reason") อยู่ใน output channel "Geno engine" เท่านั้น

อ่านต่อที่ [คำตอบของ model ชนเพดาน output](/scenarios/mstop/max-tokens/) ซึ่งล้มแบบเงียบเหมือนกัน
