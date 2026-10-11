---
title: PreToolUse ตัดสิน call ก่อนรัน
description: hook ที่ตั้งไว้ได้ดู call ทุกตัวก่อนรัน มันปฏิเสธ call อนุญาตพร้อมแก้ input หรือหยุดทั้ง turn ก็ได้
tableOfContents: false
sidebar:
  order: 2
scenario:
  surface: vscode
  given:
    - workspace ที่เชื่อถือแล้ว มี PreToolUse hook ที่ matcher เป็น `Bash` ใน `.claude/settings.json` ซึ่งรันสคริปต์ `guard.sh`
    - เปิด Geno ในโหมด Ask มี turn ทำงานอยู่
  trigger: >-
    โมเดลขอรัน `bash` ด้วยคำสั่ง `pnpm deploy --prod`
  covers: [hook.pretooluse-deny, hook.pretooluse-allow-rewrite, hook.pretooluse-continue-false]
  related: [hook.pretooluse-ask, hook.permission-request, hook.user-prompt-submit, perm.ask-allow]
  steps:
    - id: wants
      lane: model
      do: >-
        โมเดลขอเรียก `bash` ด้วยคำสั่ง `pnpm deploy --prod` และจบคำตอบด้วย `stop_reason: tool_use`
      ref: "packages/engine/src/gateway.ts#\"stopReason: message.stop_reason,\""
      emits: [tool_use]
      phase: calling-model

    - id: decide
      lane: loop
      at: step
      do: >-
        `drive` บันทึก event `assistant` แล้ว `loopStep` เห็น `tool_use` ที่ยังไม่มีผล จึงตัดสินว่า `run-tools`
      ref: packages/core/src/loop.ts#loopStep
      emits: [run-tools]
      phase: running-tools

    - id: hook
      lane: policy
      at: hooks
      do: >-
        ก่อน call แรกของ turn จะเริ่ม `toolHooks.decide` รัน PreToolUse ให้ทุก call ส่ง JSON ทาง stdin ในรูปของ Claude Code:
        `tool_name: "Bash"`, `tool_input.command` และ `tool_use_id` ถ้ามีหลาย hook `preToolDecision` เลือกคำตอบที่เข้มที่สุด
        (deny ก่อน defer ก่อน ask ก่อน allow)
      ref: packages/core/src/hooks.ts#preToolDecision
      emits: [PreToolUse]
      fork:
        ask: hook ตอบอะไร
        options:
          - id: deny
            label: ปฏิเสธ
            steps:
              - lane: policy
                at: hooks
                do: >-
                  สคริปต์จบด้วย exit 2 และเขียน "deploys go through CI" ลง stderr
                  (หรือพิมพ์ JSON `permissionDecision: "deny"` พร้อม `permissionDecisionReason`)
                  call นี้ได้ขั้น `refuse` พร้อมบันทึกการอนุญาต `rule: hook-deny`, `verdict: deny`
                ref: "packages/engine/src/hooks.ts#\"const record: ApprovalRecord = { mode, rule: 'hook-deny'\""
                emits: [hook-deny, deny]
              - lane: loop
                at: tools
                do: >-
                  call ยังขึ้นเป็นขั้นในแผงแชต แต่ `callOf` ไม่รันอะไร ได้ผลสถานะ `denied` ทันที
                  ข้อความผลคือ "[Geno] PreToolUse:Bash hook error: deploys go through CI" ไม่มี card ไม่มี classifier
                  และ PostToolUse ไม่ทำงานกับ call ที่ถูกปฏิเสธ
                ref: "packages/engine/src/drive.ts#\"if (step?.kind === 'refuse') return { status: 'denied'\""
                emits: [denied]
              - use: tool-result-returns
              - lane: panel
                at: rail
                do: ขั้นของคำสั่งขึ้นป้ายว่า hook ปฏิเสธ พร้อมเหตุผลของ hook
                sees: "Denied by a hook · Deploys go through CI"
                ref: packages/extension/src/chat/session-updates.ts#denialOf
              - lane: loop
                at: step
                do: >-
                  การปฏิเสธจาก hook ไม่ใช่การปฏิเสธของผู้ใช้ `loopStep` จึงตัดสิน `call-model` ตามปกติ
                  โมเดลจะอ่านเหตุผลใน `tool_result` แล้วหาทางอื่น เช่นบอกผู้ใช้ให้ deploy ผ่าน CI
                ref: packages/core/src/loop.ts#loopStep
                emits: [call-model]
                phase: calling-model
                end: { turn: continues, reason: call-model }

          - id: rewrite
            label: อนุญาตและแก้ input
            steps:
              - lane: policy
                at: hooks
                do: >-
                  สคริปต์พิมพ์ JSON `permissionDecision: "allow"` พร้อม `updatedInput` ที่เปลี่ยนคำสั่งเป็น `pnpm deploy --prod --dry-run`
                  input ใหม่แทนที่ input ของโมเดลทั้งก้อน และ call ได้ขั้น `run` ที่บอกว่า hook อนุญาตแล้ว
                ref: "packages/engine/src/hooks.ts#\"const updated = decision.kind === 'none' || decision.input === undefined ? use\""
                emits: [allow, updatedInput]
              - lane: policy
                at: rules
                do: >-
                  `ruledDenial` ยังตรวจกฎ deny ของ workspace ก่อน แต่การอนุญาตของ hook ตอบคำถามแทนผู้ใช้
                  คำสั่งที่ปกติต้องถามจึงไม่ขึ้นการ์ด และข้าม classifier ยกเว้นคำสั่งที่กฎกำหนดว่าต้องถามเสมอ
                ref: packages/core/src/permission-rules.ts#ruledDenial
              - lane: tool
                at: shell
                do: >-
                  `bash` รันคำสั่งที่ hook แก้แล้วใน sandbox การอนุญาตของ hook ไม่ยกเว้น sandbox
                ref: "packages/engine/src/tools/agent.ts#\"tools.sandbox.run(command\""
              - use: tool-result-returns
              - lane: loop
                at: step
                do: >-
                  log เก็บ `tool_use` ตามที่โมเดลส่ง ส่วน PostToolUse hook เห็น input ที่รันจริง
                  `loopStep` ตัดสิน `call-model` โมเดลได้อ่านผลของ `--dry-run`
                ref: packages/core/src/loop.ts#loopStep
                emits: [call-model]
                phase: calling-model
                end: { turn: continues, reason: call-model }

          - id: stop
            label: หยุดทั้ง turn
            steps:
              - lane: policy
                at: hooks
                do: >-
                  สคริปต์พิมพ์ JSON `{"continue": false, "stopReason": "production is frozen"}`
                  call นี้ถูกปฏิเสธด้วยเหตุผลนั้นก่อน และ hook ขอให้หยุดหลังชุดนี้
                ref: packages/core/src/hooks.ts#toolHookSaid
                emits: [continue]
              - lane: loop
                at: tools
                do: >-
                  call ได้ผล `denied` call อื่นของ turn เดียวกันที่ hook ไม่ได้ปฏิเสธยังรันตามปกติ
                  เมื่อบันทึกผลครบ `runTools` บันทึก event `error` ชนิด `blocked`: "A PreToolUse hook stopped the turn: production is frozen"
                ref: "packages/engine/src/drive.ts#\"const message = `A ${stop.by} hook stopped the turn: ${stop.reason}`;\""
                emits: [denied, blocked]
              - lane: server
                at: updates
                do: >-
                  ผลของ call ไปเป็น `tool_call_update` และ error ไปเป็น `agent_message_chunk` พร้อม `TURN_ERROR_META`
                ref: packages/engine/src/session-replay.ts#errorUpdate
                emits: [tool_call_update, TURN_ERROR_META]
              - lane: panel
                at: rail
                alongside: true
                do: ขั้นของคำสั่งขึ้นป้ายปฏิเสธ และท้าย turn ขึ้นแถบ error
                sees: >-
                  "Denied by a hook · Production is frozen" และแถบ error "A PreToolUse hook stopped the turn: production is frozen"
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
                do: หัวข้อเปลี่ยนเป็น "failed after ..."
                sees: หัวข้อ "failed after 4s" และปุ่ม Send กลับมา
                ref: packages/extension/src/chat/rail.ts#headerOf
                end: { turn: failed, reason: error }
