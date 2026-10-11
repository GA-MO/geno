---
title: stop reason ที่ไม่ใช่การจบหรือการเรียกเครื่องมือ
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

    - id: answer
      lane: model
      do: >-
        โมเดล stream คำตอบออกมา gateway เก็บ stop reason ของผู้ให้บริการไว้ตามที่ได้มา
      ref: "packages/engine/src/gateway.ts#\"stopReason: message.stop_reason,\""

    - use: answer-streams

    - id: decide
      lane: loop
      at: step
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
                do: >-
                  `pause_turn` แปลว่าผู้ให้บริการพัก turn ที่ยาวไว้กลางทาง (เกิดกับเครื่องมือฝั่งเซิร์ฟเวอร์ของ Anthropic)
                  `AFTER_STOP.pause_turn` เป็น `call-model` ไม่มีอะไรถูกตอบแทนโมเดล คำขอถัดไปมีคำตอบที่พักไว้อยู่ท้าย history
                ref: packages/core/src/loop.ts#AFTER_STOP
                emits: [pause_turn, call-model]
              - use: model-call
              - lane: model
                do: >-
                  ผู้ให้บริการทำ turn ที่พักไว้ต่อจากจุดเดิม การเรียกนี้นับเป็นหนึ่งใน 40 ครั้งของรอบเหมือนการเรียกอื่น
                ref: "packages/engine/src/gateway.ts#\"stopReason: message.stop_reason,\""
                end: { turn: continues, reason: call-model }

          - id: malformed
            label: tool_use ที่ไม่มีการเรียก หรือไม่มี stop reason
            steps:
              - lane: loop
                at: step
                do: >-
                  `tool_use` ที่ไม่มีบล็อก `tool_use` เหลือให้รัน ได้ `AFTER_STOP.tool_use` ซึ่งเป็น `done(error)`
                  คำตอบที่ stop reason เป็น `null` ก็ได้ `done(error)` เช่นกัน loop ไม่เดาว่าโมเดลตั้งใจจบหรือยังไม่จบ
                ref: packages/core/src/loop.ts#AFTER_EVENT
                emits: [tool_use, error]
                phase: ending
              - use: mstop-fails-quietly
              - lane: panel
                at: rail
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
