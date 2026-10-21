---
title: "hook PostToolUse และ PostToolBatch หลังคำสั่งรัน"
description: hook หลัง call เพิ่มข้อความให้ model อ่านคู่กับผล บล็อก หรือหยุด turn และ hook หลังทั้งชุดหยุดลูปก่อนเรียก model ได้
scenario:
  surface: vscode
  given:
    - workspace ที่เชื่อถือแล้ว `.claude/settings.json` มี PostToolUse hook ที่ matcher เป็น `Bash` ซึ่งรัน `lint-after.sh`
      และ PostToolBatch hook ที่รัน `batch-guard.sh`
    - โหมด Ask มี turn ทำงานอยู่ คำสั่ง `npm test` อยู่ใน safe list
  trigger: >-
    model ขอรัน `bash` ด้วยคำสั่ง `npm test`
  covers: [hook.post-tool, hook.post-tool-batch-blocks]
  related: [hook.pretooluse-deny, hook.stop-keeps-going, tool.bash-safe-runs]
  steps:
    - id: wants
      beat:
        title: Model ขอรัน `npm test`
        text: "model ขอใช้ tool `bash` (tool ที่รันคำสั่ง shell) `npm test` อยู่ในรายการคำสั่งปลอดภัยที่รันได้เลย Geno จึงรันโดยไม่ถามคุณ การ์ดข้างล่างเป็นคำตอบจริงจากการรันอื่นที่ model ขอรันเทสต์ด้วยคำสั่งคล้ายกัน (`npm test 2>&1 | tail -30`) ดูบล็อก `tool_use` ที่ `name` คือ `bash` และ `input.command` คือคำสั่ง"
        from: model
        to: engine
        sees:
          kind: payload
          source: docs/results/real-usecases/runs/A01-fix-failing-test/1/session.jsonl#seq=4
          select: content
          collapse: ['[0].thinking']
          highlight: ['[2].input']
      lane: model
      do: >-
        model ขอเรียก `bash` ด้วยคำสั่ง `npm test` และจบคำตอบด้วย `stop_reason: tool_use`
      ref: "packages/engine/src/gateway.ts#\"stopReason: message.stop_reason,\""
      emits: [tool_use]
      phase: calling-model

    - use: tool-call-opens
      beat:
        title: แชตขึ้นขั้น `npm test`
        text: Geno จัดคิวคำสั่งแล้วบอกแผงแชต ขั้นใหม่ขึ้นพร้อมจุดหมุน
        from: panel
        to: you
        sees:
          kind: step
          label: npm test
          status: running

    - id: run
      beat:
        title: "`npm test` รันใน sandbox"
        text: sandbox คือกรอบของระบบปฏิบัติการที่ให้คำสั่งเขียนไฟล์ได้แค่ใน workspace กับโฟลเดอร์ชั่วคราว และต่อเครือข่ายได้แค่ host ที่อนุญาต เทสต์ผ่าน คำสั่งจบด้วย exit 0
        from: engine
        to: machine
      lane: tool
      at: shell
      do: >-
        `bash` รัน `npm test` ใน sandbox เทสต์ผ่านและคำสั่งจบด้วย exit 0
      ref: "packages/engine/src/tools/agent.ts#\"tools.sandbox.run(command\""

    - id: after
      beat:
        title: Geno ส่งผลให้ PostToolUse hook
        text: hook คือคำสั่ง shell ที่คุณตั้งไว้ใน settings ให้ Geno รันเมื่อเกิดเหตุการณ์หนึ่ง PostToolUse คือเหตุการณ์หลัง tool รันจบ ทันทีที่คำสั่งจบ ก่อน call ถัดไปเริ่ม Geno รัน `lint-after.sh` พร้อมผลของคำสั่ง call ที่ถูกปฏิเสธไม่ได้รัน hook นี้
        from: engine
        to: machine
        ask: hook ตอบอะไร
      lane: policy
      at: hooks
      do: >-
        ทันทีที่ call จบ ก่อน call ถัดไปจะเริ่ม `toolHooks.after` เลือก event ตามสถานะ: `ok` ได้ PostToolUse `error` ได้ PostToolUseFailure
        call ที่ถูกปฏิเสธไม่มี hook หลังรัน hook ได้ `tool_response` ในรูปของ Claude Code (`stdout`, `stderr`, `interrupted`) และ `duration_ms`
      ref: packages/engine/src/hooks.ts#HookSessions.toolHooks
      emits: [PostToolUse, tool_response, duration_ms]
      fork:
        ask: PostToolUse hook ตอบอะไร
        options:
          - id: context
            label: เพิ่มบริบท
            then: batch
            steps:
              - lane: policy
                beat:
                  title: hook เพิ่มบริบทให้ model
                  text: สคริปต์พิมพ์ "2 snapshot files changed" Geno เก็บข้อความนี้ไว้ให้ model อ่านคู่กับผล ไม่มีอะไรหยุด
                  from: machine
                  to: engine
                at: hooks
                do: >-
                  สคริปต์พิมพ์ JSON ที่มี `hookSpecificOutput.additionalContext: "2 snapshot files changed"`
                  `toolHookVerdict` เก็บเป็นโน้ตชนิด `additional-context` ไม่หยุดอะไร
                ref: packages/core/src/hooks.ts#toolHookVerdict
                emits: [additionalContext]

          - id: block
            label: บล็อก
            then: batch
            steps:
              - lane: policy
                beat:
                  title: hook บล็อก แต่คำสั่งรันไปแล้ว
                  text: สคริปต์จบด้วย exit 2 และเขียน "lint failed in src/date.ts" คำสั่งรันไปแล้วจึงย้อนไม่ได้ การบล็อกกลายเป็นข้อความที่ model ต้องอ่าน และลูปไม่หยุด
                  from: machine
                  to: engine
                at: hooks
                do: >-
                  สคริปต์จบด้วย exit 2 และเขียน "lint failed in src/date.ts" ลง stderr (หรือพิมพ์ `decision: "block"` พร้อม `reason`)
                  หลัง call ที่รันไปแล้ว การบล็อกไม่ย้อนผล มันกลายเป็นโน้ตชนิด `blocking` ที่ model จะอ่าน และไม่หยุดลูป
                ref: packages/core/src/hooks.ts#toolHookVerdict
                emits: [blocking]

          - id: stop
            label: "continue: false"
            steps:
              - lane: policy
                beat:
                  title: hook สั่งหยุด turn
                  text: 'สคริปต์ตอบ `continue: false` พร้อมเหตุผล "CI is red, stop here" PostToolBatch hook ยังรันก่อน แล้ว Geno บันทึก error ว่า hook หยุด turn'
                  from: machine
                  to: engine
                at: hooks
                do: >-
                  สคริปต์พิมพ์ `{"continue": false, "stopReason": "CI is red, stop here"}`
                  โน้ตเป็น `blocking` และ hook ขอให้หยุดหลังชุดนี้ PostToolBatch ยังรันตามปกติก่อนลูปจะหยุด
                ref: packages/core/src/hooks.ts#toolHookVerdict
                emits: [continue]
              - lane: loop
                at: tools
                do: >-
                  `runTools` บันทึกผลของ call โน้ตของ hook เป็น event `hook-context` แล้วบันทึก error ชนิด `blocked`:
                  "A PostToolUse hook stopped the turn: CI is red, stop here"
                ref: "packages/engine/src/drive.ts#\"const message = `A ${stop.by} hook stopped the turn: ${stop.reason}`;\""
                emits: [tool-result, hook-context, blocked]
              - lane: server
                beat:
                  title: แชตขึ้นแถบ error
                  text: ขั้นของคำสั่งขึ้นว่าเสร็จ แต่ท้าย turn มีแถบ error ที่บอกเหตุผลของ hook
                  from: panel
                  to: you
                  sees:
                    kind: notice
                    text: "A PostToolUse hook stopped the turn: CI is red, stop here"
                    tone: error
                at: updates
                do: >-
                  ผลไปเป็น `tool_call_update` และ error ไปเป็น `agent_message_chunk` พร้อม `TURN_ERROR_META`
                ref: packages/engine/src/session-replay.ts#errorUpdate
                emits: [tool_call_update, TURN_ERROR_META]
              - lane: panel
                at: rail
                alongside: true
                do: ขั้นของคำสั่งขึ้นเครื่องหมายเสร็จ และท้าย turn ขึ้นแถบ error
                sees: >-
                  แถบ error "A PostToolUse hook stopped the turn: CI is red, stop here"
                ref: packages/extension/src/chat/render.ts#errorBlock
              - lane: loop
                beat:
                  title: Turn ล้มเหลว
                  text: Geno ไม่เรียก model อีก model จึงไม่ได้อ่านผลของ `npm test` ปุ่ม Send กลับมา
                  from: engine
                  to: panel
                  end: Turn ล้มเหลวเพราะ hook
                  sees:
                    kind: composer
                    state: idle
                    header: failed after ...
                at: step
                do: >-
                  `loopStep` เห็น error ชนิด `blocked` จึงตัดสิน `done(error)` model ไม่ได้อ่านผลของ `npm test`
                ref: packages/core/src/loop.ts#ERROR_REASON
                emits: [error]
                phase: ending
              - lane: panel
                at: rail
                do: หัวข้อเปลี่ยนเป็น "failed after ..." และปุ่ม Send กลับมา
                sees: หัวข้อ "failed after" ตามด้วยเวลาที่ใช้
                ref: packages/extension/src/chat/rail.ts#headerOf
                end: { turn: failed, reason: error }

    - id: batch
      beat:
        title: Geno ถาม PostToolBatch hook
        text: เมื่อทุก call ที่ model ขอในคำตอบนี้รันจบ ครบทุกชุด (ชุดคือกลุ่ม call ที่ Geno รันพร้อมกัน) Geno รัน `batch-guard.sh` ครั้งเดียว พร้อมรายการ call ทั้งหมดและผลของแต่ละตัว
        from: engine
        to: machine
        ask: hook ท้ายชุดตอบอะไร
      lane: policy
      at: hooks
      do: >-
        เมื่อทุกชุดของ turn รันจบ `toolHooks.batch` รัน PostToolBatch ครั้งเดียวด้วย `tool_calls` ซึ่งมีทุก call ที่รัน
        พร้อม `tool_use_id` และ `tool_response` ของแต่ละตัว
      ref: packages/engine/src/hooks.ts#HookSessions.toolHooks
      emits: [PostToolBatch, tool_calls]
      fork:
        ask: PostToolBatch hook ตอบอะไร
        options:
          - id: pass
            label: ผ่าน
            then: logged

          - id: blocks
            label: บล็อก
            steps:
              - lane: policy
                beat:
                  title: hook หลังทั้งชุดบล็อก
                  text: สคริปต์จบด้วย exit 2 และเขียน "too many commands in one turn" สำหรับ hook นี้ การบล็อกคือหยุดลูป
                  from: machine
                  to: engine
                at: hooks
                do: >-
                  สคริปต์จบด้วย exit 2 และเขียน "too many commands in one turn" ลง stderr (หรือพิมพ์ `decision: "block"`)
                  สำหรับ PostToolBatch การบล็อกคือหยุดลูป: ได้ทั้งโน้ต `blocking` และเหตุผลที่ให้หยุด
                ref: packages/core/src/hooks.ts#toolHookVerdict
                emits: [blocking]
              - lane: loop
                at: tools
                do: >-
                  `runTools` บันทึกผล โน้ตของ hook ทุกตัว แล้วบันทึก error ชนิด `blocked`:
                  "A PostToolBatch hook stopped the turn: too many commands in one turn"
                ref: "packages/engine/src/drive.ts#\"const message = `A ${stop.by} hook stopped the turn: ${stop.reason}`;\""
                emits: [tool-result, hook-context, blocked]
              - lane: server
                beat:
                  title: แชตขึ้นแถบ error
                  text: ขั้นของคำสั่งขึ้นว่าเสร็จ และท้าย turn มีแถบ error ที่บอกเหตุผลของ hook
                  from: panel
                  to: you
                  sees:
                    kind: notice
                    text: "A PostToolBatch hook stopped the turn: too many commands in one turn"
                    tone: error
                at: updates
                do: >-
                  ผลไปเป็น `tool_call_update` และ error ไปเป็น `agent_message_chunk` พร้อม `TURN_ERROR_META`
                ref: packages/engine/src/session-replay.ts#errorUpdate
                emits: [tool_call_update, TURN_ERROR_META]
              - lane: panel
                at: rail
                alongside: true
                do: ขั้นของคำสั่งขึ้นเครื่องหมายเสร็จ และท้าย turn ขึ้นแถบ error
                sees: >-
                  แถบ error "A PostToolBatch hook stopped the turn: too many commands in one turn"
                ref: packages/extension/src/chat/render.ts#errorBlock
              - lane: loop
                beat:
                  title: Turn ล้มเหลว
                  text: Geno ไม่เรียก model อีก งานจบแบบ failed และปุ่ม Send กลับมา
                  from: engine
                  to: panel
                  end: Turn ล้มเหลวเพราะ hook
                  sees:
                    kind: composer
                    state: idle
                    header: failed after ...
                at: step
                do: >-
                  `loopStep` เห็น error ชนิด `blocked` จึงตัดสิน `done(error)` model ไม่ถูกเรียกอีก
                ref: packages/core/src/loop.ts#ERROR_REASON
                emits: [error]
                phase: ending
              - lane: server
                at: turns
                do: >-
                  `runTurn` ใช้ `TURN_ENDS.error`: `stopReason: end_turn` กับงานที่จบแบบ `failed`
                ref: packages/engine/src/serve.ts#TURN_ENDS
                emits: [TURN_END_META]
              - lane: panel
                at: rail
                do: หัวข้อเปลี่ยนเป็น "failed after ..." และปุ่ม Send กลับมา
                sees: หัวข้อ "failed after" ตามด้วยเวลาที่ใช้
                ref: packages/extension/src/chat/rail.ts#headerOf
                end: { turn: failed, reason: error }

    - id: logged
      beat:
        title: Geno เก็บข้อความของ hook ไว้ให้ model
        text: Geno บันทึกผลของคำสั่งก่อน แล้วบันทึกข้อความของ hook ผูกกับ call นั้น แผงแชตแสดงแค่ผลเทสต์ ข้อความของ hook มีแต่ model ที่ได้อ่าน
        from: engine
        to: engine
        sees:
          kind: step
          label: npm test
          status: done
      lane: loop
      at: tools
      do: >-
        `runTools` บันทึก `tool-result` ก่อน แล้วบันทึกโน้ตของ hook เป็น event `hook-context` ที่ผูกกับ `toolUseId` ของ call
        แผงแชตไม่แสดง event นี้ ข้อความของ hook มีแต่ model ที่ได้อ่าน
      ref: "packages/engine/src/drive.ts#\"for (const said of outcome.said) if (said?.context !== undefined) await record({ ...said.context, seq: nextSeq(events) });\""
      emits: [tool-result, hook-context]

    - id: shown
      lane: panel
      at: rail
      alongside: true
      do: ขั้นของคำสั่งหยุดหมุนและแสดงผลของเทสต์
      sees: ขั้น "npm test" ขึ้นเครื่องหมายเสร็จ ผลลัพธ์พับอยู่ใต้ขั้น
      ref: packages/extension/src/chat/webview.ts#render

    - use: model-call
      beat:
        title: Geno ส่งผลพร้อมข้อความของ hook ให้ model
        text: >-
          ในคำขอถัดไป ข้อความของ hook ต่อท้ายผลของ `npm test` ขึ้นต้นด้วย `[Geno] PostToolUse:Bash hook` คำว่า `[Geno]` บอก model ว่าเป็นโน้ตจาก Geno ไม่ใช่ output ของคำสั่ง
          การ์ดข้างล่างเป็นการบันทึกที่รัน Geno จริงกับ model จำลองที่ตอบตามบทที่เขียนไว้ก่อน ในทางเพิ่มบริบท hook ของการบันทึกนี้พิมพ์ "2 snapshot files changed"
          ดูข้อความผู้ใช้ข้อความสุดท้าย บล็อก `tool_result` มีสองส่วน ส่วนแรกคือ output ของ `npm test` ส่วนที่ไฮไลต์คือโน้ตของ hook
          ในทางบล็อก ส่วนที่สองจะเป็น `[Geno] PostToolUse:Bash hook blocking error: ...` แทน
        from: engine
        to: model
        sees:
          kind: payload
          source: packages/docs/src/data/recorded/hook-post-tool.jsonl#line=4
          select: messages[2]
          highlight: ['content[0].content[1].text']

    - id: reads
      beat:
        title: Model อ่านผลและข้อความของ hook
        text: >-
          ในทางเพิ่มบริบท model รู้ว่า snapshot เปลี่ยน ในทางบล็อก model รู้ว่า lint ล้มเหลว แล้วมันตัดสินเองว่าจะทำอะไรต่อ
          การ์ดข้างล่างเป็น event หนึ่งใน stream ของคำตอบจากการบันทึกเดียวกับการ์ดก่อน ในการบันทึกนี้ ข้อความมาเป็นสองชิ้น ชิ้นแรกคือ "The tests pass."
          ชิ้นที่ไฮไลต์บอกว่า model เอาข้อความของ hook มาเตือนคุณ model รู้แค่ว่าเป็น PostToolUse hook ตามที่โน้ตบอก ไม่รู้ชื่อสคริปต์ คำตอบนี้จบด้วย `stop_reason: end_turn` (model ตอบเสร็จและไม่ขอ tool เพิ่ม)
        from: model
        to: engine
        end: Model อ่านข้อความแล้วตอบ
        sees:
          kind: payload
          source: packages/docs/src/data/recorded/hook-post-tool.jsonl#line=5
          select: '[3]'
          highlight: [data.delta.text]
      lane: model
      do: >-
        ในคำขอนี้ ข้อความของ hook ต่อท้าย `tool_result` ของ `npm test` เช่น
        "[Geno] PostToolUse:Bash hook additional context: 2 snapshot files changed"
        หรือ "[Geno] PostToolUse:Bash hook blocking error: lint failed in src/date.ts" model อ่านแล้วตัดสินเองว่าจะทำอะไรต่อ
        ในการบันทึก model ตอบเป็นข้อความและจบด้วย `stop_reason: end_turn` ถ้ามันขอ tool อีก turn จะทำต่อ
      ref: packages/core/src/hooks.ts#hookNoteText
      emits: [tool_result, end_turn]
      end: { turn: done, reason: end_turn }
