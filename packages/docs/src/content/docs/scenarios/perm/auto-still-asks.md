---
title: "โหมด Auto ยังขึ้นการ์ดถามคุณ"
description: สามทางที่โหมด Auto ถามผู้ใช้ เมื่อ classifier ปฏิเสธครบ 3 ครั้งติดกันหรือ 20 ครั้งใน session เมื่อคำสั่ง rm -rf แตะ workspace ทั้งก้อนหรือนอกมัน และเมื่อกฎ ask ของ workspace ตรงกับคำสั่ง
scenario:
  surface: vscode
  given:
    - session อยู่ในโหมด Auto
    - ไม่มี hook ที่ตั้งไว้
  trigger: >-
    model ขอเรียก `bash` ด้วยคำสั่งที่กฎติดธง
  covers: [perm.auto-classifier-asks-user, perm.auto-hard-ask, perm.workspace-ask-rule]
  related: [perm.classifier-unavailable, perm.ask-allow, perm.ask-deny-ends-turn, perm.deny-rule]
  steps:
    - id: asks
      lane: model
      beat:
        title: "Model ขอรันคำสั่งที่กฎติดธง"
        text: >-
          session อยู่ในโหมด Auto model ขอรันคำสั่งด้วย `bash` แชตขึ้นขั้นใหม่พร้อมจุดหมุน
        from: model
        to: engine
      do: >-
        model ขอเรียก `bash` และจบคำตอบด้วย `stop_reason: tool_use`
      ref: "packages/engine/src/gateway.ts#\"stopReason: message.stop_reason,\""
      emits: [tool_use]
      phase: calling-model

    - use: tool-call-opens

    - id: rules
      lane: policy
      at: rules
      beat:
        title: "Geno ตรวจกฎตามลำดับ"
        text: >-
          Geno ดูกฎห้ามและกฎถามของ workspace ก่อน แล้วจึงดูกฎในตัวของ Geno ปกติโหมด Auto ส่งให้ classifier
          และคำปฏิเสธของมันกลับไปหา model แต่มีสามทางที่คำสั่งไปถึงคุณ ลองเลือกดู
        from: engine
        to: engine
        ask: "ทำไมถึงถามคุณ"
      do: >-
        `approveCommand` ให้ `ruledDenial` ตัดสินตามลำดับ: กฎ deny และ ask ของ workspace ก่อน แล้วกฎในตัวของ Geno
      ref: packages/core/src/permission-rules.ts#ruledDenial
      fork:
        ask: ทำไมคำสั่งนี้ไปถึงผู้ใช้
        options:
          - id: unsure
            label: classifier ปฏิเสธครบ 3 ครั้งติดกัน (rm -rf dist)
            then: ask
            steps:
              - lane: policy
                at: rules
                beat:
                  title: "Classifier ไม่ยอมเป็นครั้งที่สี่ติดกัน คำถามจึงไปถึงคุณ"
                  text: >-
                    session นี้ classifier ปฏิเสธมาแล้ว 3 ครั้งติดกัน และคำปฏิเสธกลับไปหา model ทุกครั้ง
                    `rm -rf dist` ไปที่ classifier ซึ่งตอบ `ask` อีก ครั้งนี้จึงกลายเป็นคำถามถึงคุณพร้อมเหตุผลของ classifier
                  from: engine
                  to: engine
                do: >-
                  คำสั่งติดกฎ `rm-rf-in-workspace` ซึ่งในโหมด Auto คือ `classify`
                ref: packages/core/src/permission-rules.ts#ruledDenial
                emits: [rm-rf-in-workspace, classify]
              - lane: policy
                at: classifier
                do: >-
                  classifier ไม่แน่ใจ ตอบ `ask` พร้อมเหตุผล
                ref: packages/engine/src/classifier.ts#commandClassifier
              - lane: policy
                at: settle
                do: >-
                  `autoBlocksOf` อ่าน log ของ session ได้ block ติดกัน 3 ครั้ง `autoFallsBack` จึงจริง
                  `settle` ไม่ปฏิเสธเอง ให้ PermissionRequest hook ตอบก่อน แล้วส่งให้ผู้ใช้พร้อมเหตุผลของ classifier
                  (รวมครบ 20 ครั้งใน session ก็เช่นกัน และ classifier ที่ใช้ไม่ได้เลยขึ้นการ์ดทุกครั้ง)
                ref: packages/core/src/classifier.ts#autoFallsBack
                emits: [ask-user]
          - id: hard
            label: rm -rf นอก workspace (rm -rf ../old-build)
            then: ask
            steps:
              - lane: policy
                at: rules
                beat:
                  title: "rm -rf นอก workspace ต้องถามเสมอ"
                  text: >-
                    `rm -rf ../old-build` ลบนอก workspace กฎนี้ถามเสมอแม้ในโหมด Auto จึงไม่มี classifier กฎอนุญาตและ hook
                    ครอบคำสั่งนี้ไม่ได้ และไม่มีรูปแบบให้บันทึก
                  from: engine
                  to: engine
                do: >-
                  กฎ `rm-rf-outside-workspace` ครอบคลุม `rm -rf` ของ workspace เอง `.git` หรือ path นอก workspace
                  คำตัดสินเป็น `ALWAYS_ASK`: Auto ก็ `ask` ไม่ใช่ `classify` จึงไม่มี classifier
                  `isHardAsk` ทำให้กฎ allow และ hook ที่อนุญาตครอบคำสั่งนี้ไม่ได้ และไม่มีรูปแบบให้บันทึก
                ref: "packages/core/src/approval.ts#\"reason: 'rm -rf of the workspace, its .git or a path outside it',\""
                emits: [rm-rf-outside-workspace]
          - id: rule
            label: กฎ ask ของ workspace (pnpm publish)
            then: ask
            steps:
              - lane: policy
                at: rules
                beat:
                  title: "กฎ ask ของ workspace ตรงกับคำสั่ง"
                  text: >-
                    คุณตั้งกฎถาม `pnpm publish` ไว้ใน Settings กฎของ workspace มาก่อนกฎในตัว โหมด Auto จึงถามเหมือนโหมด Ask
                    ไม่ส่งให้ classifier
                  from: engine
                  to: engine
                do: >-
                  ผู้ใช้ตั้งกฎ ask `pnpm publish` ไว้ใน Settings `caughtBy` เจอกฎนี้ก่อนกฎในตัว จึงคืน denial `workspace-ask`
                  คำตัดสินเป็น `ask` ในโหมด Auto เช่นเดียวกับ Ask ไม่ส่งให้ classifier (โหมด Plan จะกลายเป็นปฏิเสธ)
                ref: packages/core/src/permission-rules.ts#ruleDenial
                emits: [workspace-ask]

    - id: ask
      lane: server
      at: approvals
      beat:
        title: "Geno หยุด turn แล้วถามคุณ"
        text: >-
          Geno ส่งคำถามไปที่แชต หัวข้อมีเหตุผลของ classifier ถ้ามี งานในแผง Tasks เปลี่ยนเป็นรอคุณ
        from: engine
        to: panel
      do: >-
        `editorTurn.approve` ส่งคำขอ ACP `session/request_permission` หัวข้อของ call มาจาก `approvalQuestion`
        ซึ่งต่อท้ายเหตุผลของ classifier เมื่อมีคำตอบของ classifier งานในแผง Tasks เปลี่ยนเป็น `needs-input`
      ref: packages/engine/src/serve.ts#editorTurn.approve
      emits: [requestPermission, needs-input]
      phase: waiting-user

    - id: forward
      lane: editor
      at: chat
      do: >-
        `askPermission` ส่ง action `permission` ให้ webview และโฟกัสแผงแชต `classifierReasonOf` แยกเหตุผลของ classifier ออกจากหัวข้อ
      ref: packages/extension/src/chat/chat.ts#Chat.askPermission
      emits: [permission]

    - id: card
      lane: panel
      at: card
      beat:
        title: "คุณเห็นการ์ด “Run this command?”"
        text: >-
          การ์ดเหมือนในโหมด Ask เหตุผลบอกว่ากฎไหนทำให้ถาม ปุ่ม Always allow ขึ้นเฉพาะเมื่อมีรูปแบบให้บันทึก
        from: panel
        to: you
        ask: "กดปุ่มไหน"
        sees: { kind: permission, command: rm -rf ../old-build, reason: "Geno asks because it uses rm -rf of the workspace, its .git or a path outside it.", options: [ Allow, Deny, "No, and tell the agent…" ] }
      do: >-
        การ์ดคำสั่งขึ้นเหมือนในโหมด Ask เหตุผลบอกว่ากฎไหนทำให้ถาม ถ้า classifier ตอบมา การ์ดมีบรรทัดเหตุผลของมันด้วย
        ปุ่ม Always allow ขึ้นเฉพาะเมื่อมีรูปแบบให้บันทึก (`rm -rf` นอก workspace และกฎ ask ไม่มี)
      sees: >-
        การ์ด "Run this command?" กับคำสั่ง และเช่น "Geno asks because it uses rm -rf of the workspace, its .git or a path outside it."
        หรือบรรทัด "Auto could not decide: Runs a script whose effects are not visible in the conversation."
        ปุ่ม [Allow] [Deny] [No, and tell the agent…] (และ [Always allow in this workspace] เมื่อมีรูปแบบให้บันทึก)
      ref: packages/extension/src/chat/render.ts#permissionCard

    - id: choice
      lane: user
      do: ผู้ใช้อ่านการ์ดแล้วตอบ
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
                    การ์ดย่อเหลือ Allowed Geno จดว่าคุณอนุญาต
                  from: you
                  to: panel
                do: >-
                  การ์ดย่อเหลือ Allowed `askPermission` ตอบ engine ว่า `selected` ตัวเลือก `allow`
                ref: packages/extension/src/chat/chat.ts#Chat.askPermission
                emits: [permission-done]
              - lane: server
                at: approvals
                do: >-
                  `permissionAnswerOf` แปลงคำตอบเป็น `allow`
                ref: packages/engine/src/serve.ts#permissionAnswerOf
              - lane: policy
                at: settle
                do: >-
                  `settle` คืนบันทึก `decidedBy: user, verdict: allow`
                ref: packages/engine/src/tools/agent.ts#settle
                emits: [allow]
                phase: running-tools
          - id: deny
            label: Deny
            steps:
              - lane: editor
                at: chat
                beat:
                  title: "คุณกด Deny"
                  text: >-
                    turn จบรอคุณเหมือนการปฏิเสธในโหมด Ask ทัวร์นั้นเล่าต่อ
                  from: you
                  to: panel
                  end: "คุณปฏิเสธ turn จบ"
                do: >-
                  `askPermission` ตอบ engine ว่า `selected` ตัวเลือก `reject`
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
                  `settle` คืนบันทึก `verdict: deny` โดยไม่มีความเห็น จึงเป็น `ToolRejected`
                  turn จบรอผู้ใช้เหมือนการปฏิเสธในโหมด Ask
                ref: packages/engine/src/tools/agent.ts#refusalOf
                emits: [ToolRejected]
                phase: running-tools
                goto: perm.ask-deny-ends-turn

    - id: run
      lane: tool
      at: shell
      beat:
        title: "คำสั่งรันใน sandbox"
        text: >-
          การอนุญาตไม่ได้ยกเว้น sandbox `rm -rf ../old-build` ยังลบนอก workspace ไม่ได้ถ้า sandbox
          ไม่ได้เปิดสิทธิ์เขียนที่นั่น ผลกลับมาที่แชตพร้อมบันทึกว่าคุณอนุญาต
        from: engine
        to: machine
      do: >-
        `bash` รันคำสั่งใน sandbox การอนุญาตไม่ได้ยกเว้น sandbox `rm -rf ../old-build` ยังลบนอก workspace ไม่ได้
        ถ้า sandbox ไม่ได้เปิดสิทธิ์เขียนที่นั่นไว้ ผลแนบบันทึกว่าผู้ใช้อนุญาต (`approval`) อัปเดตผลของ call นี้จึงมี `APPROVAL_META`
      ref: "packages/engine/src/tools/agent.ts#\"const result = await tools.sandbox.run(command, {\""

    - use: tool-result-returns

    - id: next
      lane: loop
      at: step
      beat:
        title: "Model อ่านผลของคำสั่ง"
        text: >-
          Geno เรียก model ต่อ model ได้อ่านผลของคำสั่ง
        from: engine
        to: model
        end: "คุณอนุญาต turn ทำต่อ"
      do: >-
        `loopStep` เห็น `tool-result` ล่าสุดจึงตัดสิน `call-model` model ได้อ่านผลของคำสั่ง
      ref: packages/core/src/loop.ts#loopStep
      emits: [call-model]
      phase: calling-model
      end: { turn: continues, reason: call-model }
