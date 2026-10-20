---
title: "hook PermissionRequest ตอบ permission แทนคุณ"
description: คำสั่งที่ปกติต้องขึ้นการ์ด hook PermissionRequest ได้ตอบก่อน มันอนุญาต อนุญาตพร้อมแก้ input ปฏิเสธ หรือปฏิเสธแล้วจบ turn ก็ได้
scenario:
  surface: vscode
  given:
    - workspace ที่เชื่อถือแล้ว มี PermissionRequest hook ที่ matcher เป็น `Bash` ใน `.claude/settings.json` ซึ่งรันสคริปต์ `approver.sh`
    - ไม่มี PreToolUse hook เปิด Geno ในโหมด Ask มี turn ทำงานอยู่
    - คำสั่ง `pnpm add zod` ไม่ตรงกับกฎของ workspace และไม่อยู่ใน safe list
  trigger: >-
    model ขอรัน `bash` ด้วยคำสั่ง `pnpm add zod`
  covers: [hook.permission-request]
  related: [perm.ask-allow, hook.pretooluse-deny, perm.auto-classifier-allows]
  steps:
    - id: wants
      beat:
        title: Model ขอรัน `pnpm add zod`
        text: model ตอบกลับมาว่ายังไม่จบ มันอยากรันคำสั่งนี้บนเครื่องของคุณก่อน
        from: model
        to: engine
      lane: model
      do: >-
        model ขอเรียก `bash` ด้วยคำสั่ง `pnpm add zod` และจบคำตอบด้วย `stop_reason: tool_use`
      ref: "packages/engine/src/gateway.ts#\"stopReason: message.stop_reason,\""
      emits: [tool_use]
      phase: calling-model

    - use: tool-call-opens
      beat:
        title: แชตขึ้นขั้นของคำสั่ง
        text: Geno จัดคิวคำสั่งให้รันทีละตัว แผงแชตขึ้นขั้นใหม่พร้อมจุดหมุน
        from: panel
        to: you
        sees:
          kind: step
          label: pnpm add zod
          status: running

    - id: judge
      beat:
        title: Geno ตรวจคำสั่งกับกฎของคุณ
        text: คำสั่งนี้ไม่ตรงกับกฎของ workspace และไม่อยู่ในรายการคำสั่งปลอดภัย ในโหมด Ask แปลว่าต้องถามก่อนรัน
        from: engine
        to: engine
      lane: policy
      at: rules
      do: >-
        `ruledDenial` เทียบคำสั่งกับกฎของ workspace และ safe list ได้ `unlisted` ซึ่งในโหมด Ask แปลว่าต้องถาม
        และแนบรูปแบบ `pnpm add zod` ไว้เป็นกฎที่บันทึกได้
      ref: packages/core/src/permission-rules.ts#ruledDenial
      emits: [unlisted]

    - id: may-answer
      beat:
        title: Geno ให้ hook ตอบก่อนขึ้นการ์ด
        text: hook PermissionRequest ตอบได้เฉพาะคำถามที่จะขึ้นการ์ดให้คุณ คำสั่งที่กฎ deny หรือโหมด Plan ปฏิเสธอยู่แล้วไม่ถึง hook
        from: engine
        to: engine
      lane: policy
      at: settle
      do: >-
        `settle` ไม่ปฏิเสธเองและไม่ใช่โหมด Auto ก่อนขึ้นการ์ด `hooked` ถาม PermissionRequest hook ของ call นี้
        `hookMayAnswer` ยอมให้ hook ตอบเฉพาะคำถามที่จะขึ้นการ์ด การปฏิเสธที่ใครตอบก็ไม่เปลี่ยน เช่นกฎ deny หรือโหมด Plan ไม่ถึง hook
      ref: packages/core/src/hooks.ts#hookMayAnswer

    - id: hook
      beat:
        title: Geno ส่งคำถามให้ `approver.sh`
        text: Geno รันสคริปต์ของ hook แล้วส่ง JSON ที่มีชื่อ tool คำสั่ง และกฎที่บันทึกได้ไปทาง stdin สคริปต์ตอบได้ผ่าน JSON เท่านั้น exit 2 ไม่มีผลกับ hook นี้
        from: engine
        to: machine
        ask: hook ตอบอะไร
      lane: policy
      at: hooks
      do: >-
        `permissionAsk` รัน hook ด้วย JSON บน stdin: `tool_name: "Bash"`, `tool_input.command`
        และ `permission_suggestions` ที่เสนอกฎ `addRules` รูปแบบ `pnpm add zod` ปลายทาง `localSettings`
        มีแค่ object `decision` ที่ตอบได้ exit 2 ไม่มีผล ถ้าหลาย hook ตอบ การปฏิเสธชนะการอนุญาต
      ref: packages/core/src/hooks.ts#permissionRequestDecision
      emits: [PermissionRequest, permission_suggestions]
      fork:
        ask: hook ตอบอะไร
        options:
          - id: allow
            label: allow
            then: run
            steps:
              - lane: policy
                beat:
                  title: hook ตอบ allow
                  text: Geno จดว่า hook เป็นคนอนุญาต การ์ดไม่ขึ้น คุณไม่เห็นคำถามเลย
                  from: machine
                  to: engine
                at: settle
                do: >-
                  สคริปต์พิมพ์ `{"hookSpecificOutput": {"decision": {"behavior": "allow"}}}`
                  `settle` คืนบันทึก `decidedBy: hook, verdict: allow` และไม่ขึ้นการ์ด ผู้ใช้ไม่เห็นคำถามเลย
                ref: packages/engine/src/tools/agent.ts#settle
                emits: [allow]

          - id: rerun
            label: allow พร้อม updatedInput
            then: run
            steps:
              - lane: policy
                beat:
                  title: hook อนุญาตแล้วแก้คำสั่ง
                  text: hook ตอบ allow พร้อมคำสั่งใหม่ `pnpm add zod --save-exact` Geno ตรวจคำสั่งใหม่อีกรอบ แล้วใช้คำตอบ allow เดิมของ hook จึงไม่ถาม hook ซ้ำ
                  from: machine
                  to: engine
                at: settle
                do: >-
                  สคริปต์ตอบ allow พร้อม `updatedInput` ที่เปลี่ยนคำสั่งเป็น `pnpm add zod --save-exact`
                  `settle` ไม่รันเอง แต่โยน `PermissionRerun` ที่ถือ input ใหม่
                ref: packages/engine/src/tools/agent.ts#settle
                emits: [PermissionRerun]
              - lane: loop
                at: tools
                do: >-
                  `callOf` จับ `PermissionRerun` แล้วรัน call ใหม่ด้วย input ที่ hook แก้ การตรวจของ `bash` ตัดสินคำสั่งใหม่อีกรอบ
                  และถ้ามีคำถาม คำตอบ allow ของ hook ตอบแทน hook จึงถูกถามครั้งเดียวต่อ call
                  log ยังเก็บ `tool_use` ตามที่ model ส่ง
                ref: "packages/engine/src/drive.ts#\"if (!(error instanceof PermissionRerun)) throw error;\""

          - id: deny
            label: deny
            steps:
              - lane: policy
                beat:
                  title: hook ปฏิเสธพร้อมเหตุผล
                  text: hook ตอบ deny พร้อมข้อความ "use npm in this repo" คำสั่งไม่ได้รัน Geno บอก model ว่า hook ตอบแทนคุณและปฏิเสธ ห้ามลองซ้ำ
                  from: machine
                  to: engine
                at: settle
                do: >-
                  สคริปต์ตอบ `behavior: "deny"` พร้อม `message: "use npm in this repo"`
                  `settle` คืนบันทึก `decidedBy: hook, verdict: deny` และ `refusalOf` สร้าง `ToolDenied` คำสั่งไม่ได้รัน
                ref: packages/engine/src/tools/agent.ts#refusalOf
                emits: [ToolDenied]
              - lane: loop
                at: tools
                do: >-
                  ผลของ call มีสถานะ `denied` ข้อความถึง model คือ "denied: `pnpm add zod` did not run.
                  A PermissionRequest hook answered for the user and refused it: use npm in this repo. Do not retry it; ..."
                  ผลพาบันทึกการตัดสินของ hook ไปด้วย update ปิดของมันจึงมี `APPROVAL_META`
                ref: packages/engine/src/tools/agent.ts#denialText
                emits: [denied]
              - use: tool-result-returns
              - lane: panel
                beat:
                  title: แชตบอกว่า hook ปฏิเสธ
                  text: ขั้นของคำสั่งขึ้นป้ายว่า hook ปฏิเสธ พร้อมข้อความของ hook
                  from: panel
                  to: you
                  sees:
                    kind: step
                    label: pnpm add zod
                    status: denied
                    note: Denied by a hook · Use npm in this repo.
                at: rail
                do: ขั้นของคำสั่งขึ้นป้ายว่า hook ปฏิเสธ พร้อมข้อความของ hook
                sees: "Denied by a hook · Use npm in this repo."
                ref: packages/extension/src/chat/session-updates.ts#denialOf
              - lane: loop
                beat:
                  title: Model อ่านเหตุผลของ hook
                  text: การปฏิเสธของ hook ไม่ใช่การปฏิเสธของคุณ turn จึงไม่จบ Geno เรียก model อีกครั้ง model อ่านข้อความของ hook แล้วหาทางอื่น เช่นใช้ npm
                  from: model
                  to: engine
                  end: Model หาทางอื่น
                at: step
                do: >-
                  `ToolDenied` ไม่ใช่การปฏิเสธของผู้ใช้ `loopStep` จึงตัดสิน `call-model` model อ่านข้อความของ hook แล้วหาทางอื่น
                ref: packages/core/src/loop.ts#loopStep
                emits: [call-model]
                phase: calling-model
                end: { turn: continues, reason: call-model }

          - id: interrupt
            label: deny พร้อม interrupt
            steps:
              - lane: policy
                beat:
                  title: hook ปฏิเสธแล้วสั่งหยุด
                  text: "hook ตอบ deny พร้อม `interrupt: true` Geno ถือว่าเหมือนคุณกด Deny เอง call อื่นที่รออยู่ใน turn นี้ไม่ได้รัน"
                  from: machine
                  to: engine
                at: settle
                do: >-
                  สคริปต์ตอบ deny พร้อม `interrupt: true` `settle` ใส่ `interrupt` ไว้ในบันทึกที่คืนด้วย
                  `refusalOf` จึงสร้าง `ToolRejected` เหมือนผู้ใช้กด Deny
                ref: packages/engine/src/tools/agent.ts#refusalOf
                emits: [ToolRejected]
              - lane: loop
                at: tools
                do: >-
                  ผลของ call มีสถานะ `rejected` พาบันทึกของ hook ไปเป็น `APPROVAL_META` และบอก model ให้หยุดรอผู้ใช้
                  เมื่อ batch นี้จบ `runTools` ไม่เริ่ม batch ถัดไป call ที่เหลือของ turn จึงไม่ได้รัน
                ref: "packages/engine/src/drive.ts#\"results.some((result) => result?.status === 'rejected')\""
                emits: [rejected]
              - use: tool-result-returns
              - lane: loop
                beat:
                  title: Turn จบโดยไม่เรียก model
                  text: Geno จบ turn ทันทีเพื่อรอคุณ ขั้นของคำสั่งขึ้นป้ายว่า hook ปฏิเสธ และแชตบอกว่าหยุดที่ call ที่ถูกปฏิเสธ
                  from: engine
                  to: panel
                  end: Turn จบเพราะ hook สั่งหยุด
                  sees:
                    - kind: step
                      label: pnpm add zod
                      status: denied
                      note: Denied by a hook · Use npm in this repo.
                    - kind: notice
                      text: Geno stopped without a reply
                      detail: It stopped at the call that was denied.
                      actions:
                        - Continue
                        - Retry
                      tone: warning
                at: step
                do: >-
                  `loopStep` ตอบ call ที่ยังไม่ได้รันด้วย `UNRUN_TEXTS.rejected` แล้วตัดสิน `done(end_turn)` Stop hook ไม่ทำงานในทางนี้
                ref: "packages/core/src/loop.ts#\"userRejected(newestTurn(events)!.after)) return done('end_turn')\""
                emits: [end_turn]
                phase: ending
              - lane: server
                at: turns
                do: >-
                  `runTurn` แปลงผลด้วย `TURN_ENDS` เป็น `stopReason: end_turn` และงานจบแบบ `done`
                ref: packages/engine/src/serve.ts#TURN_ENDS
                emits: [TURN_END_META]
              - lane: panel
                at: rail
                do: >-
                  ขั้นของคำสั่งขึ้นป้ายว่า hook ปฏิเสธ และ `missingReply` เห็นว่าขั้นสุดท้ายถูกปฏิเสธโดยไม่มีข้อความตามมา
                sees: >-
                  "Denied by a hook · Use npm in this repo." และกล่อง "It stopped at the call that was denied." ปุ่ม [Continue] [Retry]
                ref: packages/extension/src/chat/rail.ts#missingReply
                end: { turn: done, reason: end_turn }

          - id: none
            label: ไม่ตอบ
            steps:
              - lane: policy
                beat:
                  title: hook ไม่ตอบ
                  text: สคริปต์จบโดยไม่พิมพ์คำตอบ Geno จึงส่งคำถามต่อให้คุณ การ์ด “Run this command?” ขึ้นตามปกติ
                  from: machine
                  to: engine
                  end: การ์ดขึ้นให้คุณตอบ
                at: settle
                do: >-
                  hook จบด้วย exit 0 โดยไม่พิมพ์ `decision` (หรือ exit 2 ซึ่ง PermissionRequest ไม่นับ) ผลคือ `none`
                  `settle` ส่งคำถามต่อให้ผู้ใช้ผ่าน `approval.approve` การ์ดขึ้นตามปกติ
                ref: packages/engine/src/tools/agent.ts#settle
                phase: waiting-user
                goto: perm.ask-allow

    - id: run
      beat:
        title: คำสั่งรันใน sandbox
        text: การอนุญาตของ hook ไม่ยกเว้น sandbox ผลของคำสั่งพาบันทึกว่า hook เป็นคนอนุญาตไปด้วย
        from: engine
        to: machine
      lane: tool
      at: shell
      do: >-
        `bash` รันคำสั่งใน sandbox การอนุญาตของ hook ไม่ยกเว้น sandbox ผลแนบบันทึกว่า hook เป็นคนอนุญาต
        update ปิดของ call จึงมี `APPROVAL_META`
      ref: "packages/engine/src/tools/agent.ts#\"tools.sandbox.run(command\""
      phase: running-tools

    - use: tool-result-returns

    - id: next
      beat:
        title: Model อ่านผลของคำสั่ง
        text: Geno ส่งผลกลับให้ model เพื่อตัดสินว่าจะทำอะไรต่อ
        from: model
        to: engine
        end: Model อ่านผลแล้วทำต่อ
      lane: loop
      at: step
      do: >-
        `loopStep` เห็น `tool-result` ล่าสุดจึงตัดสิน `call-model` model ได้อ่านผลของคำสั่ง
      ref: packages/core/src/loop.ts#loopStep
      emits: [call-model]
      phase: calling-model
      end: { turn: continues, reason: call-model }
