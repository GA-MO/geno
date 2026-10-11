---
title: Stop hook ให้โมเดลทำงานต่อ
description: โมเดลจบ turn แล้ว แต่ Stop hook บล็อกพร้อมเหตุผล ลูปเรียกโมเดลอีกรอบให้อ่านเหตุผลนั้น ได้ครั้งเดียวติดกันจนกว่าโมเดลจะเรียกเครื่องมือ
tableOfContents: false
sidebar:
  order: 5
scenario:
  surface: vscode
  given:
    - workspace ที่เชื่อถือแล้ว `.claude/settings.json` มี Stop hook ที่รัน `tests-ran.sh`
      สคริปต์ตรวจว่า turn นี้รันเทสต์หรือยังจาก `transcript_path`
    - turn กำลังทำงาน โมเดลแก้ `src/date.ts` ไปแล้วแต่ยังไม่ได้รันเทสต์
  trigger: >-
    โมเดลเขียนสรุปว่าแก้เสร็จแล้ว และจบคำตอบด้วย `stop_reason: end_turn`
  covers: [hook.stop-keeps-going]
  related: [hook.post-tool, hook.user-prompt-submit, turn.with-tools]
  steps:
    - id: says
      lane: model
      do: >-
        โมเดล stream สรุปการแก้ แล้วจบด้วย `stop_reason: end_turn`
      ref: "packages/engine/src/gateway.ts#\"stopReason: message.stop_reason,\""
      emits: [end_turn]
      phase: calling-model

    - use: answer-streams

    - id: done
      lane: loop
      at: step
      do: >-
        `loopStep` เห็นว่าคำตอบล่าสุดจบด้วย `end_turn` จึงให้ `done(end_turn)` แต่ก่อนจบจริง `drive` ถาม Stop hook
      ref: packages/core/src/loop.ts#AFTER_STOP
      emits: [end_turn]
      phase: ending

    - id: asks
      lane: loop
      at: drive
      do: >-
        `stopKeepsGoing` ตรวจว่าโมเดลเป็นคนจบ turn เอง (`modelEndedTurn`) ไม่ใช่การปฏิเสธของผู้ใช้
        แล้วส่ง `stop_hook_active: false` (ยังไม่เคยบล็อกใน run นี้) และ `last_assistant_message` ให้ hook
      ref: packages/engine/src/drive.ts#stopKeepsGoing
      emits: [stop_hook_active, last_assistant_message]

    - id: hook
      lane: policy
      at: hooks
      do: >-
        hook รันพร้อม JSON บน stdin `stopDecision` อ่านผล: `continue: false` ชนะทุกอย่าง
        ส่วน exit 2, `decision: "block"` หรือ `additionalContext` กลายเป็นโน้ตที่ให้ turn ทำต่อ
      ref: packages/core/src/hooks.ts#stopDecision
      emits: [Stop]
      fork:
        ask: hook ตอบอะไร
        options:
          - id: block
            label: บล็อกพร้อมเหตุผล
            then: may

          - id: lets-end
            label: ปล่อยให้จบ
            steps:
              - lane: policy
                at: hooks
                do: >-
                  สคริปต์จบด้วย exit 0 โดยไม่พิมพ์อะไร (หรือพิมพ์ `continue: false` พร้อม `stopReason` ซึ่งไปที่ output channel "Geno engine")
                  `stopDecision` ได้ `end` turn จบตามปกติ
                ref: packages/core/src/hooks.ts#stopDecision
              - lane: server
                at: turns
                do: >-
                  `runTurn` แปลงผลด้วย `TURN_ENDS`: ACP ได้ `stopReason: end_turn` และงานจบแบบ `done`
                ref: packages/engine/src/serve.ts#TURN_ENDS
                emits: [TURN_END_META]
              - lane: panel
                at: rail
                do: หัวข้อเปลี่ยนเป็นเวลาที่ทำงาน ท้ายคำตอบมีแถวสรุปโมเดล token และค่าใช้จ่าย
                sees: หัวข้อ "worked for 31s" และปุ่ม Send กลับมาแทน Stop
                ref: packages/extension/src/chat/rail.ts#headerOf
                end: { turn: done, reason: end_turn }

          - id: again
            label: บล็อกซ้ำทั้งที่โมเดลไม่ได้เรียกเครื่องมือ
            steps:
              - lane: policy
                at: hooks
                do: >-
                  hook บล็อกอีก แต่ run นี้มี `hook-context` ของ Stop อยู่แล้ว และหลังจากนั้นโมเดลไม่ได้เรียกเครื่องมือเลย
                  `stopMayContinue` ตอบว่าไม่ได้ hook ที่บล็อกทุกครั้งจึงวนโมเดลไม่ได้
                ref: packages/core/src/loop.ts#stopMayContinue
              - lane: loop
                at: drive
                do: >-
                  `drive` เขียนลง stderr ว่า "Stop hook blocked the end of the turn again, and the model called no tool since its last block,
                  so the turn ends here" (ใน VS Code คือ output channel "Geno engine") แล้วจบ turn
                ref: "packages/engine/src/drive.ts#\"hook blocked the end of the turn again, and the model called no tool since its last block, so the turn ends here\""
              - lane: server
                at: turns
                do: >-
                  `runTurn` แปลงผลด้วย `TURN_ENDS`: `stopReason: end_turn` งานจบแบบ `done`
                ref: packages/engine/src/serve.ts#TURN_ENDS
                emits: [TURN_END_META]
              - lane: panel
                at: rail
                do: turn จบเหมือนปกติ แผงแชตไม่บอกว่า hook บล็อกซ้ำ
                sees: หัวข้อ "worked for 48s" และปุ่ม Send กลับมาแทน Stop
                ref: packages/extension/src/chat/rail.ts#headerOf
                end: { turn: done, reason: end_turn }

    - id: may
      lane: loop
      at: drive
      do: >-
        สคริปต์จบด้วย exit 2 และเขียน "run pnpm test before you finish" ลง stderr ได้โน้ตชนิด `blocking`
        `stopMayContinue` ยอมเพราะ run นี้ยังไม่เคยบล็อก `drive` จึงบันทึก event `hook-context` ของ Stop แทนการจบ turn
      ref: packages/core/src/loop.ts#stopMayContinue
      emits: [hook-context]

    - id: decide
      lane: loop
      at: step
      do: >-
        `loopStep` เห็นว่า event ล่าสุดคือ `hook-context` ซึ่งตาราง `AFTER_EVENT` แปลงเป็น `call-model`
        ขีดจำกัดของรอบ (40 ครั้ง และ $0.40) ยังนับต่อ
      ref: "packages/core/src/loop.ts#\"'hook-context': () => CALL,\""
      emits: [call-model]
      phase: calling-model

    - id: request
      lane: loop
      at: model-call
      do: >-
        `callModel` ประกอบคำขอ โน้ตของ Stop ไปเป็นข้อความถัดไปที่โมเดลอ่าน:
        "[Geno] Stop hook blocking error: run pnpm test before you finish"
      ref: packages/core/src/hooks.ts#hookNoteText

    - id: continues
      lane: model
      do: >-
        โมเดลอ่านเหตุผล แล้วขอรัน `bash` ด้วย `pnpm test` ข้อความใหม่ต่อท้ายคำตอบเดิมใน turn เดียวกัน
        แผงแชตไม่มีอะไรบอกว่า hook เป็นคนให้ทำต่อ
      ref: "packages/engine/src/gateway.ts#\"stopReason: message.stop_reason,\""
      emits: [tool_use]
      end: { turn: continues, reason: call-model }