---

โหมด Auto ให้ classifier ตัดสินแทนผู้ใช้ ดู [โหมด Auto ให้ classifier ตัดสินคำสั่ง](/scenarios/perm/auto-classifier/)
แต่มีสามทางที่คำถามยังมาถึงผู้ใช้

| ทาง | classifier ถูกเรียกไหม | หลังผู้ใช้อนุญาต |
| --- | --- | --- |
| classifier ปฏิเสธหรือไม่แน่ใจ หลัง block ติดกัน 3 ครั้งหรือรวม 20 ครั้ง หรือ classifier ใช้ไม่ได้เลย | เรียก | คำสั่งรัน แถว block ที่ติดกันเริ่มนับใหม่ ครั้งหน้า classifier ตัดสินใหม่ |
| `rm -rf` ของ workspace, `.git` หรือนอก workspace | ไม่ | ครั้งหน้าถามอีก กฎ allow ครอบไม่ได้ |
| กฎ ask ของ workspace | ไม่ | ครั้งหน้าถามอีก จนกว่าผู้ใช้ลบกฎ |

สิ่งที่ควรสังเกต

- **ปกติคำปฏิเสธของ classifier ไม่ถึงคุณ** คำตอบ `deny` หรือ `ask` และคำสั่งที่ classifier ประเมินไม่ได้ กลับไปหา model เป็นคำปฏิเสธ
  การ์ดขึ้นเมื่อ block ครบ 3 ครั้งติดกันหรือ 20 ครั้งใน session และ PermissionRequest hook ได้ตอบก่อนเหมือนการ์ดอื่น
- **`rm -rf` ภายใน workspace ต่างออกไป** กฎ `rm-rf-in-workspace` ให้ classifier ตัดสินในโหมด Auto
  เฉพาะการลบ workspace ทั้งก้อน `.git` หรือนอก workspace ที่ถามผู้ใช้เสมอ

classifier ตัดสินอย่างไรเมื่อไม่ต้องถามคุณ ดู [โหมด Auto ให้ classifier ตัดสินคำสั่ง](/scenarios/perm/auto-classifier/)