---

PermissionRequest ยืนอยู่ตรงที่การ์ดจะขึ้น ไม่ใช่ก่อนทุก call อย่าง PreToolUse
คำสั่งที่ safe list ผ่านอยู่แล้วจึงไม่ไปถึง hook นี้ และคำสั่งที่ถูกปฏิเสธอยู่แล้วก็ไม่ไปถึงเช่นกัน

| hook ตอบ | คำสั่ง | turn |
| --- | --- | --- |
| `behavior: "allow"` | รัน ไม่มีการ์ด | ทำต่อ |
| allow + `updatedInput` | รันด้วย input ใหม่ หลังการตรวจรอบใหม่ | ทำต่อ |
| `behavior: "deny"` | ไม่รัน (`ToolDenied`) | ทำต่อ model อ่านข้อความของ hook |
| deny + `interrupt: true` | ไม่รัน (`ToolRejected`) | จบแบบ `done (end_turn)` และรอผู้ใช้ |
| ไม่ตอบ หรือ exit 2 | การ์ดขึ้นตามปกติ | ตามคำตอบของผู้ใช้ |

สิ่งที่ควรสังเกต

- **ในโหมด Auto hook ถูกถามหลัง classifier** ถ้า classifier อนุญาต หรือตอบ `deny` หรือ `ask` แล้ว Geno ปฏิเสธส่งเหตุผลกลับไปหา model hook ไม่ถูกถาม
  hook ตอบได้เฉพาะเมื่อ Auto จะขึ้นการ์ดถามผู้ใช้ คือหลัง block ติดกันครบ 3 ครั้งหรือรวมครบ 20 ครั้งใน session หรือเมื่อ classifier ใช้ไม่ได้เลย
- **ใน run ที่ไม่มีใครตอบ** (`gcode agent --non-interactive`) hook ตอบแทนได้เฉพาะคำถามที่ถูกปฏิเสธเพราะไม่มีใครตอบ
- **การอนุญาตของ hook ไม่บันทึกกฎ** `permission_suggestions` บอก hook ว่าการ์ดเสนอกฎอะไร แต่ Geno ไม่บันทึกกฎตามคำตอบของ hook
- **แผงแชตไม่บอกว่า hook อนุญาต** ขั้นของคำสั่งดูเหมือนคำสั่งที่รันโดยไม่ต้องถาม บันทึก `decidedBy: hook` อยู่ใน log
