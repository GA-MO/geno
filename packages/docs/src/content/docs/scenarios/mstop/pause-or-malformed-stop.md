---
title: "Model จบด้วย stop reason ที่ไม่ใช่การตอบหรือเรียก tool"
description: ผู้ให้บริการพัก turn ด้วย pause_turn แล้ว Geno เรียกต่อทันที หรือคำตอบบอก tool_use โดยไม่มีการเรียก หรือไม่มี stop reason เลย ซึ่งจบ turn แบบ failed
scenario:
  surface: vscode
  given:
    - ผู้ใช้ส่งข้อความในแผงแชตของ VS Code และ turn กำลังทำงาน
    - ยังไม่ถึงขีดจำกัดของรอบ (40 ครั้ง และ $0.40)
  trigger: >-
    คำตอบของ model จบด้วย stop reason ที่ไม่ใช่ `end_turn` และไม่ใช่ `tool_use` ที่มีบล็อก `tool_use` ตามมา
  covers: [mstop.pause-turn, mstop.tool-use-without-calls]
  related: [mstop.max-tokens-text, mstop.refusal, mstop.empty-answer-nudged, turn.with-tools]
  steps:
    - use: model-call
      beat:
        title: "Geno ส่งบทสนทนาให้ model"
        text: >-
          turn กำลังทำงาน Geno ตรวจขีดจำกัดของ turn แล้วส่งคำขอให้ model ตามปกติ
          การ์ดข้างล่างมาจากการบันทึกที่รัน Geno จริงกับ model จำลองที่ตอบตามบทที่เขียนไว้ก่อน ดูข้อความของคุณที่ไฮไลต์ไว้ท้ายข้อความแรก
        from: engine
        to: model
        sees:
          kind: payload
          source: packages/docs/src/data/recorded/pause-or-malformed-stop.jsonl#line=2
          select: messages[0]
          highlight: ['content[1].text']

    - id: answer
      lane: model
      beat:
        title: "Model จบด้วย stop reason ที่ไม่ใช่ end_turn"
        text: >-
          model เขียนคำตอบออกมา ข้อความขึ้นในแชตทีละส่วน ท้ายคำตอบมี field `stop_reason` ที่บอกว่า model หยุดเพราะอะไร
          ปกติมันเป็น `end_turn` (ตอบจบแล้ว) หรือ `tool_use` (รอผลของ tool ที่ขอเรียก) แต่รอบนี้ไม่ใช่ทั้งสองแบบ
          หรือเป็น `tool_use` แต่ไม่มีการเรียก tool ตามมา
          แท็บแรกคือข้อความของคำตอบที่จบด้วย `pause_turn` ตามที่ขึ้นในแชต
          แท็บสองและสามมาจากการบันทึกเดียวกับการ์ดก่อน แท็บสองคือท้าย stream ของคำตอบที่จบด้วย `pause_turn`
          แท็บสามคือท้าย stream ของคำตอบอีก turn หนึ่งที่ `stop_reason` เป็น `tool_use` แต่ stream นั้นมีแค่ block `text` ไม่มี block `tool_use`
        from: model
        to: engine
        sees:
          - { kind: message, from: geno, text: Looking at how the project is laid out., streaming: true }
          - kind: payload
            source: packages/docs/src/data/recorded/pause-or-malformed-stop.jsonl#line=3
            select: '[-2]'
            highlight: [data.delta.stop_reason]
          - kind: payload
            source: packages/docs/src/data/recorded/pause-or-malformed-stop.jsonl#line=9
            select: '[-2]'
            highlight: [data.delta.stop_reason]
      do: >-
        model stream คำตอบออกมา gateway เก็บ stop reason ของผู้ให้บริการไว้ตามที่ได้มา
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
        from: engine
        to: engine
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
                    `pause_turn` แปลว่าผู้ให้บริการพักคำตอบที่ยาวไว้กลางทาง Anthropic ส่งค่านี้ระหว่างรัน tool ที่ผู้ให้บริการรันเองฝั่งเซิร์ฟเวอร์
                    ไม่ใช่ tool ที่ Geno รัน แต่คำขอหลักของ Geno มีแต่ tool ของ Geno เอง ไม่มี tool ฝั่งเซิร์ฟเวอร์
                    ตอนนี้ Anthropic จึงไม่ส่ง `pause_turn` มาใน loop นี้ แถวนี้มีไว้กันไว้ก่อน
                    การบันทึกสั่งให้ model จำลองจบด้วย `pause_turn` เพื่อให้เห็นว่า Geno ทำอะไร
                    Geno ไม่ต้องรัน tool หรือเขียนอะไรแทน model แค่เรียก model ต่อทันที คำขอถัดไปมีคำตอบที่พักไว้อยู่ท้ายบทสนทนา
                  from: engine
                  to: engine
                do: >-
                  `pause_turn` แปลว่าผู้ให้บริการพัก turn ที่ยาวไว้กลางทาง (เกิดกับ tool ฝั่งเซิร์ฟเวอร์ของ Anthropic)
                  `AFTER_STOP.pause_turn` เป็น `call-model` ไม่มีอะไรถูกตอบแทน model คำขอถัดไปมีคำตอบที่พักไว้อยู่ท้าย history
                  คำขอหลักของ loop มีแต่ tool ของ Geno tool ฝั่งเซิร์ฟเวอร์ตัวเดียวที่ Geno ใช้ คือ `web_search_20250305` (`SERVER_SEARCH`)
                  ไปแค่ในคำขอแยกของ tool `web_search` (`helperCall` ใน `packages/engine/src/tools/web.ts`) ไม่เคยอยู่ใน loop
                  แถวนี้จึงเป็นตัวกันไว้ก่อนที่ loop หลักยังไม่ได้รับจริง การบันทึกบังคับให้คำตอบจบด้วย `pause_turn`
                ref: packages/core/src/loop.ts#AFTER_STOP
                emits: [pause_turn, call-model]
              - use: model-call
                beat:
                  title: "Geno เรียก model ต่อทันที"
                  text: >-
                    คำขอนี้ไม่มีข้อความใหม่จากคุณและไม่มีผลของ tool ข้อความสุดท้ายใน `messages` คือคำตอบที่ถูกพักไว้ของ model เอง
                    การ์ดข้างล่างมาจากการบันทึกเดียวกัน ดูข้อความ `assistant` ที่ไฮไลต์ไว้ท้ายสุด
                  from: engine
                  to: model
                  sees:
                    kind: payload
                    source: packages/docs/src/data/recorded/pause-or-malformed-stop.jsonl#line=4
                    select: messages
                    collapse: ['[0]']
                    highlight: ['[1]']
              - lane: model
                beat:
                  title: "Model ทำต่อจากจุดเดิม"
                  text: >-
                    ผู้ให้บริการทำ turn ที่พักไว้ต่อ ในแชตคุณเห็นแค่ข้อความที่ขึ้นต่อไป การเรียกนี้นับเป็นหนึ่งในขีดจำกัดของ turn
                    การ์ดข้างล่างคือท้าย stream ของคำตอบนั้นในการบันทึกเดียวกัน รอบนี้ model ขอเรียก `list` เพื่อดูไฟล์ในโปรเจกต์
                    จึงจบด้วย `stop_reason: tool_use` ตามปกติ Geno รัน `list` แล้วเรียก model อีกครั้ง และคำตอบถัดไปจบด้วย `end_turn`
                  from: model
                  to: engine
                  sees:
                    kind: payload
                    source: packages/docs/src/data/recorded/pause-or-malformed-stop.jsonl#line=5
                    select: '[-2]'
                    highlight: [data.delta.stop_reason]
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
                    คำตอบบอก `tool_use` แต่ไม่มีบล็อก `tool_use` ให้รัน หรือไม่มี `stop_reason` เลย Geno ไม่เดาว่า model ตั้งใจจบหรือยัง
                    จึงจบ turn แบบ error
                  from: engine
                  to: engine
                do: >-
                  `tool_use` ที่ไม่มีบล็อก `tool_use` เหลือให้รัน ได้ `AFTER_STOP.tool_use` ซึ่งเป็น `done(error)`
                  คำตอบที่ stop reason เป็น `null` ก็ได้ `done(error)` เช่นกัน loop ไม่เดาว่า model ตั้งใจจบหรือยังไม่จบ
                ref: packages/core/src/loop.ts#AFTER_EVENT
                emits: [tool_use, error]
                phase: ending
              - use: mstop-fails-quietly
                beat:
                  title: "เหตุผลไปอยู่แค่ใน output channel"
                  text: >-
                    Geno ไม่บันทึก error ลงบันทึกของ session เหตุผลถูกเขียนลง output channel "Geno engine" เท่านั้น
                    (ช่องในแผง Output ของ VS Code ที่รับข้อความ log ของ engine) แผงแชตรู้แค่ว่า turn ล้มเหลว
                  from: engine
                  to: panel

              - lane: panel
                at: rail
                beat:
                  title: "หัวข้อขึ้น failed โดยไม่มีแถบ error"
                  text: >-
                    ในการบันทึก คำตอบที่จบด้วย `tool_use` แต่ไม่มีการเรียก tool มีข้อความ "Start with src/version.ts." แผงจึงไม่แสดงอะไรเพิ่ม การ์ดข้างล่างคือข้อความนั้น
                    ดูท้ายข้อความที่ขึ้น "failed after ..." (ตามด้วยเวลาที่ turn ใช้) และ "Failed" ไม่มีแถบ error และไม่มีปุ่ม
                    ถ้าคำตอบไม่มีข้อความเลย แผงจะขึ้นประกาศ "Geno stopped without a reply" พร้อมปุ่ม Continue และ Retry แทน
                  from: panel
                  to: you
                  end: "turn ล้มเหลว"
                  sees: { kind: message, from: geno, text: Start with src/version.ts., footer: [ failed after ..., Failed ] }
                do: >-
                  `headerOf` เปลี่ยนหัวข้อเป็น "failed after ..." ถ้ามีข้อความหลังขั้นสุดท้าย `missingReply` ไม่แสดงอะไรเพิ่ม
                  ถ้าไม่มี จะแสดงประกาศว่าคำตอบสุดท้ายไม่มีข้อความ
                sees: >-
                  หัวข้อ "failed after ..." ท้าย turn ขึ้น "Failed" ไม่มีแถบ error และถ้าคำตอบไม่มีข้อความ
                  ขึ้นกล่อง "Geno stopped without a reply · Its last reply had no text." พร้อมปุ่ม [Continue] [Retry]
                ref: packages/extension/src/chat/rail.ts#missingReply
                end: { turn: failed, reason: error }
