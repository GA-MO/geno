---
title: "hook PreToolUse ตัดสิน call ก่อนรัน"
description: hook ที่ตั้งไว้ได้ดู call ทุกตัวก่อนรัน มันปฏิเสธ call อนุญาตพร้อมแก้ input ขอให้ถามผู้ใช้ หรือหยุดทั้ง turn ก็ได้
scenario:
  surface: vscode
  given:
    - workspace ที่เชื่อถือแล้ว มี PreToolUse hook ที่ matcher เป็น `Bash` ใน `.claude/settings.json` ซึ่งรันสคริปต์ `guard.sh`
    - เปิด Geno ในโหมด Ask มี turn ทำงานอยู่
  trigger: >-
    model ขอรัน `bash` ด้วยคำสั่ง `pnpm deploy --prod`
  covers: [hook.pretooluse-deny, hook.pretooluse-ask, hook.pretooluse-allow-rewrite, hook.pretooluse-continue-false]
  related: [hook.permission-request, hook.user-prompt-submit, perm.ask-allow]
  steps:
    - id: wants
      beat:
        title: Model ขอรัน `pnpm deploy --prod`
        text: model อยากปล่อยงานขึ้น production จากเครื่องของคุณ
        from: model
        to: engine
      lane: model
      do: >-
        model ขอเรียก `bash` ด้วยคำสั่ง `pnpm deploy --prod` และจบคำตอบด้วย `stop_reason: tool_use`
      ref: "packages/engine/src/gateway.ts#\"stopReason: message.stop_reason,\""
      emits: [tool_use]
      phase: calling-model

    - id: decide
      beat:
        title: Geno บันทึกคำขอแล้วเตรียมรัน
        text: ก่อน call แรกของรอบนี้จะเริ่ม Geno ให้ hook PreToolUse ดูทุก call ก่อน
        from: engine
        to: engine
      lane: loop
      at: step
      do: >-
        `drive` บันทึก event `assistant` แล้ว `loopStep` เห็น `tool_use` ที่ยังไม่มีผล จึงตัดสินว่า `run-tools`
      ref: packages/core/src/loop.ts#loopStep
      emits: [run-tools]
      phase: running-tools

    - id: hook
      beat:
        title: Geno ส่ง call ให้ `guard.sh`
        text: สคริปต์ได้ชื่อ tool และคำสั่งเป็น JSON ทาง stdin ถ้ามีหลาย hook Geno ใช้คำตอบที่เข้มที่สุด
        from: engine
        to: machine
        ask: hook ตอบอะไร
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
                beat:
                  title: hook ปฏิเสธ call
                  text: สคริปต์จบด้วย exit 2 และเขียน "deploys go through CI" Geno ไม่ขึ้นการ์ด และไม่ถาม classifier
                  from: machine
                  to: engine
                at: hooks
                do: >-
                  สคริปต์จบด้วย exit 2 และเขียน "deploys go through CI" ลง stderr
                  (หรือพิมพ์ JSON `permissionDecision: "deny"` พร้อม `permissionDecisionReason`)
                  call นี้ได้ขั้น `refuse` พร้อมบันทึกการอนุญาต `rule: hook-deny`, `verdict: deny`
                ref: "packages/engine/src/hooks.ts#\"const record: ApprovalRecord = { mode, rule: 'hook-deny'\""
                emits: [hook-deny, deny]
              - lane: loop
                beat:
                  title: Geno ไม่รันคำสั่ง
                  text: call ยังขึ้นเป็นขั้นในแชต แต่ไม่มีอะไรรัน ผลถึง model คือข้อความของ hook hook หลังรันก็ไม่ทำงานกับ call นี้
                  from: engine
                  to: model
                at: tools
                do: >-
                  call ยังขึ้นเป็นขั้นในแผงแชต แต่ `callOf` ไม่รันอะไร ได้ผลสถานะ `denied` ทันที
                  ข้อความผลคือ "[Geno] PreToolUse:Bash hook error: deploys go through CI" ไม่มี card ไม่มี classifier
                  และ PostToolUse ไม่ทำงานกับ call ที่ถูกปฏิเสธ ผลพาบันทึก `hook-deny` ไปด้วย update ปิดจึงมี `APPROVAL_META`
                ref: "packages/engine/src/drive.ts#\"if (step?.kind === 'refuse') return { status: 'denied'\""
                emits: [denied]
              - use: tool-result-returns
              - lane: panel
                beat:
                  title: แชตบอกว่า hook ปฏิเสธ
                  text: ขั้นของคำสั่งขึ้นป้ายว่า hook ปฏิเสธ พร้อมเหตุผลของ hook
                  from: panel
                  to: you
                  sees:
                    kind: step
                    label: pnpm deploy --prod
                    status: denied
                    note: Denied by a hook · Deploys go through CI.
                at: rail
                do: ขั้นของคำสั่งขึ้นป้ายว่า hook ปฏิเสธ พร้อมเหตุผลของ hook
                sees: "Denied by a hook · Deploys go through CI."
                ref: packages/extension/src/chat/session-updates.ts#denialOf
              - lane: loop
                beat:
                  title: Model อ่านเหตุผลของ hook
                  text: การปฏิเสธของ hook ไม่ใช่การปฏิเสธของคุณ turn จึงไม่จบ model อ่านเหตุผล แล้วหาทางอื่น เช่นบอกคุณให้ deploy ผ่าน CI
                  from: model
                  to: engine
                  end: Model หาทางอื่น
                at: step
                do: >-
                  การปฏิเสธจาก hook ไม่ใช่การปฏิเสธของผู้ใช้ `loopStep` จึงตัดสิน `call-model` ตามปกติ
                  model จะอ่านเหตุผลใน `tool_result` แล้วหาทางอื่น เช่นบอกผู้ใช้ให้ deploy ผ่าน CI
                ref: packages/core/src/loop.ts#loopStep
                emits: [call-model]
                phase: calling-model
                end: { turn: continues, reason: call-model }

          - id: rewrite
            label: อนุญาตและแก้ input
            steps:
              - lane: policy
                beat:
                  title: hook อนุญาตแล้วแก้คำสั่ง
                  text: hook ตอบ allow พร้อมคำสั่งใหม่ `pnpm deploy --prod --dry-run` ซึ่งแทนคำสั่งของ model ทั้งก้อน
                  from: machine
                  to: engine
                at: hooks
                do: >-
                  สคริปต์พิมพ์ JSON `permissionDecision: "allow"` พร้อม `updatedInput` ที่เปลี่ยนคำสั่งเป็น `pnpm deploy --prod --dry-run`
                  input ใหม่แทนที่ input ของ model ทั้งก้อน และ call ได้ขั้น `run` ที่บอกว่า hook อนุญาตแล้ว
                ref: "packages/engine/src/hooks.ts#\"const updated = decision.kind === 'none' || decision.input === undefined ? use\""
                emits: [allow, updatedInput]
              - lane: policy
                beat:
                  title: กฎ deny ของคุณยังมีผล
                  text: Geno ยังตรวจกฎ deny ของ workspace แต่การอนุญาตของ hook ตอบคำถามแทนคุณ การ์ดจึงไม่ขึ้น ยกเว้นคำสั่งที่กฎกำหนดว่าต้องถามเสมอ
                  from: engine
                  to: engine
                at: rules
                do: >-
                  `ruledDenial` ยังตรวจกฎ deny ของ workspace ก่อน แต่การอนุญาตของ hook ตอบคำถามแทนผู้ใช้
                  คำสั่งที่ปกติต้องถามจึงไม่ขึ้นการ์ด และข้าม classifier ยกเว้นคำสั่งที่กฎกำหนดว่าต้องถามเสมอ
                ref: packages/core/src/permission-rules.ts#ruledDenial
              - lane: tool
                beat:
                  title: คำสั่งที่แก้แล้วรันใน sandbox
                  text: การอนุญาตของ hook ไม่ยกเว้น sandbox log ยังเก็บคำสั่งตามที่ model ส่ง
                  from: engine
                  to: machine
                at: shell
                do: >-
                  `bash` รันคำสั่งที่ hook แก้แล้วใน sandbox การอนุญาตของ hook ไม่ยกเว้น sandbox
                ref: "packages/engine/src/tools/agent.ts#\"tools.sandbox.run(command\""
              - use: tool-result-returns
              - lane: loop
                beat:
                  title: Model อ่านผลของ `--dry-run`
                  text: Geno เรียก model อีกครั้ง model เห็นผลของคำสั่งที่ hook แก้
                  from: model
                  to: engine
                  end: Model อ่านผลแล้วทำต่อ
                at: step
                do: >-
                  log เก็บ `tool_use` ตามที่ model ส่ง ส่วน PostToolUse hook เห็น input ที่รันจริง
                  `loopStep` ตัดสิน `call-model` model ได้อ่านผลของ `--dry-run`
                ref: packages/core/src/loop.ts#loopStep
                emits: [call-model]
                phase: calling-model
                end: { turn: continues, reason: call-model }

          - id: ask
            label: ขอให้ถามผู้ใช้
            steps:
              - lane: policy
                beat:
                  title: hook ขอให้ถามคุณ
                  text: hook ตอบ ask พร้อมเหตุผล "touches production" แม้ในโหมด Auto Geno ก็ไม่ให้ classifier ตัดสินแทน
                  from: machine
                  to: engine
                at: hooks
                do: >-
                  สคริปต์พิมพ์ JSON `permissionDecision: "ask"` พร้อม `permissionDecisionReason: "touches production"`
                  call ได้ขั้น `ask` ที่ถือคำถามจาก `hookAskDenial`: "A PreToolUse hook [settings] asks first: touches production."
                  call ที่รอคำตอบไม่รันพร้อม call อื่น
                ref: packages/core/src/approval.ts#hookAskDenial
                emits: [hook-ask]
              - lane: loop
                at: tools
                do: >-
                  `asking` ห่อ executor ของ `bash` ไว้: ก่อนการตรวจของ `bash` เอง `toolHooks.confirm` ส่งคำถามของ hook ให้ `settle`
                ref: "packages/engine/src/drive.ts#\"const approval = await mode.toolHooks!.confirm(step.question, toolCtx);\""
              - lane: policy
                at: settle
                do: >-
                  คำถามของ hook มี verdict `ask` ไม่ใช่ `classify` จึงไม่ผ่าน classifier แม้ในโหมด Auto
                  PermissionRequest hook (ถ้ามี) ได้ตอบก่อน เมื่อไม่มีก็ส่งต่อให้ผู้ใช้ผ่าน `approval.approve`
                ref: packages/engine/src/tools/agent.ts#settle
              - lane: server
                beat:
                  title: Geno หยุด turn แล้วถามคุณ
                  text: ถ้ามี hook PermissionRequest มันได้ตอบก่อน เมื่อไม่มี Geno ส่งคำขอ permission ให้ VS Code งานใน Tasks ขึ้นว่ารอคุณ
                  from: engine
                  to: panel
                  sees:
                    kind: task
                    title: pnpm deploy --prod
                    status: needs-input
                at: approvals
                do: >-
                  `editorTurn.approve` ส่งคำขอ ACP `session/request_permission` ที่มีเหตุผลของ hook เป็น `reason`
                  งานในแผง Tasks เปลี่ยนเป็น `needs-input`
                ref: packages/engine/src/serve.ts#editorTurn.approve
                emits: [requestPermission, needs-input]
                phase: waiting-user
              - lane: editor
                at: chat
                do: >-
                  `askPermission` ส่ง action `permission` ให้ webview และโฟกัสแผงแชต
                ref: packages/extension/src/chat/chat.ts#Chat.askPermission
                emits: [permission]
              - lane: panel
                beat:
                  title: คุณเห็นการ์ด “Run this command?”
                  text: เหตุผลบนการ์ดคือข้อความของ hook ต่อท้ายวลีมาตรฐานของการ์ด
                  from: panel
                  to: you
                  sees:
                    kind: permission
                    command: pnpm deploy --prod
                    reason: "Geno asks because it uses A PreToolUse hook [settings] asks first: touches production.."
                    options:
                      - Allow
                      - Deny
                      - No, and tell the agent…
                at: card
                do: >-
                  แผงแชตแสดงการ์ดคำสั่ง เหตุผลบนการ์ดคือข้อความของ hook ต่อท้ายวลี "Geno asks because it uses"
                sees: >-
                  การ์ด "Run this command?" คำสั่ง `pnpm deploy --prod`
                  และบรรทัด "Geno asks because it uses A PreToolUse hook [settings] asks first: touches production.."
                  ปุ่ม [Allow] [Deny] [No, and tell the agent…]
                ref: packages/extension/src/chat/render.ts#COMMAND_FACE
              - lane: user
                beat:
                  title: คุณกด Allow
                  text: การ์ดย่อเหลือ Allowed Geno จดว่าคุณเป็นคนอนุญาต และ tool ไม่ถามซ้ำ แต่กฎ deny ของ workspace ยังมีผล
                  from: you
                  to: panel
                do: ผู้ใช้อ่านแล้วกด Allow
              - lane: editor
                at: chat
                do: >-
                  การ์ดย่อเหลือ Allowed แล้ว `askPermission` ตอบ engine ว่า `selected` ตัวเลือก `allow`
                ref: packages/extension/src/chat/chat.ts#Chat.askPermission
                emits: [permission-done]
              - lane: policy
                at: settle
                do: >-
                  `settle` คืนบันทึก `decidedBy: user, verdict: allow` แล้ว executor ของ `bash` รันด้วย `hookAllowed`
                  การตรวจของ `bash` เองจึงไม่ถามซ้ำ แต่กฎ deny ของ workspace และคำสั่งที่ต้องถามเสมอยังมีผล
                ref: "packages/engine/src/drive.ts#\"const reply = await own.run(raw, { ...toolCtx, hookAllowed: true });\""
                phase: running-tools
              - lane: tool
                beat:
                  title: คำสั่งรันใน sandbox
                  text: "`pnpm deploy --prod` รัน ผลพาบันทึกว่าคุณเป็นคนอนุญาต"
                  from: engine
                  to: machine
                at: shell
                do: >-
                  `bash` รัน `pnpm deploy --prod` ใน sandbox ผลแนบบันทึกว่าผู้ใช้อนุญาต update ปิดจึงมี `APPROVAL_META`
                ref: "packages/engine/src/tools/agent.ts#\"tools.sandbox.run(command\""
              - use: tool-result-returns
              - lane: loop
                beat:
                  title: Model อ่านผลของคำสั่ง
                  text: Geno เรียก model อีกครั้ง ถ้าคุณกด Deny แทน turn จะจบเหมือนการ์ดของโหมด Ask
                  from: model
                  to: engine
                  end: Model อ่านผลแล้วทำต่อ
                at: step
                do: >-
                  `loopStep` ตัดสิน `call-model` model ได้อ่านผลของคำสั่ง
                  (ถ้าผู้ใช้กด Deny call ได้ `ToolRejected` และ turn จบแบบ `done (end_turn)` เหมือนการ์ดของโหมด Ask)
                ref: packages/core/src/loop.ts#loopStep
                emits: [call-model]
                phase: calling-model
                end: { turn: continues, reason: call-model }

          - id: stop
            label: หยุดทั้ง turn
            steps:
              - lane: policy
                beat:
                  title: hook สั่งหยุดทั้ง turn
                  text: 'hook ตอบ `continue: false` พร้อมเหตุผล "production is frozen" call นี้ถูกปฏิเสธ call อื่นใน turn เดียวกันที่ hook ไม่ได้ปฏิเสธยังรันตามปกติ แล้ว Geno บันทึก error ว่า hook หยุด turn'
                  from: machine
                  to: engine
                at: hooks
                do: >-
                  สคริปต์พิมพ์ JSON `{"continue": false, "stopReason": "production is frozen"}`
                  call นี้ถูกปฏิเสธด้วยเหตุผลนั้นก่อน และ hook ขอให้หยุดหลังชุดนี้
                ref: packages/core/src/hooks.ts#toolHookSaid
                emits: [continue]
              - lane: loop
                at: tools
                do: >-
                  call ได้ผล `denied` ที่พาบันทึก `hook-deny` (`APPROVAL_META`) call อื่นของ turn เดียวกันที่ hook ไม่ได้ปฏิเสธยังรันตามปกติ
                  เมื่อบันทึกผลครบ `runTools` บันทึก event `error` ชนิด `blocked`: "A PreToolUse hook stopped the turn: production is frozen"
                ref: "packages/engine/src/drive.ts#\"const message = `A ${stop.by} hook stopped the turn: ${stop.reason}`;\""
                emits: [denied, blocked]
              - lane: server
                beat:
                  title: แชตขึ้นแถบ error
                  text: ขั้นของคำสั่งขึ้นป้ายปฏิเสธ และท้าย turn มีแถบ error ที่บอกเหตุผลของ hook
                  from: panel
                  to: you
                  sees:
                    - kind: step
                      label: pnpm deploy --prod
                      status: denied
                      note: Denied by a hook · Production is frozen.
                    - kind: notice
                      text: "A PreToolUse hook stopped the turn: production is frozen"
                      tone: error
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
                  "Denied by a hook · Production is frozen." และแถบ error "A PreToolUse hook stopped the turn: production is frozen"
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
                    header: failed after 4s
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
                do: หัวข้อเปลี่ยนเป็น "failed after ..."
                sees: หัวข้อ "failed after 4s" และปุ่ม Send กลับมา
                ref: packages/extension/src/chat/rail.ts#headerOf
                end: { turn: failed, reason: error }
