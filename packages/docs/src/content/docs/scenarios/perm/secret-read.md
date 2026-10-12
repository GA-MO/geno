---
title: "Model อ่านไฟล์ลับอย่าง .env"
description: read ของไฟล์ที่ดูเหมือนเก็บรหัสต้องผ่านด่านไฟล์ลับก่อนเปิด โหมด Ask ถามผู้ใช้ Auto ให้ classifier ตัดสิน และ Plan ปฏิเสธ
scenario:
  surface: vscode
  given:
    - turn กำลังทำงาน workspace มีไฟล์ `.env`
    - ไม่มีกฎของ workspace ที่ตรงกับ path นี้
  trigger: >-
    model ขอเรียก `read` ด้วย path `.env`
  covers: [perm.secret-read]
  related: [perm.read-outside-workspace, perm.ask-allow, perm.auto-classifier-allows, perm.ask-deny-ends-turn]
  steps:
    - id: asks
      lane: model
      beat:
        title: "Model ขออ่าน .env"
        text: >-
          model ขอ `read` ไฟล์ `.env` ไม่มีกฎของ workspace ตรงกับ path นี้ แชตขึ้นขั้นใหม่พร้อมจุดหมุน
        from: model
        to: engine
      do: >-
        model ขอ `read` ไฟล์ `.env` จบด้วย `stop_reason: tool_use`
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

    - id: secret
      lane: tool
      at: executor
      beat:
        title: "read ตรวจว่าเป็นไฟล์ลับก่อนเปิด"
        text: >-
          การอ่านไฟล์ที่ดูเป็นไฟล์ลับรันตัวเดียวในชุด เพราะอาจต้องถาม read ตรวจทั้งชื่อที่ขอและไฟล์ที่ชื่อนั้นชี้ไปจริง
          ลิงก์ที่ชี้ไป `.env` จึงผ่านด่านเดียวกัน
        from: engine
        to: engine
      runs: 0
      do: >-
        `read` ของ path ที่ดูเป็นไฟล์ลับรันตัวเดียวในชุด เพราะอาจต้องถาม มันตรวจทั้งชื่อที่ขอและไฟล์ที่ชื่อนั้นชี้ไปจริง
        ลิงก์ชื่อ `.env` และลิงก์ที่ชี้ไป `.env` จึงผ่านด่านเดียวกัน แล้วส่งให้ `askSecret` ก่อนเปิดไฟล์
      ref: "packages/engine/src/tools/read.ts#\"const secret = isSecret(ctx, path.resolve(ctx.workspace, input.path)) || isSecret(ctx, real);\""

    - id: judge
      lane: policy
      at: rules
      beat:
        title: "Geno ใช้กฎของไฟล์ลับ"
        text: >-
          กฎของไฟล์เก็บรหัสตัดสินตามโหมด และ hook ที่อนุญาต call นี้ข้ามด่านนี้ไม่ได้ บันทึกจาก run จริงในโหมด Auto
          ด้านล่างเป็นตอนที่ classifier ปฏิเสธ ลองเลือกโหมด
        from: engine
        to: engine
        ask: "โหมดไหน"
        sees:
          kind: payload
          source: docs/results/real-usecases/runs/A09-auto-classifier/1/session.jsonl#seq=16
          highlight: [approval.rule, approval.reason]
      do: >-
        `secretReadDenial` ใช้กฎ `secret-path` ("a credentials file such as .env") ซึ่งคำตัดสินขึ้นกับโหมด
        PreToolUse hook ที่อนุญาต call นี้ไม่ได้ข้ามด่านนี้
      ref: packages/core/src/approval.ts#secretReadDenial
      emits: [secret-path]
      fork:
        ask: session อยู่ในโหมดไหน
        options:
          - id: ask
            label: Ask
            then: open
            steps:
              - lane: policy
                at: settle
                beat:
                  title: "โหมด Ask ถามคุณ"
                  text: >-
                    Geno ส่งคำถามไปที่แชต การ์ดไม่มีปุ่มบันทึกกฎ เพราะไฟล์ลับไม่มีรูปแบบให้อนุญาตถาวร
                  from: engine
                  to: panel
                do: >-
                  `settle` ส่งคำถามต่อให้ผู้ใช้ผ่าน `approval.approve`
                ref: packages/engine/src/tools/agent.ts#settle
              - lane: server
                at: approvals
                do: >-
                  `editorTurn.approve` ส่งคำขอ ACP `session/request_permission` ไม่มีปุ่มบันทึกกฎ เพราะไฟล์ลับไม่มีรูปแบบให้อนุญาตถาวร
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
                at: card
                beat:
                  title: "คุณเห็นการ์ด “Run this command?”"
                  text: >-
                    การ์ดแสดงการอ่าน `.env` พร้อมเหตุผล turn รออยู่ตรงนี้ ลองเลือกแต่ละทาง
                  from: panel
                  to: you
                  ask: "กดปุ่มไหน"
                  sees: { kind: permission, command: read .env, reason: Geno asks because it uses a credentials file such as .env., options: [ Allow, Deny, "No, and tell the agent…" ] }
                do: การ์ดขออนุญาตแสดงคำสั่งและเหตุผล
                sees: >-
                  การ์ด "Run this command?" แสดง `read .env` พร้อมเหตุผล "Geno asks because it uses a credentials file such as .env."
                  [Allow] [Deny] [No, and tell the agent…]
                ref: packages/extension/src/chat/render.ts#permissionCard
              - lane: user
                do: ผู้ใช้เลือกปุ่มบนการ์ด
                fork:
                  ask: ผู้ใช้กดปุ่มไหน
                  options:
                    - id: allow
                      label: Allow
                      steps:
                        - lane: editor
                          at: chat
                          beat:
                            title: "คุณกด Allow"
                            text: >-
                              Geno จดว่าคุณอนุญาตการอ่านครั้งนี้ครั้งเดียว
                            from: you
                            to: panel
                          do: >-
                            `askPermission` ตอบ engine ว่า `selected` ตัวเลือก `allow`
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
                            `settle` คืนบันทึก `decidedBy: user, verdict: allow` สำหรับการอ่านครั้งนี้ครั้งเดียว
                          ref: packages/engine/src/tools/agent.ts#settle
                          phase: running-tools
                    - id: reject
                      label: Deny
                      steps:
                        - lane: editor
                          at: chat
                          beat:
                            title: "คุณกด Deny"
                            text: >-
                              ไฟล์ไม่ถูกเปิด turn จบรอคุณเหมือนการปฏิเสธคำสั่งในโหมด Ask ทัวร์นั้นเล่าต่อ
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
                            `askSecret` โยน `ToolRejected` ไฟล์ไม่ถูกเปิด turn จบรอผู้ใช้
                          ref: packages/engine/src/tools/agent.ts#refusalOf
                          emits: [ToolRejected]
                          phase: running-tools
                          goto: perm.ask-deny-ends-turn
          - id: auto
            label: Auto
            then: open
            steps:
              - lane: policy
                at: classifier
                beat:
                  title: "โหมด Auto ให้ classifier ตัดสิน"
                  text: >-
                    classifier ได้บริบทของ turn แล้วอนุญาต เช่นงานต้องรู้ชื่อตัวแปรใน `.env` ถ้ามันปฏิเสธหรือไม่แน่ใจ
                    ทางเป็นแบบเดียวกับคำสั่งในโหมด Auto
                  from: engine
                  to: engine
                do: >-
                  `settle` ส่งคำขอให้ classifier พร้อมบริบทของ turn classifier ตอบว่าอนุญาต (เช่น งานต้องรู้ชื่อตัวแปรใน `.env`)
                  ถ้า classifier ปฏิเสธหรือไม่แน่ใจ ทางจะเป็นแบบเดียวกับคำสั่งในโหมด Auto
                ref: packages/engine/src/classifier.ts#commandClassifier
                emits: [classifier]
                phase: running-tools
          - id: plan
            label: Plan
            steps:
              - lane: policy
                at: settle
                beat:
                  title: "โหมด Plan ปฏิเสธเอง"
                  text: >-
                    โหมด Plan ปฏิเสธไฟล์ลับโดยไม่ถาม แชตขึ้นป้าย Denied by a rule ผลกลับมาที่แชต
                  from: engine
                  to: panel
                  sees: { kind: step, label: read .env, status: denied, note: Denied by a rule }
                do: >-
                  คำตัดสินของ `secret-path` ในโหมด Plan คือ `deny` `settle` ปฏิเสธเองโดยไม่ถาม `refusalOf` สร้าง `ToolDenied`
                  แผงขึ้นป้าย "Denied by a rule" และ model ทำงานต่อโดยไม่ได้อ่านไฟล์
                ref: packages/engine/src/tools/agent.ts#refusalOf
                emits: [ToolDenied]
                phase: running-tools
              - use: tool-result-returns
              - lane: loop
                at: step
                beat:
                  title: "Model ทำต่อโดยไม่ได้อ่านไฟล์"
                  text: >-
                    Geno เรียก model ต่อ model ทำแผนต่อโดยไม่ได้อ่าน `.env`
                  from: engine
                  to: model
                  end: "Plan ปฏิเสธ turn ทำต่อ"
                do: >-
                  `loopStep` เห็น `tool-result` ล่าสุดจึงตัดสิน `call-model`
                ref: packages/core/src/loop.ts#loopStep
                emits: [call-model]
                phase: calling-model
                end: { turn: continues, reason: call-model }

    - id: open
      lane: tool
      at: executor
      beat:
        title: "read เปิดไฟล์ทั้งไฟล์ ไม่ปิดบังค่า"
        text: >-
          read เปิดไฟล์ผ่าน VS Code แล้วคืนข้อความทั้งไฟล์พร้อมเลขบรรทัด ค่าในไฟล์ไม่ถูกปิดบัง
          ผลกลับมาที่แชตพร้อมบันทึกว่าใครอนุญาต
        from: engine
        to: machine
      runs: 1
      do: >-
        `read` เปิดไฟล์ผ่าน editor และคืนข้อความทั้งไฟล์พร้อมเลขบรรทัด ค่าในไฟล์ไม่ถูกปิดบัง
        ผลมีบันทึกว่าใครอนุญาต (`approval`) อัปเดตผลของ call นี้จึงมี `APPROVAL_META`
      ref: packages/engine/src/tools/read.ts#readResolved

    - use: tool-result-returns

    - id: next
      lane: loop
      at: step
      beat:
        title: "ค่าในไฟล์ไปถึง model"
        text: >-
          Geno เรียก model ต่อ ค่าใน `.env` อยู่ในบันทึกของ session และในคำขอถัดไปที่ส่งให้ผู้ให้บริการ
        from: engine
        to: model
        end: "อ่านไฟล์ลับแล้ว turn ทำต่อ"
      do: >-
        `loopStep` เห็น `tool-result` ล่าสุดจึงตัดสิน `call-model` ค่าในไฟล์อยู่ใน log และในคำขอถัดไป
      ref: packages/core/src/loop.ts#loopStep
      emits: [call-model]
      phase: calling-model
      end: { turn: continues, reason: call-model }
