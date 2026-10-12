---
title: โหมด Auto ยังขึ้นการ์ดถาม
description: สามทางที่โหมด Auto ถามผู้ใช้แทน classifier เมื่อ Auto พักเพราะบล็อกบ่อย เมื่อคำสั่ง rm -rf แตะ workspace หรือนอกมัน และเมื่อกฎ ask ของ workspace ตรงกับคำสั่ง
tableOfContents: false
sidebar:
  order: 3
scenario:
  surface: vscode
  given:
    - session อยู่ในโหมด Auto
    - ไม่มี hook ที่ตั้งไว้
  trigger: >-
    โมเดลขอเรียก `bash` ด้วยคำสั่งที่ไม่อยู่ใน safe list
  covers: [perm.auto-paused-asks-user, perm.auto-hard-ask, perm.workspace-ask-rule]
  related: [perm.auto-classifier-blocks, perm.classifier-unavailable, perm.ask-allow, perm.ask-deny-ends-turn, perm.deny-rule]
  steps:
    - id: asks
      lane: model
      do: >-
        โมเดลขอเรียก `bash` และจบคำตอบด้วย `stop_reason: tool_use`
      ref: "packages/engine/src/gateway.ts#\"stopReason: message.stop_reason,\""
      emits: [tool_use]
      phase: calling-model

    - use: tool-call-opens

    - id: rules
      lane: policy
      at: rules
      do: >-
        `approveCommand` ให้ `ruledDenial` ตัดสินตามลำดับ: กฎ deny และ ask ของ workspace ก่อน แล้วกฎในตัวของ Geno
      ref: packages/core/src/permission-rules.ts#ruledDenial
      fork:
        ask: ทำไมคำสั่งนี้ไปถึงผู้ใช้
        options:
          - id: paused
            label: Auto พักอยู่ (node scripts/build-icons.mjs)
            then: ask
            steps:
              - lane: policy
                at: rules
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
                  ก่อนหน้านี้ classifier บล็อกครบ 3 ครั้งติดกัน สถานะ Auto จึงเป็น `paused` ตาราง `CLASSIFIER_OUTCOMES.paused`
                  แปลง `ask` เป็น `ask-user` ไม่ใช่ `block` `settle` ส่งคำถามให้ผู้ใช้พร้อมเหตุผลของ classifier
                ref: packages/core/src/auto.ts#CLASSIFIER_OUTCOMES
                emits: [paused, ask-user]
          - id: hard
            label: rm -rf นอก workspace (rm -rf ../old-build)
            then: ask
            steps:
              - lane: policy
                at: rules
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
                do: >-
                  ผู้ใช้ตั้งกฎ ask `pnpm publish` ไว้ใน Settings `caughtBy` เจอกฎนี้ก่อนกฎในตัว จึงคืน denial `workspace-ask`
                  คำตัดสินเป็น `ask` ในโหมด Auto เช่นเดียวกับ Ask ไม่ส่งให้ classifier (โหมด Plan จะกลายเป็นปฏิเสธ)
                ref: packages/core/src/permission-rules.ts#ruleDenial
                emits: [workspace-ask]

    - id: ask
      lane: server
      at: approvals
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
                  `settle` บันทึก `decidedBy: user, verdict: allow` แล้วเลื่อนสถานะ Auto ด้วย `user-allow`
                  ถ้า Auto พักอยู่ การอนุญาตนี้ทำให้กลับไปเป็น `classifying` และคำสั่งถัดไปที่ classifier ตอบ `ask` จะถูกบล็อกอีกครั้งโดยไม่ถาม
                  ถ้า Auto ไม่ได้พัก ตัวนับการบล็อกติดกันเริ่มใหม่
                ref: packages/core/src/auto.ts#nextAutoState
                emits: [user-allow]
                phase: running-tools
          - id: deny
            label: Deny
            steps:
              - lane: editor
                at: chat
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
                  `settle` บันทึก `verdict: deny` โดยไม่มีความเห็น จึงเป็น `ToolRejected` สถานะ Auto ไม่เปลี่ยน (Auto ที่พักยังพักอยู่)
                  turn จบรอผู้ใช้เหมือนการปฏิเสธในโหมด Ask
                ref: packages/engine/src/tools/agent.ts#refusalOf
                emits: [ToolRejected]
                phase: running-tools
                goto: perm.ask-deny-ends-turn

    - id: run
      lane: tool
      at: shell
      do: >-
        `bash` รันคำสั่งใน sandbox การอนุญาตไม่ได้ยกเว้น sandbox `rm -rf ../old-build` ยังลบนอก workspace ไม่ได้
        ถ้า sandbox ไม่ได้เปิดสิทธิ์เขียนที่นั่นไว้ ผลแนบบันทึกว่าผู้ใช้อนุญาต (`approval`) อัปเดตผลของ call นี้จึงมี `APPROVAL_META`
      ref: "packages/engine/src/tools/agent.ts#\"const result = await tools.sandbox.run(command, {\""

    - use: tool-result-returns

    - id: next
      lane: loop
      at: step
      do: >-
        `loopStep` เห็น `tool-result` ล่าสุดจึงตัดสิน `call-model` โมเดลได้อ่านผลของคำสั่ง
      ref: packages/core/src/loop.ts#loopStep
      emits: [call-model]
      phase: calling-model
      end: { turn: continues, reason: call-model }
---

โหมด Auto ให้ classifier ตัดสินแทนผู้ใช้ ดู [โหมด Auto ให้ classifier ตัดสินคำสั่ง](/scenarios/perm/auto-classifier/)
แต่มีสามทางที่คำถามยังมาถึงผู้ใช้

| ทาง | classifier ถูกเรียกไหม | หลังผู้ใช้อนุญาต |
| --- | --- | --- |
| Auto พัก (บล็อก 3 ครั้งติดกัน หรือ 20 ครั้งรวม) | เรียก และตอบ `ask` | Auto กลับมาตัดสินเอง |
| `rm -rf` ของ workspace, `.git` หรือนอก workspace | ไม่ | ครั้งหน้าถามอีก กฎ allow ครอบไม่ได้ |
| กฎ ask ของ workspace | ไม่ | ครั้งหน้าถามอีก จนกว่าผู้ใช้ลบกฎ |

สิ่งที่ควรสังเกต

- **Auto ที่พักยังรันสิ่งที่ classifier อนุญาต** การพักเปลี่ยนแค่ทางของ `ask` คำตอบ `allow` และ `deny` ของ classifier ยังมีผลตามเดิม
- **การปฏิเสธไม่ปลด Auto** มีแค่การอนุญาตของผู้ใช้ที่ทำให้ Auto กลับไปตัดสินเอง ผู้ใช้ที่กด Deny ไปเรื่อยๆ จะเห็นการ์ดทุกครั้งที่ classifier ไม่แน่ใจ
- **`rm -rf` ภายใน workspace ต่างออกไป** กฎ `rm-rf-in-workspace` ให้ classifier ตัดสินในโหมด Auto
  เฉพาะการลบ workspace ทั้งก้อน `.git` หรือนอก workspace ที่ถามผู้ใช้เสมอ