---

[hook](/start/glossary/) หลังรันไม่ได้ตัดสินว่า call รันหรือไม่ call รันไปแล้ว สิ่งที่มันทำได้คือพูดกับ model หรือหยุดลูปก่อนเรียก model ครั้งต่อไป ซึ่งทำให้ [turn](/start/glossary/) จบ

| hook | ตอบ | ผล |
| --- | --- | --- |
| PostToolUse / PostToolUseFailure | `additionalContext` | ข้อความต่อท้ายผลของ call นั้น |
| PostToolUse / PostToolUseFailure | exit 2 หรือ `decision: "block"` | ข้อความ `blocking error` ต่อท้ายผล ลูปไม่หยุด |
| ทุกตัว | `continue: false` | turn จบแบบ failed หลังชุดนี้ |
| PostToolBatch | exit 2 หรือ `decision: "block"` | turn จบแบบ failed หลังชุดนี้ |
| PostToolBatch | `additionalContext` | ข้อความไปกับคำขอถัดไป ไม่ผูกกับ call ใด |

สิ่งที่ควรสังเกต

- **hook หลัง call รันก่อนชุดถัดไปเริ่ม** ใน batch ที่รันพร้อมกัน hook ของแต่ละ call รันทันทีที่ call นั้นจบ
- **PostToolBatch รันครั้งเดียวต่อคำตอบของ model ที่ขอ tool** หลังทุกชุดของคำตอบนั้น ไม่ใช่หลังแต่ละชุด
- **ผลกับโน้ตถูกบันทึกพร้อมกันตอนท้าย** ถ้าผู้ใช้กด Stop ระหว่างนั้น โน้ตของ hook ไม่ถูกบันทึก
- **ข้อความของ hook ไม่ขึ้นในแผงแชต** ข้อผิดพลาดของตัว hook เอง (เช่น timeout) ไปที่ output channel "Geno engine"