---

`loopStep` ตัดสินขั้นต่อไปจาก [`stop_reason`](/start/glossary/) ของคำตอบล่าสุดด้วยตาราง `AFTER_STOP` ทุก stop reason ของ Anthropic มีแถวของมัน

| stop reason | ขั้นต่อไป | หน้า |
| --- | --- | --- |
| `end_turn`, `stop_sequence` | จบ (`done`) | [Model ตอบเป็นข้อความโดยไม่เรียก tool](/scenarios/turn/text-answer/) |
| `tool_use` ที่มีการเรียก | รัน tool | [Model เรียก tool แล้วตอบ](/scenarios/turn/with-tools/) |
| `pause_turn` | เรียก model อีกครั้ง | หน้านี้ |
| `tool_use` ที่ไม่มีการเรียก, ไม่มี stop reason | `failed` | หน้านี้ |
| `max_tokens` | `failed` หรือลองใหม่หนึ่งครั้ง | [คำตอบของ model ชนเพดาน output](/scenarios/mstop/max-tokens/) |
| `refusal` | `failed` | [Model ปฏิเสธที่จะตอบ](/scenarios/mstop/refusal/) |
| `model_context_window_exceeded` | สรุปบริบทแล้วส่งใหม่ | [context เกินหน้าต่าง](/scenarios/ctx/overflow-compact-resend/) |

สิ่งที่ควรสังเกต

- **`pause_turn` ไม่มีผลที่ผู้ใช้เห็น** การเรียกครั้งที่สองต่อจากคำตอบเดิม แผงเห็นเป็นข้อความที่ stream ต่อไปเท่านั้น
- **ทางที่ล้มไม่มีเหตุผลในแผง** เหมือน [คำตอบของ model ชนเพดาน output](/scenarios/mstop/max-tokens/) เหตุผล
  ("error: the model stopped with tool_use" หรือ "error: the model stopped with no stop reason") อยู่ใน output channel "Geno engine" เท่านั้น

อ่านต่อที่ [คำตอบของ model ชนเพดาน output](/scenarios/mstop/max-tokens/) ซึ่งล้มแบบเงียบเหมือนกัน
