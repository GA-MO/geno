---
title: คำตอบชนเพดาน output
description: โมเดลเขียนจนถึง max_tokens ถ้าบล็อกที่ถูกตัดเป็นข้อความ turn จบแบบ failed ทันที ถ้าเป็นการเรียกเครื่องมือ Geno บอกโมเดลให้เรียกใหม่ให้เล็กลงหนึ่งครั้ง
tableOfContents: false
sidebar:
  order: 5
scenario:
  surface: vscode
  given:
    - ผู้ใช้ส่งข้อความในแผงแชตของ VS Code และ turn กำลังทำงาน
    - context ใหญ่มากแล้ว เพดาน output ของคำขอ (`max_tokens`) จึงเหลือน้อยกว่าที่โมเดลต้องใช้
  trigger: >-
    โมเดลเขียนคำตอบยาว หรือเรียก `edit` เพื่อสร้างไฟล์ยาว จนผู้ให้บริการตัดคำตอบที่เพดาน output
  covers: [mstop.max-tokens-text, mstop.max-tokens-cut-tool]
  related: [mstop.empty-answer-nudged, mstop.no-reply-continue-retry, mstop.limit-max-turns, ctx.compaction-auto]
  steps:
    - use: model-call

    - id: cut
      lane: model
      do: >-
        โมเดลเขียนจนถึงเพดาน `max_tokens` ของคำขอ ผู้ให้บริการหยุด stream แล้วจบด้วย `stop_reason: max_tokens`
        (wire แบบ OpenAI ได้ `length` ซึ่ง `STOP_REASONS` แปลงเป็น `max_tokens`)
      ref: "packages/engine/src/gateway.ts#\"stopReason: message.stop_reason,\""
      emits: [max_tokens]

    - use: answer-streams

    - id: decide
      lane: loop
      at: step
      do: >-
        `loopStep` อ่านคำตอบล่าสุด `cutOff` ดูว่าบล็อกสุดท้ายของคำตอบที่จบด้วย `max_tokens` เป็นการเรียกเครื่องมือหรือไม่
        เพราะการเรียกที่ถูกตัดมี input ไม่ครบ รันไม่ได้
      ref: packages/core/src/loop.ts#cutOff
      fork:
        ask: บล็อกสุดท้ายที่ถูกตัดคืออะไร
        options:
          - id: text
            label: ข้อความ
            steps:
              - lane: loop
                at: step
                do: >-
                  ไม่มี `tool_use` ค้าง ตาราง `AFTER_STOP` แปลง `max_tokens` เป็น `done(error)` ทันที
                  ไม่มีการเรียกโมเดลซ้ำให้เขียนต่อ และ Stop hook ไม่ทำงานในทางนี้
                ref: packages/core/src/loop.ts#AFTER_STOP
                emits: [error]
                phase: ending
              - use: mstop-fails-quietly
              - lane: panel
                at: rail
                do: >-
                  `headerOf` เปลี่ยนหัวข้อเป็น "failed after ..." `missingReply` เห็นข้อความหลังขั้นสุดท้าย
                  จึงไม่แสดงประกาศ Continue และ Retry คำตอบครึ่งเดียวค้างอยู่โดยไม่มีอะไรบอกว่าทำไม
                sees: >-
                  คำตอบที่หยุดกลางประโยค หัวข้อ "failed after 2m 4s" ท้าย turn ขึ้น "Failed" ไม่มีแถบ error และไม่มีปุ่ม Continue
                ref: packages/extension/src/chat/rail.ts#missingReply
                end: { turn: failed, reason: error }

          - id: tool
            label: การเรียกเครื่องมือ
            steps:
              - lane: loop
                at: step
                do: >-
                  `loopStep` เห็น `tool_use` ที่ยังไม่มีผล `unrunnable` คืนเฉพาะ call ที่ถูกตัดพร้อมข้อความ `UNRUN_TEXTS['cut-off']`
                  จึงตัดสิน `answer-tools` call อื่นที่ครบในคำตอบเดียวกัน (ถ้ามี) ยังรันได้ในรอบถัดไป
                ref: packages/core/src/loop.ts#unrunnable
                emits: [answer-tools]
                phase: running-tools
              - lane: loop
                at: drive
                do: >-
                  `drive` บอก watcher ว่าข้าม call นี้ แล้วบันทึก `tool-result` สถานะ error ที่บอกโมเดลว่า
                  "Your response hit the output limit and cut this tool call short, so it did not run. Continue, and keep each tool call smaller."
                  เครื่องมือไม่ได้รัน
                ref: "packages/engine/src/drive.ts#\"watcher.toolSkipped?.(answer.use, describeCall(answer.use, mode.executors));\""
                emits: [tool-result]
              - lane: server
                at: updates
                do: >-
                  `watcher.toolSkipped` ส่ง `tool_call` สถานะ `pending` แล้วผลที่บันทึกตามไปเป็น `tool_call_update` สถานะ `failed`
                ref: "packages/engine/src/serve.ts#\"toolSkipped(use, title) {\""
                emits: [tool_call, pending, tool_call_update]
              - lane: panel
                at: rail
                alongside: true
                do: >-
                  ขั้นของ call ขึ้นแล้วล้มเหลวทันที ชื่อขั้นมาจากชื่อเครื่องมือเพราะ input ที่ถูกตัดอ่านไม่ได้ครบ
                sees: ขั้น "edit" ขึ้นเครื่องหมายล้มเหลว เปิดดูแล้วเห็นข้อความ "Your response hit the output limit..."
                ref: packages/extension/src/chat/webview.ts#render
              - lane: loop
                at: step
                do: >-
                  `loopStep` เห็น `tool-result` ล่าสุดจึงได้ `call-model` และ `cutTwice` ยังไม่จริง เพราะเพิ่งถูกตัดครั้งเดียว
                  โมเดลจึงได้ลองอีกครั้ง
                ref: packages/core/src/loop.ts#cutTwice
                emits: [call-model]
                phase: calling-model
              - use: model-call
              - lane: model
                do: >-
                  โมเดลอ่านผลที่บอกว่า call ถูกตัด แล้วตอบใหม่
                ref: "packages/engine/src/gateway.ts#\"stopReason: message.stop_reason,\""
                fork:
                  ask: คำตอบใหม่ถูกตัดที่การเรียกเครื่องมืออีกไหม
                  options:
                    - id: smaller
                      label: ไม่ เรียกเล็กลงแล้ว
                      steps:
                        - lane: model
                          do: >-
                            โมเดลแบ่งงานเป็น call ที่เล็กลง เช่นสร้างไฟล์ส่วนแรกก่อน แล้วจบด้วย `stop_reason: tool_use` ตามปกติ
                          ref: "packages/engine/src/gateway.ts#\"stopReason: message.stop_reason,\""
                          emits: [tool_use]
                        - lane: loop
                          at: step
                          do: >-
                            `loopStep` เห็น `tool_use` ที่ครบและไม่มี call ที่ต้องตอบโดยไม่รัน จึงตัดสิน `run-tools` turn ทำงานต่อตามปกติ
                          ref: packages/core/src/loop.ts#loopStep
                          emits: [run-tools]
                          phase: running-tools
                          end: { turn: continues, reason: run-tools }
                    - id: cut-again
                      label: ถูกตัดอีก
                      steps:
                        - lane: loop
                          at: tools
                          do: >-
                            call ที่ถูกตัดครั้งที่สองได้คำตอบ `cut-off` แบบเดียวกัน ขั้นของมันในแผงล้มเหลวอีกขั้น
                          ref: "packages/engine/src/drive.ts#\"watcher.toolSkipped?.(answer.use, describeCall(answer.use, mode.executors));\""
                          emits: [tool-result]
                          phase: running-tools
                        - lane: loop
                          at: step
                          do: >-
                            `loopStep` จะได้ `call-model` แต่ `cutTwice` เห็นว่าคำตอบสองครั้งล่าสุดของรอบนี้ถูกตัดที่การเรียกเครื่องมือทั้งคู่
                            จึงจบด้วย `done(error)` แทนที่จะเสียรอบไปกับการถูกตัดซ้ำ
                          ref: packages/core/src/loop.ts#cutTwice
                          emits: [error]
                          phase: ending
                        - use: mstop-fails-quietly
                        - lane: panel
                          at: rail
                          do: >-
                            ขั้นสุดท้ายล้มเหลวและไม่มีข้อความตามหลัง ไม่มีแถบ error และไม่ได้ถูกหยุดหรือปฏิเสธ
                            `missingReply` จึงให้เหตุผลว่าคำตอบสุดท้ายไม่มีข้อความ
                          sees: >-
                            หัวข้อ "failed after 3m 10s" กล่อง "Geno stopped without a reply · Its last reply had no text."
                            พร้อมปุ่ม [Continue] [Retry] และท้าย turn ขึ้น "Failed"
                          ref: packages/extension/src/chat/rail.ts#missingReply
                          end: { turn: failed, reason: error }
