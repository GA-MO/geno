---
title: PostToolUse และ PostToolBatch หลังคำสั่งรัน
description: hook หลัง call เพิ่มข้อความให้โมเดลอ่านคู่กับผล บล็อก หรือหยุด turn และ hook หลังทั้งชุดหยุดลูปก่อนเรียกโมเดลได้
tableOfContents: false
sidebar:
  order: 4
scenario:
  surface: vscode
  given:
    - workspace ที่เชื่อถือแล้ว `.claude/settings.json` มี PostToolUse hook ที่ matcher เป็น `Bash` ซึ่งรัน `lint-after.sh`
      และ PostToolBatch hook ที่รัน `batch-guard.sh`
    - โหมด Ask มี turn ทำงานอยู่ คำสั่ง `pnpm test` อยู่ใน safe list
  trigger: >-
    โมเดลขอรัน `bash` ด้วยคำสั่ง `pnpm test`
  covers: [hook.post-tool, hook.post-tool-batch-blocks]
  related: [hook.pretooluse-deny, hook.stop-keeps-going, tool.bash-safe-runs]
  steps:
    - id: wants
      lane: model
      do: >-
        โมเดลขอเรียก `bash` ด้วยคำสั่ง `pnpm test` และจบคำตอบด้วย `stop_reason: tool_use`
      ref: "packages/engine/src/gateway.ts#\"stopReason: message.stop_reason,\""
      emits: [tool_use]
      phase: calling-model

    - use: tool-call-opens

    - id: run
      lane: tool
      at: shell
      do: >-
        `bash` รัน `pnpm test` ใน sandbox เทสต์ผ่านและคำสั่งจบด้วย exit 0
      ref: "packages/engine/src/tools/agent.ts#\"tools.sandbox.run(command\""

    - id: after
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
                at: hooks
                do: >-
                  สคริปต์จบด้วย exit 2 และเขียน "lint failed in src/date.ts" ลง stderr (หรือพิมพ์ `decision: "block"` พร้อม `reason`)
                  หลัง call ที่รันไปแล้ว การบล็อกไม่ย้อนผล มันกลายเป็นโน้ตชนิด `blocking` ที่โมเดลจะอ่าน และไม่หยุดลูป
                ref: packages/core/src/hooks.ts#toolHookVerdict
                emits: [blocking]

          - id: stop
            label: "continue: false"
            steps:
              - lane: policy
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
                at: step
                do: >-
                  `loopStep` เห็น error ชนิด `blocked` จึงตัดสิน `done(error)` โมเดลไม่ได้อ่านผลของ `pnpm test`
                ref: packages/core/src/loop.ts#ERROR_REASON
                emits: [error]
                phase: ending
              - lane: panel
                at: rail
                do: หัวข้อเปลี่ยนเป็น "failed after ..." และปุ่ม Send กลับมา
                sees: หัวข้อ "failed after 9s"
                ref: packages/extension/src/chat/rail.ts#headerOf
                end: { turn: failed, reason: error }

    - id: batch
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
                at: step
                do: >-
                  `loopStep` เห็น error ชนิด `blocked` จึงตัดสิน `done(error)` โมเดลไม่ถูกเรียกอีก
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
                sees: หัวข้อ "failed after 9s"
                ref: packages/extension/src/chat/rail.ts#headerOf
                end: { turn: failed, reason: error }

    - id: logged
      lane: loop
      at: tools
      do: >-
        `runTools` บันทึก `tool-result` ก่อน แล้วบันทึกโน้ตของ hook เป็น event `hook-context` ที่ผูกกับ `toolUseId` ของ call
        แผงแชตไม่แสดง event นี้ ข้อความของ hook มีแต่โมเดลที่ได้อ่าน
      ref: "packages/engine/src/drive.ts#\"for (const said of outcome.said) if (said?.context !== undefined) await record({ ...said.context, seq: nextSeq(events) });\""
      emits: [tool-result, hook-context]

    - id: shown
      lane: panel
      at: rail
      alongside: true
      do: ขั้นของคำสั่งหยุดหมุนและแสดงผลของเทสต์
      sees: ขั้น "pnpm test" ขึ้นเครื่องหมายเสร็จ ผลลัพธ์พับอยู่ใต้ขั้น
      ref: packages/extension/src/chat/webview.ts#render

    - use: model-call

    - id: reads
      lane: model
      do: >-
        ในคำขอนี้ ข้อความของ hook ต่อท้าย `tool_result` ของ `pnpm test` เช่น
        "[Geno] PostToolUse:Bash hook additional context: 2 snapshot files changed"
        หรือ "[Geno] PostToolUse:Bash hook blocking error: lint failed in src/date.ts" โมเดลอ่านแล้วทำงานต่อ
      ref: packages/core/src/hooks.ts#hookNoteText
      emits: [tool_result]
      end: { turn: continues, reason: call-model }
---

hook หลังรันไม่ได้ตัดสินว่า call รันหรือไม่ call รันไปแล้ว สิ่งที่มันทำได้คือพูดกับโมเดล หรือหยุดลูปก่อนเรียกโมเดลครั้งต่อไป

| hook | ตอบ | ผล |
| --- | --- | --- |
| PostToolUse / PostToolUseFailure | `additionalContext` | ข้อความต่อท้ายผลของ call นั้น |
| PostToolUse / PostToolUseFailure | exit 2 หรือ `decision: "block"` | ข้อความ `blocking error` ต่อท้ายผล ลูปไม่หยุด |
| ทุกตัว | `continue: false` | turn จบแบบ failed หลังชุดนี้ |
| PostToolBatch | exit 2 หรือ `decision: "block"` | turn จบแบบ failed หลังชุดนี้ |
| PostToolBatch | `additionalContext` | ข้อความไปกับคำขอถัดไป ไม่ผูกกับ call ใด |

สิ่งที่ควรสังเกต

- **hook หลัง call รันก่อน call ถัดไปเริ่ม** ใน batch ที่รันพร้อมกัน hook ของแต่ละ call รันทันทีที่ call นั้นจบ
- **PostToolBatch รันครั้งเดียวต่อ turn ของเครื่องมือ** หลังทุกชุด ไม่ใช่หลังแต่ละชุด
- **ผลกับโน้ตถูกบันทึกพร้อมกันตอนท้าย** ถ้าผู้ใช้กด Stop ระหว่างนั้น โน้ตของ hook ไม่ถูกบันทึก
- **ข้อความของ hook ไม่ขึ้นในแผงแชต** ข้อผิดพลาดของตัว hook เอง (เช่น timeout) ไปที่ output channel "Geno engine"
