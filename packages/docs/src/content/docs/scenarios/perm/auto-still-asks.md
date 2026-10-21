---
title: "โหมด Auto ยังขึ้นการ์ดถามคุณ"
description: สามทางที่โหมด Auto ถามผู้ใช้ เมื่อ classifier ไม่แน่ใจ เมื่อคำสั่ง rm -rf แตะ workspace หรือนอกมัน และเมื่อกฎ ask ของ workspace ตรงกับคำสั่ง
scenario:
  surface: vscode
  given:
    - session อยู่ในโหมด Auto
    - ไม่มี hook ที่ตั้งไว้
  trigger: >-
    model ขอเรียก `bash` ด้วยคำสั่งที่ไม่อยู่ใน safe list
  covers: [perm.auto-classifier-asks-user, perm.auto-hard-ask, perm.workspace-ask-rule]
  related: [perm.classifier-unavailable, perm.ask-allow, perm.ask-deny-ends-turn, perm.deny-rule]
  steps:
    - id: asks
      lane: model
      beat:
        title: "Model ขอรันคำสั่งนอก safe list"
        text: >-
          session อยู่ในโหมด Auto model ขอรันคำสั่งด้วย `bash` แชตขึ้นขั้นใหม่พร้อมจุดหมุน
          ปกติโหมด Auto ส่งคำสั่งนอก safe list (รายการคำสั่งที่รันได้โดยไม่ถาม) ให้ classifier ตัดสินแทนคุณ
          classifier คือการเรียก model แยกอีกครั้งที่ตอบว่า allow ask หรือ deny
          การ์ดข้างล่างเป็นคำตอบจริงจากการรันอื่นในโหมด Auto ที่ model ขอรัน `ps aux` ซึ่งไม่อยู่ใน safe list
          ดู `input` ที่ไฮไลต์
        from: model
        to: engine
        sees:
          kind: payload
          source: docs/results/real-usecases/runs/A09-auto-classifier/1/session.jsonl#seq=18
          select: content
          collapse: ['[0].thinking']
          highlight: ['[1].input']
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
          Geno ดูกฎห้ามและกฎถามของ workspace ก่อน แล้วจึงดูกฎในตัวของ Geno (กฎที่มากับ Geno เช่น safe list และกฎของ `rm -rf`) ปกติโหมด Auto ส่งให้ classifier
          แต่มีสามทางที่คำสั่งไปถึงคุณ ลองเลือกดู
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
            label: classifier ไม่แน่ใจ (node scripts/build-icons.mjs)
            then: ask
            steps:
              - lane: policy
                at: rules
                beat:
                  title: "Classifier ไม่แน่ใจ คำถามจึงไปถึงคุณ"
                  text: >-
                    `node scripts/build-icons.mjs` ไปที่ classifier ซึ่งไม่แน่ใจ ความไม่แน่ใจจึงกลายเป็นคำถามถึงคุณพร้อมเหตุผลของ classifier
                  from: engine
                  to: engine
                do: >-
                  คำสั่งติดกฎ `unlisted` ซึ่งในโหมด Auto คือ `classify` `ruledDenial` แนบรูปแบบ `node scripts/build-icons.mjs` ไว้ให้บันทึกเป็นกฎ
                ref: packages/core/src/permission-rules.ts#ruledDenial
                emits: [unlisted, classify]
              - lane: policy
                at: classifier
                do: >-
                  classifier ไม่แน่ใจ ตอบ `ask` ว่า "Runs a script whose effects are not visible in the conversation"
                ref: packages/engine/src/classifier.ts#commandClassifier
              - lane: policy
                at: settle
                do: >-
                  `settle` ส่งคำตอบ `ask` ของ classifier ให้ผู้ใช้พร้อมเหตุผลของ classifier
                ref: packages/engine/src/tools/agent.ts#settle
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
                    `rm -rf ../old-build` ลบนอก workspace กฎนี้ถามคุณเสมอแม้ในโหมด Auto Geno จึงไม่เรียก classifier
                    กฎอนุญาตที่คุณตั้ง หรือ PreToolUse hook (คำสั่ง shell ที่รันก่อน tool) ที่อนุญาตไว้ ก็ข้ามคำถามนี้ไม่ได้ แต่ PermissionRequest hook (hook ที่ตอบคำถามขออนุญาตแทนคุณ) ยังตอบได้
                    การ์ดจึงไม่มีปุ่ม Always allow ให้บันทึกเป็นกฎ
                  from: engine
                  to: engine
                do: >-
                  กฎ `rm-rf-outside-workspace` ครอบคลุม `rm -rf` ของ workspace เอง `.git` หรือ path นอก workspace
                  คำตัดสินเป็น `ALWAYS_ASK`: Auto ก็ `ask` ไม่ใช่ `classify` จึงไม่มี classifier
                  `isHardAsk` ทำให้กฎ allow และ PreToolUse hook ที่อนุญาตครอบคำสั่งนี้ไม่ได้ ส่วน PermissionRequest hook ยังตอบผ่าน `settle` ได้ และไม่มีรูปแบบให้บันทึก
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
                  คำตัดสินเป็น `ask` ในโหมด Auto เช่นเดียวกับ Ask ไม่ส่งให้ classifier (ในโหมด Plan กฎของ workspace ไม่ถูกอ่าน คำสั่งถูกปฏิเสธตามกฎในตัว)
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
          ปุ่ม No, and tell the agent… ทำงานเหมือนในโหมด Ask: คำสั่งไม่รัน model ได้ข้อความของคุณและทำต่อ
          การ์ดเป็นทาง `rm -rf` นอก workspace
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
                    คำสั่งไม่ได้รัน และ turn จบรอคุณ เหมือนกด Deny ในโหมด Ask
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
          การอนุญาตไม่ได้ยกเว้น sandbox (กรอบของระบบปฏิบัติการที่ให้คำสั่งเขียนไฟล์ได้แค่ใน workspace กับโฟลเดอร์ชั่วคราว)
          ในทาง `rm -rf` นอก workspace `rm -rf ../old-build` จึงยังลบนอก workspace ไม่ได้ถ้า sandbox
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
        title: "Geno เรียก model อีกครั้ง"
        text: >-
          Geno ส่งบทสนทนาทั้งหมดไปให้ model อีกครั้งในคำขอใหม่ ข้อความสุดท้ายของคำขอคือผลของคำสั่ง
          การ์ดข้างล่างเป็นข้อความนั้นจากคำขอจริงของการรันอื่นที่คุณกด Allow บนการ์ดแบบเดียวกัน
          การรันนั้นอยู่ในโหมด Ask แต่ผลที่ส่งให้ model มีรูปเดียวกันไม่ว่าโหมดไหน
          ดูบล็อก `tool_result` ที่ไฮไลต์ `ls` ตอบว่าไม่มีโฟลเดอร์ `build` แล้ว
        from: engine
        to: model
        sees:
          kind: payload
          source: docs/results/real-usecases/runs/B-panel/1/wire.jsonl.gz#line=17
          select: messages[6]
          highlight: ['content[0]']
      do: >-
        `loopStep` เห็น `tool-result` ล่าสุดจึงตัดสิน `call-model` model ได้อ่านผลของคำสั่ง
      ref: packages/core/src/loop.ts#loopStep
      emits: [call-model]
      phase: calling-model

    - id: reply
      lane: model
      beat:
        title: "Model อ่านผลของคำสั่ง"
        text: >-
          model ตอบหลังได้คำขอนี้เท่านั้น ในการรันนั้น model เห็นว่าโฟลเดอร์ถูกลบแล้ว
          จึงขอรัน `bash` อีกตัวเพื่อดู `git status` ให้แน่ใจ ดู `input` ที่ไฮไลต์
        from: model
        to: engine
        sees:
          kind: payload
          source: docs/results/real-usecases/runs/B01-ask-allow/1/session-6107e07a-1ae7-45a7-80c5-9349b64dbbf9.jsonl#seq=13
          select: content
          collapse: ['[0].thinking']
          highlight: ['[1].input']
        end: "คุณอนุญาต turn ทำต่อ"
      do: >-
        model อ่าน `tool_result` ของ `bash` แล้วตอบด้วยคำขอใหม่ ในการรันนี้คือ `bash` อีกตัว
        และจบคำตอบด้วย `stop_reason: tool_use`
      ref: "packages/engine/src/gateway.ts#\"stopReason: message.stop_reason,\""
      emits: [tool_use]
      end: { turn: continues, reason: run-tools }