---

ด่านไฟล์ลับอยู่ใน `read` เอง ไม่ใช่ในกฎของคำสั่ง จึงทำงานแม้ path ชี้ผ่านลิงก์ และแม้ PreToolUse hook อนุญาต call ไว้แล้ว

| โหมด | `read .env` |
| --- | --- |
| Ask | ถามผู้ใช้ ไม่มีปุ่มอนุญาตถาวร |
| Auto | classifier ตัดสิน |
| Plan | ปฏิเสธ |
| ไม่มีคนดู | ปฏิเสธ |

สิ่งที่ควรสังเกต

- **อนุญาตแล้วค่าไม่ถูกปิดบัง** Geno ปิดบังรหัสใน output ของเทอร์มินัล log ของ preview และ log ของ PR
  แต่ไม่ปิดบังผลของ `read` หรือ `bash` ด่านของไฟล์ลับคือการถามก่อนเปิด ไม่ใช่การปิดบังหลังเปิด
- **`grep` และ `glob` ไม่ถาม** tool ค้นหาปฏิเสธไฟล์ลับทันที หรือข้ามมันในผลการค้น ผู้ใช้จึงไม่เห็นการ์ดจากการค้นหา
- **`cat .env` ผ่านด่านเดียวกัน** คำสั่ง shell ที่มีคำตรงกับรูปแบบไฟล์ลับติดกฎ `secret-path` ของคำสั่ง
  และ sandbox ห้ามทุกคำสั่งอ่านที่เก็บรหัสใน home เช่น `~/.ssh` และ `~/.aws` เสมอ

ไฟล์นอก workspace ดู [Model อ่านไฟล์นอก workspace](/scenarios/perm/read-outside-workspace/)
