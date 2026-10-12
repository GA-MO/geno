---
title: "Stop hook ให้ model ทำงานต่อ"
description: model จบ turn แล้ว แต่ Stop hook บล็อกพร้อมเหตุผล ลูปเรียก model อีกรอบให้อ่านเหตุผลนั้น ได้ครั้งเดียวติดกันจนกว่า model จะเรียก tool
scenario:
  surface: vscode
  given:
    - workspace ที่เชื่อถือแล้ว `.claude/settings.json` มี Stop hook ที่รัน `tests-ran.sh`
      สคริปต์ตรวจว่า turn นี้รันเทสต์หรือยังจาก `transcript_path`
    - turn กำลังทำงาน model แก้ `src/date.ts` ไปแล้วแต่ยังไม่ได้รันเทสต์
  trigger: >-
    model เขียนสรุปว่าแก้เสร็จแล้ว และจบคำตอบด้วย `stop_reason: end_turn`
  covers: [hook.stop-keeps-going]
  related: [hook.post-tool, hook.user-prompt-submit, turn.with-tools]
  steps:
    - id: says
      beat:
        title: Model สรุปว่าแก้เสร็จแล้วจบ
        text: model แก้ `src/date.ts` แล้ว แต่ยังไม่ได้รันเทสต์ มันเขียนสรุปและบอกว่าจบ turn
        from: model
        to: engine
      lane: model
      do: >-
        model stream สรุปการแก้ แล้วจบด้วย `stop_reason: end_turn`
      ref: "packages/engine/src/gateway.ts#\"stopReason: message.stop_reason,\""
      emits: [end_turn]
      phase: calling-model

    - use: answer-streams
      beat:
        title: แชตแสดงสรุปทีละส่วน
        text: ข้อความของ model ค่อยๆ ขึ้นในแชต หัวข้อยังเป็น working
        from: panel
        to: you
        sees:
          kind: message
          from: geno
          text: แก้ src/date.ts เรียบร้อยแล้ว
          streaming: true

    - id: done
      beat:
        title: Geno ถาม Stop hook ก่อนจบ turn
        text: model เป็นคนจบ turn เอง ไม่ใช่คุณปฏิเสธ Geno จึงส่งข้อความสุดท้ายของ model ให้ `tests-ran.sh` พร้อมบอกว่า hook ยังไม่เคยบล็อกใน run นี้
        from: engine
        to: machine
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
        `stopKeepsGoing` ตรวจว่า model เป็นคนจบ turn เอง (`modelEndedTurn`) ไม่ใช่การปฏิเสธของผู้ใช้
        แล้วส่ง `stop_hook_active: false` (ยังไม่เคยบล็อกใน run นี้) และ `last_assistant_message` ให้ hook
      ref: packages/engine/src/drive.ts#stopKeepsGoing
      emits: [stop_hook_active, last_assistant_message]

    - id: hook
      beat:
        title: hook ตรวจว่ารันเทสต์หรือยัง
        text: "สคริปต์อ่าน transcript ของ turn แล้วตอบ `continue: false` ชนะทุกอย่าง ส่วนการบล็อกหรือข้อความเพิ่มทำให้ turn ทำต่อ"
        from: machine
        to: engine
        ask: hook ตอบอะไร
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
                beat:
                  title: hook ปล่อยให้จบ
                  text: สคริปต์จบด้วย exit 0 โดยไม่พิมพ์อะไร turn จบตามปกติ
                  from: machine
                  to: engine
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
                beat:
                  title: Turn จบ
                  text: หัวข้อเปลี่ยนเป็นเวลาที่ทำงาน และปุ่ม Send กลับมา
                  from: engine
                  to: panel
                  end: Turn จบตามปกติ
                  sees:
                    kind: composer
                    state: idle
                    header: worked for 31s
                at: rail
                do: หัวข้อเปลี่ยนเป็นเวลาที่ทำงาน ท้ายคำตอบมีแถวสรุป model token และค่าใช้จ่าย
                sees: หัวข้อ "worked for 31s" และปุ่ม Send กลับมาแทน Stop
                ref: packages/extension/src/chat/rail.ts#headerOf
                end: { turn: done, reason: end_turn }

          - id: again
            label: บล็อกซ้ำทั้งที่ model ไม่ได้เรียก tool
            steps:
              - lane: policy
                beat:
                  title: hook บล็อกซ้ำ แต่ Geno ไม่ยอม
                  text: hook บล็อกไปแล้วครั้งหนึ่งใน run นี้ และหลังจากนั้น model ไม่ได้เรียก tool เลย Geno ไม่ให้ hook ที่บล็อกทุกครั้งวน model ไม่รู้จบ
                  from: machine
                  to: engine
                at: hooks
                do: >-
                  hook บล็อกอีก แต่ run นี้มี `hook-context` ของ Stop อยู่แล้ว และหลังจากนั้น model ไม่ได้เรียก tool เลย
                  `stopMayContinue` ตอบว่าไม่ได้ hook ที่บล็อกทุกครั้งจึงวน model ไม่ได้
                ref: packages/core/src/loop.ts#stopMayContinue
              - lane: loop
                beat:
                  title: Geno จบ turn และเขียนเหตุลง log
                  text: Geno เขียนเหตุผลลง output channel "Geno engine" แผงแชตไม่บอกว่า hook บล็อกซ้ำ turn จบเหมือนปกติ
                  from: engine
                  to: panel
                  end: Turn จบ ไม่วนซ้ำ
                  sees:
                    kind: composer
                    state: idle
                    header: worked for 48s
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
      beat:
        title: hook บล็อกพร้อมเหตุผล
        text: สคริปต์จบด้วย exit 2 และเขียน "run pnpm test before you finish" Geno ยอม เพราะ run นี้ยังไม่เคยบล็อก มันบันทึกเหตุผลของ hook แทนการจบ turn
        from: machine
        to: engine
      lane: loop
      at: drive
      do: >-
        สคริปต์จบด้วย exit 2 และเขียน "run pnpm test before you finish" ลง stderr ได้โน้ตชนิด `blocking`
        `stopMayContinue` ยอมเพราะ run นี้ยังไม่เคยบล็อก `drive` จึงบันทึก event `hook-context` ของ Stop แทนการจบ turn
      ref: packages/core/src/loop.ts#stopMayContinue
      emits: [hook-context]

    - id: decide
      beat:
        title: Geno เรียก model อีกครั้ง
        text: เหตุผลของ hook ทำให้ turn ทำต่อ ขีดจำกัดของรอบยังนับต่อจากเดิม Geno ใส่เหตุผลไว้ในข้อความถัดไปที่ส่งให้ model
        from: engine
        to: model
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
        `buildRequest` ประกอบคำขอจาก log (`replayMessages` วางโน้ตของ Stop ไว้ใน user message ถัดไป) model อ่าน:
        "[Geno] Stop hook blocking error: run pnpm test before you finish"
      ref: packages/core/src/hooks.ts#hookNoteText

    - id: continues
      beat:
        title: Model ขอรัน `pnpm test`
        text: model อ่านเหตุผลแล้วขอรันเทสต์ ข้อความใหม่ต่อท้ายคำตอบเดิมใน turn เดียวกัน แชตไม่บอกว่า hook เป็นคนให้ทำต่อ
        from: model
        to: engine
        end: Turn ทำต่อ
      lane: model
      do: >-
        model อ่านเหตุผล แล้วขอรัน `bash` ด้วย `pnpm test` ข้อความใหม่ต่อท้ายคำตอบเดิมใน turn เดียวกัน
        แผงแชตไม่มีอะไรบอกว่า hook เป็นคนให้ทำต่อ
      ref: "packages/engine/src/gateway.ts#\"stopReason: message.stop_reason,\""
      emits: [tool_use]
      end: { turn: continues, reason: call-model }