---

โหมด Auto ให้ classifier ตัดสินแทนผู้ใช้ ดู [โหมด Auto ให้ classifier ตัดสินคำสั่ง](/scenarios/perm/auto-classifier/)
แต่มีสามทางที่คำถามยังมาถึงผู้ใช้

| ทาง | classifier ถูกเรียกไหม | หลังผู้ใช้อนุญาต |
| --- | --- | --- |
| classifier ไม่แน่ใจ หรือใช้ไม่ได้ | เรียก และได้ `ask` | ครั้งหน้า classifier ตัดสินใหม่ |
| `rm -rf` ของ workspace, `.git` หรือนอก workspace | ไม่ | ครั้งหน้าถามอีก กฎ allow ครอบไม่ได้ |
| กฎ ask ของ workspace | ไม่ | ครั้งหน้าถามอีก จนกว่าผู้ใช้ลบกฎ |

สิ่งที่ควรสังเกต

- **มีแค่ `ask` ที่ไปถึงคุณ** คำตอบ `allow` และ `deny` ของ classifier มีผลโดยไม่ถาม
- **`rm -rf` ภายใน workspace ต่างออกไป** กฎ `rm-rf-in-workspace` ให้ classifier ตัดสินในโหมด Auto
  เฉพาะการลบ workspace ทั้งก้อน `.git` หรือนอก workspace ที่ถามผู้ใช้เสมอ

classifier ตัดสินอย่างไรเมื่อไม่ต้องถามคุณ ดู [โหมด Auto ให้ classifier ตัดสินคำสั่ง](/scenarios/perm/auto-classifier/)
