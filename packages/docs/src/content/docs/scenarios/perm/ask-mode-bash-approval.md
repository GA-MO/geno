---
title: "โหมด Ask ขอ permission ก่อนรันคำสั่ง"
description: model ขอรันคำสั่งที่ไม่อยู่ใน safe list Geno หยุดถามผู้ใช้ก่อน และผู้ใช้เลือกได้สี่ทาง
scenario:
  surface: vscode
  given:
    - เปิด Geno ในโหมด Ask
    - มี turn ทำงานอยู่ และ model กำลังจะขอเรียก `bash` ด้วยคำสั่ง `pnpm add zod`
    - คำสั่งนี้ไม่ตรงกับกฎของ workspace และไม่อยู่ใน safe list
  trigger: >-
    model จบคำตอบด้วย `stop_reason: tool_use` พร้อมบล็อก `tool_use` ของ `bash`
  covers: [perm.ask-allow, perm.ask-deny-ends-turn, perm.deny-with-comment, perm.always-allow-workspace, ctl.stop-at-card]
  related: [turn.with-tools, tool.bash-safe-runs, perm.auto-classifier-allows, ctl.stop-while-tools-run]
  steps:
    - id: wants
      lane: model
      beat:
        title: "Model ขอรัน `pnpm add zod`"
        text: >-
          model ตอบกลับมาว่ายังไม่จบ มันอยากรันคำสั่ง `pnpm add zod` บนเครื่องของคุณก่อน
          Geno จดคำขอนี้ไว้ในบันทึกของ turn
        from: model
        to: engine
      do: >-
        model ขอเรียก `bash` ด้วยคำสั่ง `pnpm add zod` และจบคำตอบด้วย `stop_reason: tool_use`
      ref: "packages/engine/src/gateway.ts#\"stopReason: message.stop_reason,\""
      emits: [tool_use]
      phase: calling-model

    - id: logged
      lane: loop
      at: drive
      do: >-
        `drive` บันทึก event `assistant` ที่มีบล็อก `tool_use` ลง log
      ref: "packages/engine/src/drive.ts#\"await record({ kind: 'assistant', seq: nextSeq(events), at, ...result.turn\""
      emits: [assistant]

    - use: tool-call-opens
      beat:
        title: "Geno แสดงคำสั่งในแชตของคุณ"
        text: >-
          Geno จัดคิวคำสั่งนี้ให้รันทีละตัว แล้วบอกแผงแชตว่ามีขั้นใหม่
          คุณเห็นขั้นนั้นขึ้นมาพร้อมจุดหมุน
        from: engine
        to: panel
        sees: { kind: step, label: pnpm add zod, status: running }

    - id: judge
      lane: policy
      at: rules
      beat:
        title: "Geno ตรวจคำสั่งกับกฎของคุณ"
        text: >-
          ก่อนรันอะไร Geno เทียบคำสั่งกับกฎของ workspace และรายการคำสั่งปลอดภัย
          `pnpm add zod` ไม่อยู่ในทั้งสองที่ และโหมด Ask บอกว่าเรื่องแบบนี้ต้องถามคุณ
        from: engine
        to: engine
      do: >-
        ก่อนรันอะไร `approveCommand` ส่งคำสั่งให้ `ruledDenial` เทียบกับกฎของ workspace และตาราง safe list
        ผลคือ `unlisted` ซึ่งในโหมด Ask แปลว่าต้องถามผู้ใช้ และแนบรูปแบบ `pnpm add zod` ไว้ให้เลือกบันทึกเป็นกฎ
      ref: packages/core/src/permission-rules.ts#ruledDenial
      emits: [unlisted]

    - id: settle
      lane: policy
      at: settle
      beat:
        title: "Geno หยุด turn แล้วถามคุณ"
        text: >-
          ไม่มีกฎหรือ hook ไหนตัดสินแทนได้ Geno จึงหยุด turn ไว้ตรงนี้และส่งคำถามไปที่แผงแชต
          งานในแผง Tasks ขึ้นว่ารอคุณ และถ้าหน้าต่างไม่ได้โฟกัสอยู่ ระบบจะแจ้งเตือน
        from: engine
        to: panel
      do: >-
        `settle` ไม่ปฏิเสธเอง (ไม่ใช่ deny) และไม่ส่งให้ classifier (ไม่ใช่โหมด Auto)
        ไม่มี PermissionRequest hook ตอบแทน จึงส่งคำถามต่อให้ผู้ใช้ผ่าน `approval.approve`
      ref: packages/engine/src/tools/agent.ts#settle

    - id: ask
      lane: server
      at: approvals
      do: >-
        `editorTurn.approve` ส่งอัปเดตที่ค้างออกไปก่อน แล้วส่งคำขอ ACP `session/request_permission`
        พร้อมตัวเลือกจาก `optionsFor` งานในแผง Tasks เปลี่ยนเป็น `needs-input`
        และถ้าหน้าต่างไม่ได้โฟกัสอยู่ OS จะแจ้งเตือน
      ref: packages/engine/src/serve.ts#editorTurn.approve
      emits: [requestPermission, needs-input]
      phase: waiting-user

    - id: forward
      lane: editor
      at: chat
      do: >-
        `askPermission` ส่ง action `permission` ให้ webview และโฟกัสแผงแชต
      ref: packages/extension/src/chat/chat.ts#Chat.askPermission
      emits: [permission]

    - id: card
      lane: panel
      at: card
      beat:
        title: "คุณเห็นการ์ด “Run this command?”"
        text: >-
          แผงแชตแสดงการ์ดขออนุญาต turn รออยู่ตรงนี้จนกว่าคุณจะเลือก
          ลองเลือกแต่ละทางเพื่อดูว่าไปจบที่ไหน
        from: panel
        to: you
        ask: กดปุ่มไหน
        sees:
          kind: permission
          command: pnpm add zod
          reason: Geno asks because it uses a command not on the safe list.
          rule: pnpm add zod
      do: >-
        แผงแชตแสดงการ์ดขออนุญาตพร้อมคำสั่ง เหตุผล และปุ่มให้เลือก หัวข้อเปลี่ยนเป็น "waiting for you"
      sees: >-
        การ์ด "Run this command?" แสดงคำสั่ง `pnpm add zod`
        พร้อมเหตุผล "Geno asks because it uses a command not on the safe list."
        และบรรทัด "Always allow saves the rule `pnpm add zod` for this workspace."
        ปุ่ม [Allow] [Deny] [Always allow in this workspace] [No, and tell the agent…]
      ref: packages/extension/src/chat/render.ts#permissionCard

    - id: choice
      lane: user
      do: ผู้ใช้อ่านการ์ดแล้วเลือกปุ่มหนึ่งปุ่ม turn รออยู่ตรงนี้จนกว่าผู้ใช้จะตอบหรือกด Stop
      fork:
        ask: ผู้ใช้กดปุ่มไหน
        options:
          - id: allow
            label: Allow
            then: run
            steps:
              - lane: editor
                at: chat
                beat:
                  title: "คุณกด Allow"
                  text: >-
                    การ์ดย่อเหลือบรรทัดเดียวว่า Allowed แผงแชตส่งคำตอบกลับไปที่ Geno ว่าอนุญาตครั้งนี้
                    Geno จดไว้ว่าคุณเป็นคนอนุญาต
                  from: you
                  to: panel
                do: >-
                  การ์ดย่อเหลือบรรทัดเดียวว่า Allowed แล้ว `askPermission` ตอบ engine ว่า `selected` ตัวเลือก `allow`
                ref: packages/extension/src/chat/chat.ts#Chat.askPermission
                emits: [permission-done]
              - lane: server
                at: approvals
                do: >-
                  `permissionAnswerOf` แปลงคำตอบของ ACP เป็น `allow`
                ref: packages/engine/src/serve.ts#permissionAnswerOf
              - lane: policy
                at: settle
                do: >-
                  `settle` คืนบันทึก `decidedBy: user, verdict: allow`
                  บันทึกนี้ติดไปกับผลของ call ให้แผงแชตแสดงได้ว่าใครอนุญาต
                ref: packages/engine/src/tools/agent.ts#settle
                phase: running-tools

          - id: allow-workspace
            label: Always allow in this workspace
            then: run
            steps:
              - lane: editor
                at: chat
                beat:
                  title: "คุณกด Always allow"
                  text: >-
                    เหมือน Allow แต่ Geno บันทึกกฎ `pnpm add zod` ไว้ใน workspace ด้วย
                    ครั้งหน้าคำสั่งที่ขึ้นต้นด้วย `pnpm add zod` ผ่านโดยไม่ถาม ส่วน `pnpm add lodash` ยังถาม เพราะกฎเก็บชื่อแพ็กเกจไว้ด้วย
                  from: you
                  to: panel
                do: >-
                  `askPermission` ตอบ engine ว่า `selected` ตัวเลือก `allow-workspace`
                ref: packages/extension/src/chat/chat.ts#Chat.askPermission
                emits: [permission-done, allow-workspace]
              - lane: server
                at: approvals
                do: >-
                  `permissionAnswerOf` แปลงคำตอบเป็น `allow-workspace`
                ref: packages/engine/src/serve.ts#permissionAnswerOf
              - lane: policy
                at: rules
                do: >-
                  `settle` เรียก `keep` ซึ่งบันทึกกฎ allow รูปแบบ `pnpm add zod` ลงที่เก็บของ workspace
                  ครั้งต่อไป `ruledDenial` จะผ่านคำสั่งที่ขึ้นต้นด้วย `pnpm add zod` โดยไม่ถาม ยกเว้นคำสั่งอันตรายอย่าง `rm -rf`
                ref: "packages/engine/src/tools/agent.ts#\"permissions?.add({ effect: 'allow', pattern\""
                phase: running-tools

          - id: reject
            label: Deny
            steps:
              - lane: editor
                at: chat
                beat:
                  title: "คุณกด Deny"
                  text: >-
                    แผงแชตบอก Geno ว่าคุณปฏิเสธ คำสั่งไม่ได้รัน และไม่มีข้อความอะไรส่งต่อให้ model
                  from: you
                  to: panel
                do: >-
                  `askPermission` ตอบ engine ว่า `selected` ตัวเลือก `reject`
                  (ถ้าการ์ดถูกยกเลิก เช่นผู้ใช้กด Stop จะได้ `cancelled` ซึ่งให้ผลเหมือนกัน)
                ref: packages/extension/src/chat/chat.ts#Chat.askPermission
                emits: [permission-done]
              - lane: server
                at: approvals
                do: >-
                  `permissionAnswerOf` แปลงคำตอบเป็น `reject`
                ref: packages/engine/src/serve.ts#permissionAnswerOf
              - lane: policy
                at: settle
                do: >-
                  `settle` คืนบันทึก `verdict: deny` โดยไม่มีความเห็น `approveCommand` จึงโยน `refusalOf`
                  ซึ่งเป็น `ToolRejected` คำสั่งไม่ได้รัน
                ref: packages/engine/src/tools/agent.ts#refusalOf
                emits: [ToolRejected]
                phase: running-tools
              - lane: loop
                at: tools
                beat:
                  title: "Geno หยุดส่วนที่เหลือของ turn"
                  text: >-
                    คำปฏิเสธเปล่าๆ แปลว่าคุณอยากเป็นคนพูดต่อ Geno จึงไม่เริ่มคำสั่งที่เหลือใน turn นี้
                  from: engine
                  to: engine
                do: >-
                  ผลของ call นี้มีสถานะ `rejected` และบอก model ให้หยุดรอผู้ใช้ เมื่อ batch นี้จบ `runTools` ไม่เริ่ม batch ถัดไป
                  call ที่เหลือใน turn เดียวกันจึงไม่เริ่ม
                ref: "packages/engine/src/drive.ts#\"results.some((result) => result?.status === 'rejected')\""
                emits: [rejected]
              - lane: server
                at: updates
                beat:
                  title: "แชตติดป้าย “Denied by you”"
                  text: >-
                    แผงแชตติดป้ายที่ขั้นของคำสั่งว่าคุณเป็นคนปฏิเสธ คนที่ย้อนมาอ่านจะไม่เข้าใจผิดว่าคำสั่งล้มเหลวเอง
                  from: engine
                  to: panel
                  sees: { kind: step, label: pnpm add zod, status: denied, note: "Denied by you · It did not run, and Geno waits for you." }
                do: >-
                  ผลถูกส่งเป็น `tool_call_update` พร้อม `APPROVAL_META` ที่บอกว่าผู้ใช้เป็นคนปฏิเสธ
                ref: packages/engine/src/session-replay.ts#toolResultUpdate
                emits: [tool_call_update]
              - lane: editor
                at: chat
                alongside: true
                do: >-
                  `denialOf` อ่าน `APPROVAL_META` แล้วแปลงเป็นป้ายปฏิเสธพร้อมคนที่ปฏิเสธและเหตุผล
                ref: packages/extension/src/chat/session-updates.ts#denialOf
              - lane: panel
                at: rail
                alongside: true
                do: ขั้นของคำสั่งขึ้นป้ายว่าผู้ใช้ปฏิเสธ
                sees: "Denied by you · It did not run, and Geno waits for you."
                ref: packages/extension/src/chat/render.ts#DENIED_BY
              - lane: loop
                at: step
                beat:
                  title: "Turn จบและรอคุณ"
                  text: >-
                    Geno จบ turn โดยไม่เรียก model อีก แผงแชตบอกว่าหยุดที่คำสั่งที่ถูกปฏิเสธ
                    และมีปุ่มให้ทำต่อเมื่อคุณพร้อม
                  from: engine
                  to: panel
                  end: คุณปฏิเสธ turn จบ
                  sees: { kind: notice, text: It stopped at the call that was denied., actions: [Continue, Retry] }
                do: >-
                  `loopStep` รอบถัดไปตอบ call ที่ยังไม่ได้รัน (ถ้ามี) ด้วย `UNRUN_TEXTS.rejected` แล้วตัดสิน `done(end_turn)`
                  เพราะคำปฏิเสธจากผู้ใช้จบ turn ผู้ใช้คือคนที่พูดต่อ Stop hook ไม่ทำงานในทางนี้
                ref: "packages/core/src/loop.ts#\"userRejected(newestTurn(events)!.after)) return done('end_turn')\""
                emits: [end_turn]
                phase: ending
              - lane: server
                at: turns
                do: >-
                  `runTurn` แปลงผลด้วย `TURN_ENDS` เป็น `stopReason: end_turn` และงานจบแบบ `done`
                ref: packages/engine/src/serve.ts#TURN_ENDS
              - lane: editor
                at: chat
                do: >-
                  `prompt()` ใช้ `turnEndOf` อ่านผลแล้วส่ง action `turn-end` สถานะ `done`
                ref: "packages/extension/src/chat/chat.ts#\"const status = turnEndOf(response);\""
                emits: [turn-end]
              - lane: panel
                at: rail
                do: >-
                  `missingReply` เห็นว่าขั้นสุดท้ายถูกปฏิเสธและไม่มีข้อความตามมา จึงแสดงประกาศพร้อมปุ่มให้ทำต่อ
                sees: "It stopped at the call that was denied. [Continue] [Retry]"
                ref: packages/extension/src/chat/rail.ts#missingReply
                end: { turn: done, reason: end_turn }

          - id: comment
            label: No, and tell the agent…
            steps:
              - lane: panel
                at: card
                beat:
                  title: "คุณพิมพ์บอก agent"
                  text: >-
                    ปุ่มบนการ์ดเปลี่ยนเป็นช่องพิมพ์ คุณพิมพ์ว่า "ใช้ npm แทน" แล้วกด Send
                  from: you
                  to: panel
                  sees: { kind: permission, command: pnpm add zod, options: [Send, Back], note: ใช้ npm แทน }
                do: ปุ่มบนการ์ดเปลี่ยนเป็นช่องให้พิมพ์ข้อความถึงเอเจนต์
                ref: packages/extension/src/chat/render.ts#commentField
              - lane: user
                do: ผู้ใช้พิมพ์ "ใช้ npm แทน" แล้วกด Send
              - lane: editor
                at: chat
                beat:
                  title: "Geno ไม่รันคำสั่ง แต่เก็บข้อความของคุณไว้"
                  text: >-
                    คำสั่งไม่ได้รัน แต่ต่างจาก Deny ตรงที่ turn ไม่จบ Geno เก็บข้อความของคุณไว้ส่งให้ model
                    และคำสั่งอื่นใน turn เดียวกันยังรันต่อได้
                  from: engine
                  to: model
                do: >-
                  `askPermission` ตอบ engine ว่า `selected` และใส่ข้อความของผู้ใช้ไว้ใน `_meta` ใต้คีย์ `PERMISSION_COMMENT_META`
                ref: packages/extension/src/chat/chat.ts#Chat.askPermission
                emits: [permission-done, gcode/permission-comment]
              - lane: server
                at: approvals
                do: >-
                  `permissionAnswerOf` แปลงคำตอบเป็น `{ comment }` (ถ้าข้อความว่าง จะกลายเป็น `reject`)
                ref: packages/engine/src/serve.ts#permissionAnswerOf
              - lane: policy
                at: settle
                do: >-
                  `settle` คืนบันทึก `verdict: deny` พร้อมความเห็น `refusalOf` จึงสร้าง `ToolDenied` ไม่ใช่ `ToolRejected`
                  call อื่นใน turn เดียวกันยังรันต่อได้
                ref: packages/engine/src/tools/agent.ts#refusalOf
                emits: [ToolDenied]
                phase: running-tools
              - lane: loop
                at: tools
                do: >-
                  `tool-result` สถานะ `denied` บอก model ว่าคำสั่งไม่ได้รัน ตามด้วยข้อความของผู้ใช้
                  ("To tell you how to proceed, the user said: ใช้ npm แทน")
                ref: packages/engine/src/tools/agent.ts#denialText
                emits: [denied, tool-result]
              - lane: server
                at: updates
                beat:
                  title: "แชตแสดงข้อความของคุณที่ขั้นนั้น"
                  text: >-
                    ขั้นของคำสั่งขึ้นป้ายปฏิเสธพร้อมข้อความที่คุณบอก คนที่ย้อนมาอ่านจะรู้ว่าทำไมคำสั่งไม่ได้รัน
                  from: engine
                  to: panel
                  sees: { kind: step, label: pnpm add zod, status: denied, note: "Denied by you · It did not run. You told Geno: ใช้ npm แทน" }
                do: >-
                  ผลถูกส่งเป็น `tool_call_update` พร้อม `APPROVAL_META` ที่มีความเห็นของผู้ใช้
                ref: packages/engine/src/session-replay.ts#toolResultUpdate
                emits: [tool_call_update]
              - lane: editor
                at: chat
                alongside: true
                do: >-
                  `denialOf` แปลง `APPROVAL_META` เป็นป้ายปฏิเสธที่มีข้อความของผู้ใช้
                ref: packages/extension/src/chat/session-updates.ts#denialOf
              - lane: panel
                at: rail
                alongside: true
                do: ขั้นของคำสั่งขึ้นป้ายปฏิเสธพร้อมข้อความที่ผู้ใช้บอก
                sees: "Denied by you · It did not run. You told Geno: ใช้ npm แทน"
                ref: packages/extension/src/chat/render.ts#DENIED_BY
              - lane: loop
                at: step
                beat:
                  title: "Model อ่านข้อความของคุณ"
                  text: >-
                    Geno เรียก model ต่อ ผลของคำสั่งบอกว่าไม่ได้รัน ตามด้วยข้อความของคุณ
                    model จะหาทางอื่นตามที่คุณบอก
                  from: engine
                  to: model
                  end: Model หาทางอื่น
                do: >-
                  `loopStep` เห็น `tool-result` ล่าสุดและไม่มีการปฏิเสธเปล่าจากผู้ใช้ จึงตัดสิน `call-model`
                  model จะได้อ่านคำแนะนำของผู้ใช้ใน `tool_result` แล้วทำต่อ
                ref: packages/core/src/loop.ts#loopStep
                emits: [call-model]
                phase: calling-model
                end: { turn: continues, reason: call-model }

          - id: stop
            label: กด Stop แทน
            steps:
              - lane: panel
                at: composer
                beat:
                  title: "คุณกด Stop แทนการตอบ"
                  text: >-
                    คุณไม่ตอบการ์ด แต่กด Stop แผงแชตตอบการ์ดว่ายกเลิก แล้วสั่งให้ Geno หยุด turn
                  from: you
                  to: panel
                  sees: { kind: composer, state: working, header: working }
                do: ผู้ใช้ไม่ตอบการ์ด แต่กด Stop ปุ่ม Stop โพสต์ข้อความ `stop` ไปให้ extension host
                ref: "packages/extension/src/chat/webview.ts#\"stop.addEventListener('click', () => host.postMessage({ type: 'stop' }));\""
                emits: [stop]
              - lane: editor
                at: chat
                do: >-
                  `Chat.stop` ตอบการ์ดที่เปิดอยู่ว่าไม่ได้เลือกอะไร ตามที่ ACP กำหนดให้ client ที่ยกเลิก turn ตอบคำขอที่ค้าง
                  แล้วส่ง notification ACP `session/cancel` ทันที `askPermission` จึงตอบ engine ว่า `cancelled`
                ref: packages/extension/src/chat/chat.ts#Chat.stop
                emits: [cancelled]
              - lane: panel
                at: card
                alongside: true
                do: การ์ดย่อเหลือบรรทัดเดียวว่า Cancelled
                sees: "Cancelled"
                ref: packages/extension/src/chat/render.ts#permissionCard
              - lane: server
                at: turns
                beat:
                  title: "Geno ยกเลิกคำสั่งที่รออยู่"
                  text: >-
                    Geno ยกเลิก turn ทันที คำสั่งไม่เคยเริ่มรัน แต่ข้อความที่ model จะได้อ่านบอกว่ามันอาจรันไปบางส่วน
                    ซึ่งไม่ตรงกับที่เกิดขึ้น
                  from: engine
                  to: engine
                do: >-
                  engine หา `AbortController` ของ turn ใน `turns` แล้วสั่ง abort
                  คำตอบ `cancelled` ของการ์ดแปลงเป็น `reject` แต่ไม่มีใครใช้ผลนั้นแล้ว
                ref: "packages/engine/src/serve.ts#\".onNotification(acp.methods.agent.session.cancel, ({ params }) => {\""
              - lane: loop
                at: tools
                do: >-
                  `unlessAborted` ของ batch จบทันทีที่ abort call ของ `bash` เริ่มแล้ว (มันรอการ์ดอยู่ภายใน executor)
                  จึงได้คำตอบ `UNRUN_TEXTS.stopped` ว่าผู้ใช้หยุดมันระหว่างรันและมันอาจรันไปบางส่วน ทั้งที่คำสั่งไม่เคยเริ่ม
                ref: packages/core/src/loop.ts#stoppedAnswers
                emits: [tool-result]
                phase: running-tools
              - lane: loop
                at: drive
                do: >-
                  `drive` บันทึก event `error` ชนิด `abort` ตามหลังผลนั้น extension ทิ้ง error ชนิดนี้ แผงไม่ขึ้นบล็อก error
                ref: "packages/engine/src/drive.ts#\"error: 'abort', message: 'interrupted by the user', tools: interrupted\""
                emits: [error, abort]
              - lane: loop
                at: step
                beat:
                  title: "แชตขึ้นว่าคุณเป็นคนหยุด"
                  text: >-
                    turn จบแบบถูกหยุด ขั้นของคำสั่งขึ้นว่าล้มเหลว และแผงแชตมีปุ่มให้ทำต่อหรือลองใหม่
                  from: engine
                  to: panel
                  end: คุณหยุด turn
                  sees: { kind: notice, text: Geno stopped without a reply, detail: You stopped it before it answered., actions: [Continue, Retry], tone: warning }
                do: >-
                  `loopStep` เห็น error `abort` จึงได้ `done(error)` แล้ว `runTurn` เห็นว่าสัญญาณถูก abort จึงตอบ ACP ว่า
                  `stopReason: cancelled` และงานจบแบบ `stopped`
                ref: packages/core/src/loop.ts#ERROR_REASON
                emits: [stopped]
                phase: ending
              - lane: editor
                at: chat
                do: >-
                  `prompt()` ใช้ `turnEndOf` อ่านได้ `stopped` แล้วส่ง action `turn-end` สถานะ `stopped`
                ref: "packages/extension/src/chat/chat.ts#\"const status = turnEndOf(response);\""
                emits: [turn-end]
              - lane: panel
                at: rail
                do: >-
                  ขั้นของคำสั่งขึ้นเป็นล้มเหลวพร้อมข้อความว่าผู้ใช้หยุด `missingReply` เห็นว่า turn ถูกหยุดโดยไม่มีคำตอบ
                sees: >-
                  หัวข้อ "stopped after 40s" กล่อง "Geno stopped without a reply · You stopped it before it answered."
                  ปุ่ม [Continue] [Retry] และท้าย turn ขึ้น "Stopped by you"
                ref: packages/extension/src/chat/rail.ts#missingReply
                end: { turn: stopped, reason: cancelled }

    - id: run
      lane: tool
      at: shell
      beat:
        title: "คำสั่งรันบนเครื่องของคุณ"
        text: >-
          Geno รันคำสั่งใน sandbox การอนุญาตของคุณไม่ได้ปิด sandbox
          ผลที่ได้ติดบันทึกไว้ว่าใครเป็นคนอนุญาต
        from: engine
        to: machine
      do: >-
        `bash` รัน `pnpm add zod` ใน sandbox ใน process group ของตัวเอง การอนุญาตไม่ได้ยกเว้น sandbox
        ผลลัพธ์แนบบันทึกว่าใครอนุญาตไว้ด้วย
      ref: "packages/engine/src/tools/agent.ts#\"tools.sandbox.run(command\""

    - use: tool-result-returns
      beat:
        title: "ผลลัพธ์กลับมาที่แชต"
        text: >-
          เมื่อคำสั่งจบ Geno เก็บผลตามลำดับที่ model ขอ แล้วส่งไปที่แผงแชต
          ขั้นนั้นหยุดหมุนและมีผลลัพธ์พับอยู่ข้างใต้
        from: engine
        to: panel
        sees: { kind: step, label: pnpm add zod, status: done, output: "+ zod 3.23.8" }

    - id: next
      lane: loop
      at: step
      beat:
        title: "Geno ส่งผลลัพธ์ให้ model"
        text: >-
          Geno เรียก model อีกรอบ คราวนี้ในคำขอมีผลของ `pnpm add zod` ให้ model อ่านด้วย
          turn ยังเดินต่อจน model ตอบคุณ
        from: engine
        to: model
        end: Model อ่านผลลัพธ์
      do: >-
        `loopStep` เห็น `tool-result` ล่าสุดจึงตัดสิน `call-model` model จะได้อ่านผลของคำสั่งในคำขอถัดไป
      ref: packages/core/src/loop.ts#loopStep
      emits: [call-model]
      phase: calling-model
      end: { turn: continues, reason: call-model }
