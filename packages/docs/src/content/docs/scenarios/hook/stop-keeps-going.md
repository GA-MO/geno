---
title: "Stop hook ให้ model ทำงานต่อ"
description: model จบ turn แล้ว แต่ Stop hook บล็อกพร้อมเหตุผล ลูปเรียก model อีกรอบให้อ่านเหตุผลนั้น ได้ครั้งเดียวติดกันจนกว่า model จะเรียก tool
scenario:
  surface: vscode
  given:
    - workspace ที่เชื่อถือแล้ว `.claude/settings.json` มี Stop hook ที่รัน `tests-ran.sh`
      สคริปต์ตรวจว่า turn นี้รันเทสต์หรือยังจาก `transcript_path`
    - turn กำลังทำงาน model แก้ `src/version.ts` ไปแล้วแต่ยังไม่ได้รันเทสต์
  trigger: >-
    model เขียนสรุปว่าแก้เสร็จแล้ว และจบคำตอบด้วย `stop_reason: end_turn`
  covers: [hook.stop-keeps-going]
  related: [hook.post-tool, hook.user-prompt-submit, turn.with-tools]
  steps:
    - id: says
      beat:
        title: Model สรุปว่าแก้เสร็จแล้วจบ
        text: model แก้ `src/version.ts` แล้ว แต่ยังไม่ได้รันเทสต์ มันเขียนสรุปและบอกว่าจบ turn การ์ดข้างล่างเป็นคำตอบสุดท้ายจริงจากการรันอื่นที่ model สรุปการแก้ `formatPrice` ดูบล็อก `text` ซึ่งเป็นสรุปที่คุณเห็น และไม่มีบล็อก `tool_use` คำตอบแบบนี้จบด้วย `stop_reason` ค่า `end_turn` แปลว่า model บอกว่าเสร็จแล้ว
        from: model
        to: engine
        sees:
          kind: payload
          source: docs/results/real-usecases/runs/A01-fix-failing-test/1/session.jsonl#seq=20
          select: content
          collapse: ['[0].thinking']
          highlight: ['[1].text']
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
          text: 'Done: parseVersion now throws Error("empty version") on an empty string (src/version.ts:2).'
          streaming: true

    - id: done
      beat:
        title: Geno ถาม Stop hook ก่อนจบ turn
        text: hook คือคำสั่ง shell ที่คุณตั้งไว้ใน settings ให้ Geno รันเมื่อเกิดเหตุการณ์หนึ่ง Stop คือเหตุการณ์ที่ model จะจบ turn model เป็นคนจบ turn เอง ไม่ใช่คุณปฏิเสธ Geno จึงส่งข้อความสุดท้ายของ model ให้ `tests-ran.sh` พร้อมบอกว่า hook เคยบล็อกไปแล้วหรือยังใน turn นี้ (`stop_hook_active` ครั้งแรกเป็น false)
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
        แล้วส่ง `stop_hook_active` (false เมื่อยังไม่เคยบล็อกใน turn นี้ true เมื่อเคยบล็อกแล้ว) และ `last_assistant_message` ให้ hook
      ref: packages/engine/src/drive.ts#stopKeepsGoing
      emits: [stop_hook_active, last_assistant_message]

    - id: hook
      beat:
        title: hook ตรวจว่ารันเทสต์หรือยัง
        text: "สคริปต์อ่านบันทึกของ session จาก `transcript_path` เพื่อดูว่ารันเทสต์หรือยัง แล้วตอบ ถ้าตอบ `continue: false` turn จบ และคำตอบนี้ชนะทุกอย่าง ถ้าบล็อก (exit 2) หรือพิมพ์ข้อความให้ model turn ทำต่อได้ ถ้ายังไม่เคยบล็อกติดกันมาก่อน"
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
                    header: worked for ...
                at: rail
                do: หัวข้อเปลี่ยนเป็นเวลาที่ทำงาน ท้ายคำตอบมีแถวสรุป model token และค่าใช้จ่าย
                sees: หัวข้อ "worked for" ตามด้วยเวลาที่ใช้ และปุ่ม Send กลับมาแทน Stop
                ref: packages/extension/src/chat/rail.ts#headerOf
                end: { turn: done, reason: end_turn }

          - id: again
            label: จบครั้งที่สอง hook บล็อกซ้ำ ทั้งที่ model ไม่ได้เรียก tool
            steps:
              - lane: policy
                beat:
                  title: hook บล็อกซ้ำ แต่ Geno ไม่ยอม
                  text: สมมติว่านี่เป็นการจบครั้งที่สอง hook บล็อกไปแล้วครั้งหนึ่งใน turn นี้ แล้ว model ตอบเป็นข้อความเฉยๆ โดยไม่เรียก tool และจบอีก ครั้งนี้ hook บล็อกอีก Geno ไม่ยอม เพราะไม่ให้ hook ที่บล็อกทุกครั้งวน model ไม่รู้จบ
                  from: machine
                  to: engine
                at: hooks
                do: >-
                  hook บล็อกอีก แต่ turn นี้มี `hook-context` ของ Stop อยู่แล้ว และหลังจากนั้น model ไม่ได้เรียก tool เลย
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
                    header: worked for ...
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
                sees: หัวข้อ "worked for" ตามด้วยเวลาที่ใช้ และปุ่ม Send กลับมาแทน Stop
                ref: packages/extension/src/chat/rail.ts#headerOf
                end: { turn: done, reason: end_turn }

    - id: may
      beat:
        title: hook บล็อกพร้อมเหตุผล
        text: สคริปต์จบด้วย exit 2 และเขียน "run npm test before you finish" Geno ยอม เพราะ turn นี้ยังไม่เคยบล็อก มันบันทึกเหตุผลของ hook ลง log แทนการจบ turn
        from: machine
        to: engine
      lane: loop
      at: drive
      do: >-
        สคริปต์จบด้วย exit 2 และเขียน "run npm test before you finish" ลง stderr ได้โน้ตชนิด `blocking`
        `stopMayContinue` ยอมเพราะ turn นี้ยังไม่เคยบล็อก `drive` จึงบันทึก event `hook-context` ของ Stop แทนการจบ turn
      ref: packages/core/src/loop.ts#stopMayContinue
      emits: [hook-context]

    - id: decide
      beat:
        title: Geno เรียก model อีกครั้ง
        text: >-
          เหตุผลของ hook ทำให้ turn ทำต่อ งบของ turn (เรียก model ได้ 40 ครั้ง และราว $0.40 สำหรับ model ในการบันทึก) ยังนับต่อจากเดิม Geno ใส่เหตุผลไว้ในข้อความถัดไปที่ส่งให้ model ขึ้นต้นด้วย `[Geno] Stop hook blocking error` ซึ่งบอกว่าเป็นโน้ตจาก Geno
          การ์ดข้างล่างเป็นการบันทึกที่รัน Geno จริงกับ model จำลองที่ตอบตามบทที่เขียนไว้ก่อน ในการบันทึก model อ่าน `src/version.ts` แล้วแก้ก่อนสรุป
          คำขอนี้มีเจ็ดข้อความ การ์ดแสดงสองข้อความท้าย แท็บแรกคือข้อความ assistant ที่เป็นสรุปซึ่ง model คิดว่าจบแล้ว
          แท็บสองคือข้อความ user ต่อจากนั้น มีแต่เหตุผลของ hook ไม่มีอะไรที่คุณพิมพ์
        from: engine
        to: model
        sees:
          - kind: payload
            source: packages/docs/src/data/recorded/hook-stop-keeps-going.jsonl#line=8
            select: messages[5]
            highlight: ['content[0].text']
          - kind: payload
            source: packages/docs/src/data/recorded/hook-stop-keeps-going.jsonl#line=8
            select: messages[6]
            highlight: ['content[0].text']
      lane: loop
      at: step
      do: >-
        `loopStep` เห็นว่า event ล่าสุดคือ `hook-context` ซึ่งตาราง `AFTER_EVENT` แปลงเป็น `call-model`
        ขีดจำกัดของรอบ (40 ครั้ง และ $0.40 ตามราคา qwen3.8-flash ปรับตาม model ของ session) ยังนับต่อ
      ref: "packages/core/src/loop.ts#\"'hook-context': () => CALL,\""
      emits: [call-model]
      phase: calling-model

    - id: request
      lane: loop
      at: model-call
      do: >-
        `buildRequest` ประกอบคำขอจาก log (`replayMessages` วางโน้ตของ Stop ไว้ใน user message ถัดไป) model อ่าน:
        "[Geno] Stop hook blocking error: run npm test before you finish"
      ref: packages/core/src/hooks.ts#hookNoteText

    - id: continues
      beat:
        title: Model ขอรัน `npm test`
        text: >-
          model อ่านเหตุผลแล้วขอรันเทสต์ ข้อความใหม่ต่อท้ายคำตอบเดิมใน turn เดียวกัน แชตไม่บอกว่า hook เป็นคนให้ทำต่อ
          การ์ดข้างล่างเป็น event สองตัวใน stream ของคำตอบจากการบันทึกเดียวกับการ์ดก่อน แท็บแรกคือข้อความที่ model เขียนก่อนเรียก tool
          แท็บสองคือชิ้นสุดท้ายของ input ของ `bash` ซึ่งมีคำสั่ง `npm test` คำตอบนี้จบด้วย `stop_reason: tool_use`
          ในการบันทึก เทสต์ผ่าน model สรุปอีกครั้ง และรอบนี้สคริปต์เห็น `npm test` ใน `transcript_path` จึงปล่อยให้ turn จบ
        from: model
        to: engine
        end: Turn ทำต่อ
        sees:
          - kind: payload
            source: packages/docs/src/data/recorded/hook-stop-keeps-going.jsonl#line=9
            select: '[2]'
            highlight: [data.delta.text]
          - kind: payload
            source: packages/docs/src/data/recorded/hook-stop-keeps-going.jsonl#line=9
            select: '[6]'
            highlight: [data.delta.partial_json]
      lane: model
      do: >-
        model อ่านเหตุผล แล้วขอรัน `bash` ด้วย `npm test` ข้อความใหม่ต่อท้ายคำตอบเดิมใน turn เดียวกัน
        แผงแชตไม่มีอะไรบอกว่า hook เป็นคนให้ทำต่อ
      ref: "packages/engine/src/gateway.ts#\"stopReason: message.stop_reason,\""
      emits: [tool_use]
      end: { turn: continues, reason: run-tools }