---

`max_tokens` คือเพดานความยาวของคำตอบหนึ่งครั้ง `buildRequest` ตั้งค่านี้เป็นค่าที่น้อยกว่าระหว่างเพดาน output ของโมเดล
กับที่ว่างที่เหลือในหน้าต่าง context ยิ่ง context ใหญ่ เพดานยิ่งต่ำ

| บล็อกที่ถูกตัด | Geno ทำอะไร | turn |
| --- | --- | --- |
| ข้อความ | จบทันที | `failed` ข้อความครึ่งเดียวค้างในแผง |
| การเรียกเครื่องมือ ครั้งแรก | ไม่รัน call นั้น บอกโมเดลให้เรียกใหม่ให้เล็กลง | ทำต่อ |
| การเรียกเครื่องมือ สองครั้งติด | ไม่รัน แล้วจบ | `failed` พร้อมปุ่ม Continue และ Retry |

สิ่งที่ควรสังเกต

- **ทางของข้อความไม่บอกผู้ใช้ว่าเกิดอะไร** `finish` เขียนเหตุผลลง stderr ของ engine อย่างเดียว ไม่มี event `error`
  แผงเห็นแค่ `failed` และเพราะมีข้อความแล้ว `missingReply` จึงไม่แสดงประกาศ Continue และ Retry ด้วย
  ผู้ใช้เห็นคำตอบที่หยุดกลางประโยคกับคำว่า "Failed" โดยไม่มีเหตุผล ต้องเปิด output channel "Geno engine" จึงจะเห็น
  "error: the model stopped with max_tokens"
- **`STOP_MESSAGES.max_tokens` ของ extension ไม่เคยถูกใช้กับ loop ของ Geno** เพราะ ACP ได้ `stopReason: end_turn` เสมอเมื่อ turn จบด้วย error
- **การถูกตัดนับเป็นการเรียกโมเดลหนึ่งครั้ง** การลองใหม่หลัง `cut-off` ใช้ขีดจำกัด 40 ครั้งของรอบเหมือนการเรียกอื่น