---

การ์ดนี้คือจุดเดียวในโหมด Ask ที่ Geno หยุดรอคนระหว่างที่ turn ยังไม่จบ
ทางแยกทั้งห้าต่างกันที่ผลต่อ turn

| ปุ่ม | ผลต่อคำสั่ง | ผลต่อ turn |
| --- | --- | --- |
| **Allow** | รัน | ทำต่อ model ได้อ่านผล |
| **Always allow in this workspace** | รัน และบันทึกกฎ `pnpm add zod` | ทำต่อ ครั้งหน้าไม่ถามอีก |
| **Deny** | ไม่รัน (`ToolRejected`) | จบทันทีแบบ `done (end_turn)` และรอผู้ใช้ |
| **No, and tell the agent…** | ไม่รัน (`ToolDenied`) | ทำต่อ model ได้อ่านคำแนะนำของผู้ใช้ |
| **Stop** (ไม่ตอบการ์ด) | ไม่รัน แต่ model ได้ยินว่า "may have partly run" | จบแบบ `stopped (cancelled)` |

ความต่างระหว่าง Deny กับ "No, and tell the agent…" อยู่ที่ชนิดของ error:
`ToolRejected` ทำให้ batch หยุดและ turn จบ ส่วน `ToolDenied` เป็นผลธรรมดาที่ model อ่านแล้วหาทางอื่นต่อ

engine ตั้งชื่อสองตัวเลือกแรกว่า "Allow once" และ "Reject" (`PERMISSION_OPTIONS` ใน `serve.ts`)
แต่แผงแชตแสดงเป็น **Allow** และ **Deny** ตาม `CHOICE_LABELS` ใน `render.ts`

กด Stop ขณะการ์ดรออยู่ `Chat.stop` ส่งสองข้อความเกือบพร้อมกัน: ตอบการ์ดว่า `cancelled` ก่อน แล้วจึงส่ง `session/cancel`
ทัวร์เดินทางที่ abort ไปถึง batch ก่อนที่ `settle` จะได้คำตอบของการ์ด call จึงถูกตอบว่าถูกหยุดระหว่างรัน
ถ้า `settle` ได้คำตอบก่อน มันจะบันทึก call เป็น `rejected` เหมือนกด Deny แทน (ใครมาก่อนขึ้นกับจังหวะใน engine ไม่ได้ทดลองจริง) ทั้งสองทาง turn จบแบบ `stopped`
และคำสั่งไม่ได้รัน แต่ในทางแรกข้อความที่ model ได้อ่านบอกว่าคำสั่ง "may have partly run" ซึ่งไม่ตรงกับที่เกิดขึ้น