---

PreToolUse ทำงานก่อนการตรวจสิทธิ์ของ Geno เอง และตัดสิน call ทุกตัวของ turn ก่อน call แรกจะเริ่ม
เหมือน Claude Code การจัดชุดเกิดหลังจากนั้น call ที่ hook ปฏิเสธหรือถามผู้ใช้จึงไม่รันพร้อม call อื่น

| hook ตอบ | call | turn |
| --- | --- | --- |
| deny (exit 2 หรือ `permissionDecision: "deny"`) | ไม่รัน ผล `denied` | ทำต่อ โมเดลอ่านเหตุผล |
| allow + `updatedInput` | รันด้วย input ใหม่ ไม่ถามผู้ใช้ | ทำต่อ |
| ask | ขึ้นการ์ดถามผู้ใช้ก่อนการตรวจของ Geno | ตามคำตอบ ดู [โหมด Ask ขออนุญาต](/scenarios/perm/ask-mode-bash-approval/) |
| defer หรือไม่ตอบ | ไปตามการตรวจของ Geno | ตามปกติ |
| `continue: false` | ไม่รัน | จบแบบ failed หลังชุดนี้ |

สิ่งที่ควรสังเกต

- **การปฏิเสธของ hook ต่างจาก Reject ของผู้ใช้** ผลเป็น `denied` (`ToolDenied`) ไม่ใช่ `rejected` ชุดถัดไปจึงยังรัน และ turn ไม่จบ
- **hook allow ไม่ข้ามกฎ deny** กฎ deny ของ workspace และคำสั่งที่ต้องถามเสมอยังมีผล การอนุญาตของ hook แค่ตอบคำถามแทนผู้ใช้
- **log เก็บสิ่งที่โมเดลขอ** `updatedInput` ไม่ได้แก้ `tool_use` ใน log การเล่นซ้ำจึงเห็นคำสั่งเดิมของโมเดล