---

Stop hook คือจุดตรวจตอนท้าย turn: model บอกว่าเสร็จ แต่ hook ตัดสินว่ายัง

"ครั้งเดียวติดกัน" นับแบบนี้: หลังการบล็อก ถ้า model เรียก tool อย่างน้อยหนึ่งตัว (ไม่นับ `report` ของ subagent) การบล็อกครั้งถัดไปนับใหม่
ถ้า model ตอบเป็นข้อความเฉยๆ แล้วจบอีก การบล็อกครั้งที่สองถูกข้าม ทัวร์นี้จบตรงที่ model รันเทสต์
เมื่อ model จบอีกครั้ง hook จะได้ `stop_hook_active: true` และตัดสินใหม่

สิ่งที่ควรสังเกต

- **Stop hook ไม่ทำงานเมื่อ turn จบด้วยเหตุอื่น** เช่นผู้ใช้กด Deny บนการ์ด error ขีดจำกัด หรือผู้ใช้กด Stop
- **ขีดจำกัดของรอบยังนับ** hook ที่บล็อกหลังทุกครั้งที่ model เรียก tool หยุดได้ด้วยขีดจำกัด 40 ครั้งหรือ $0.40
- **`additionalContext` อย่างเดียวก็ทำให้ทำต่อ** (อ่านจากโค้ด) `stopDecision` นับทุกโน้ตเป็นเหตุให้ทำต่อ
  hook ที่แค่พิมพ์ `hookSpecificOutput.additionalContext` โดยไม่บล็อกจึงทำให้ model ถูกเรียกอีกรอบเหมือนการบล็อก
- **subagent ใช้ SubagentStop** ทางเดียวกันนี้ใช้กับลูกเมื่อมันส่งรายงาน โดย hook ได้ข้อความรายงานเป็น `last_assistant_message`