---

Stop hook คือจุดตรวจตอนท้าย turn: โมเดลบอกว่าเสร็จ แต่ hook ตัดสินว่ายัง

"ครั้งเดียวติดกัน" นับแบบนี้: หลังการบล็อก ถ้าโมเดลเรียกเครื่องมืออย่างน้อยหนึ่งตัว (ไม่นับ `report` ของเอเจนต์ลูก) การบล็อกครั้งถัดไปนับใหม่
ถ้าโมเดลตอบเป็นข้อความเฉยๆ แล้วจบอีก การบล็อกครั้งที่สองถูกข้าม ทัวร์นี้จบตรงที่โมเดลรันเทสต์
เมื่อโมเดลจบอีกครั้ง hook จะได้ `stop_hook_active: true` และตัดสินใหม่

สิ่งที่ควรสังเกต

- **Stop hook ไม่ทำงานเมื่อ turn จบด้วยเหตุอื่น** เช่นผู้ใช้กด Deny บนการ์ด error ขีดจำกัด หรือผู้ใช้กด Stop
- **ขีดจำกัดของรอบยังนับ** hook ที่บล็อกหลังทุกครั้งที่โมเดลเรียกเครื่องมือหยุดได้ด้วยขีดจำกัด 40 ครั้งหรือ $0.40
- **`additionalContext` อย่างเดียวก็ทำให้ทำต่อ** (อ่านจากโค้ด) `stopDecision` นับทุกโน้ตเป็นเหตุให้ทำต่อ
  hook ที่แค่พิมพ์ `hookSpecificOutput.additionalContext` โดยไม่บล็อกจึงทำให้โมเดลถูกเรียกอีกรอบเหมือนการบล็อก
- **เอเจนต์ลูกใช้ SubagentStop** ทางเดียวกันนี้ใช้กับลูกเมื่อมันส่งรายงาน โดย hook ได้ข้อความรายงานเป็น `last_assistant_message`