---

PreToolUse ทำงานก่อนการตรวจสิทธิ์ของ Geno เอง และตัดสิน call ทุกตัวของ turn ก่อน call แรกจะเริ่ม
เหมือน Claude Code การจัดชุดเกิดหลังจากนั้น call ที่ hook ปฏิเสธหรือถามผู้ใช้จึงไม่รันพร้อม call อื่น

| hook ตอบ | call | turn |
| --- | --- | --- |
| deny (exit 2 หรือ `permissionDecision: "deny"`) | ไม่รัน ผล `denied` | ทำต่อ model อ่านเหตุผล |
| allow + `updatedInput` | รันด้วย input ใหม่ ไม่ถามผู้ใช้ | ทำต่อ |
| ask | ขึ้นการ์ดถามผู้ใช้ก่อนการตรวจของ Geno ทุกโหมด รวมถึง Auto | ตามคำตอบ เหมือน [โหมด Ask ขออนุญาต](/scenarios/perm/ask-mode-bash-approval/) |
| defer หรือไม่ตอบ | ไปตามการตรวจของ Geno | ตามปกติ |
| `continue: false` | ไม่รัน | จบแบบ failed หลังชุดนี้ |

สิ่งที่ควรสังเกต

- **การปฏิเสธของ hook ต่างจาก Reject ของผู้ใช้** ผลเป็น `denied` (`ToolDenied`) ไม่ใช่ `rejected` ชุดถัดไปจึงยังรัน และ turn ไม่จบ
- **hook allow ไม่ข้ามกฎ deny** กฎ deny ของ workspace และคำสั่งที่ต้องถามเสมอยังมีผล การอนุญาตของ hook แค่ตอบคำถามแทนผู้ใช้
- **log เก็บสิ่งที่ model ขอ** `updatedInput` ไม่ได้แก้ `tool_use` ใน log การเล่นซ้ำจึงเห็นคำสั่งเดิมของ model
- **การ์ดของ hook ask อ่านแปลก** (อ่านจากโค้ด) การ์ดคำสั่งเติมเหตุผลต่อท้าย "Geno asks because it uses" เสมอ
  แต่เหตุผลของ `hook-ask` เป็นประโยคเต็ม ("A PreToolUse hook [settings] asks first: ...") ผู้ใช้จึงเห็นประโยคซ้อนกันและจุดสองตัวท้ายบรรทัด