---

Stop [hook](/start/glossary/) คือจุดตรวจตอนท้าย turn: model บอกว่าเสร็จ แต่ hook ตัดสินว่ายัง

"ครั้งเดียวติดกัน" นับแบบนี้: หลังการบล็อก ถ้า model เรียก tool อย่างน้อยหนึ่งตัว (ไม่นับ `report` ของ subagent) การบล็อกครั้งถัดไปนับใหม่
ถ้า model ตอบเป็นข้อความเฉยๆ แล้วจบอีก การบล็อกครั้งที่สองถูกข้าม ทัวร์นี้จบตรงที่ model รันเทสต์
เมื่อ model จบอีกครั้ง hook จะได้ `stop_hook_active: true` และตัดสินใหม่

สิ่งที่ควรสังเกต

- **Stop hook ไม่ทำงานเมื่อ turn จบด้วยเหตุอื่น** เช่นผู้ใช้กด Deny บนการ์ด error ขีดจำกัด หรือผู้ใช้กด Stop
- **[งบของ turn](/start/glossary/) ยังนับ** hook ที่บล็อกหลังทุกครั้งที่ model เรียก tool หยุดได้ด้วยขีดจำกัด 40 ครั้งหรือค่าใช้จ่าย ($0.40 ตามราคา qwen3.8-flash ปรับตาม model ของ session)
- **`additionalContext` อย่างเดียวก็ทำให้ทำต่อ** (อ่านจากโค้ด) `stopDecision` นับทุกโน้ตเป็นเหตุให้ทำต่อ
  hook ที่แค่พิมพ์ `hookSpecificOutput.additionalContext` โดยไม่บล็อกจึงทำให้ model ถูกเรียกอีกรอบเหมือนการบล็อก
- **[subagent](/start/glossary/) ใช้ SubagentStop** ทางเดียวกันนี้ใช้กับลูกเมื่อมันส่งรายงาน โดย hook ได้ข้อความรายงานเป็น `last_assistant_message`
