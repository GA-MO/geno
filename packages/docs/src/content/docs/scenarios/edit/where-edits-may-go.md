---
title: "แก้ไฟล์นอก workspace หรือในที่ที่กฎ Edit ครอบ"
description: edit เขียนได้เฉพาะใน workspace, scratchpad ของ session และโฟลเดอร์ที่ตั้งให้เขียนได้ โดยดูจาก path จริงของไฟล์ ที่อื่นถูกปฏิเสธโดยไม่มีการ์ด ภายใน workspace กฎ Edit(...) ของผู้ใช้ทำให้ถามหรือปฏิเสธก่อนแก้
scenario:
  surface: vscode
  given:
    - turn กำลังทำงานในโหมด Ask หรือ Auto
    - ผู้ใช้ตั้งกฎ path ไว้ใน Settings ส่วน Permissions คือ `Edit(src/generated/**)` แบบ ask หรือแบบ deny
  trigger: >-
    model ขอเรียก `edit` กับไฟล์ที่ไม่ได้อยู่ในที่ที่ edit เขียนได้อย่างอิสระ
  covers: [edit.outside-workspace, edit.path-rule]
  related: [edit.applied-as-diff, edit.without-read-or-stale, perm.read-outside-workspace, perm.deny-rule, perm.ask-allow]
  steps:
    - id: asks
      beat:
        title: Model ขอแก้ไฟล์
        text: >-
          model ขอ edit ไฟล์หนึ่ง Geno ต้องตัดสินก่อนว่าไฟล์นั้นอยู่ในที่ที่แก้ได้หรือไม่ คือใน workspace (โฟลเดอร์ที่คุณเปิด) หรือในที่อื่นที่ Geno ให้เขียน
          การ์ดข้างล่างมาจากการบันทึกที่รัน Geno จริงกับ model จำลองที่ตอบตามบทที่เขียนไว้ก่อน เป็นทาง `/etc/hosts` นอก workspace
          การบันทึกนี้รันในโหมด Ask การ์ดคือคำตอบของ model ตามที่ Geno ใส่กลับในคำขอถัดไป ดู `input` ที่ไฮไลต์ `path` เป็น `/etc/hosts`
        from: model
        to: engine
        sees:
          kind: payload
          source: packages/docs/src/data/recorded/edit-where-edits-may-go.jsonl#line=4
          select: messages[-2]
          highlight: ['content[1].input']
      lane: model
      do: >-
        model ขอ `edit` และจบคำตอบด้วย `stop_reason: tool_use`
      ref: "packages/engine/src/gateway.ts#\"stopReason: message.stop_reason,\""
      emits: [tool_use]
      phase: calling-model

    - use: tool-call-opens
      beat:
        title: แชตขึ้นขั้น edit
        text: Geno จัดคิวการแก้ให้รันทีละตัว แผงแชตขึ้นขั้นใหม่พร้อมจุดหมุน
        from: panel
        to: you
        sees:
          kind: step
          label: edit
          status: running

    - id: rules
      beat:
        title: Geno หาว่าไฟล์อยู่ที่ไหนและกฎไหนครอบ
        text: กฎ path คือกฎ permission ที่คุณตั้งตาม path เช่น `Edit(src/generated/**)` บอกว่า path แบบนี้ต้องถามก่อนแก้ (ask) หรือห้ามแก้ (deny) Geno อ่านกฎเหล่านี้ใหม่ทุกครั้ง หาที่อยู่จริงของไฟล์ แล้วดูว่ามีกฎ `Edit(...)` ข้อไหนครอบ คำตอบขึ้นกับไฟล์ที่ model ขอ
        from: engine
        to: engine
        ask: Model ขอแก้ไฟล์ไหน
      lane: policy
      at: rules
      do: >-
        `withPathRules` อ่านกฎของ workspace ใหม่ทุก call ถ้ามีกฎ path อยู่ `askPathRule` หาที่เขียนจริงด้วย `resolveWritable`
        แล้วหากฎ `edit` ที่ครอบ path นั้น ถ้าไม่มีกฎ path เลย `edit` ก็เรียก `resolveWritable` เองตอนเริ่ม
      ref: packages/engine/src/tools/agent.ts#withPathRules
      fork:
        ask: model ขอแก้ไฟล์ไหน
        options:
          - id: outside
            label: /etc/hosts นอก workspace
            then: refused
            steps:
              - lane: tool
                beat:
                  title: ไฟล์อยู่นอก workspace
                  text: edit เขียนได้เฉพาะใน workspace, scratchpad ของ session (โฟลเดอร์ชั่วคราวที่ Geno บอก model ไว้ในส่วนสภาพแวดล้อม) และโฟลเดอร์ที่คุณตั้งให้เขียนได้ ที่อื่นถูกปฏิเสธทันทีโดยไม่มีการ์ดถามคุณ Geno ดูจาก path จริงของไฟล์หลังตาม symlink แล้ว symlink ที่ชี้ออกไปนอก workspace จึงถูกปฏิเสธ ส่วน path ที่ผ่าน symlink แล้วถึง workspace ผ่านได้ Geno เขียนเหตุผลไว้ในผลที่ถึง model ตอนเรียกครั้งถัดไป
                  from: engine
                  to: engine
                at: executor
                runs: 0
                do: >-
                  `resolveWritable` หา path จริงของไฟล์ (หรือของโฟลเดอร์แม่ที่มีอยู่ ถ้าไฟล์ยังไม่มี) แล้วเห็นว่าไม่อยู่ใน workspace
                  ไม่อยู่ใน scratchpad ของ session (`writeRoots` ที่ `runAgent` ใส่ให้ทุก tool) และไม่อยู่ในโฟลเดอร์ที่ `additionalDirectories` ตั้งให้เขียนได้
                  จึงโยน `ToolError` "/etc/hosts is outside the workspace" เพราะดูจาก path จริงอย่างเดียว symlink ที่ชี้ออกไปนอก workspace จึงถูกจับ
                  และ `/tmp/...` ที่ path จริงอยู่ใต้ `/private/tmp` ก็ถึง scratchpad ได้
                  ไม่มีการ์ด เพราะการแก้นอก workspace อนุญาตไม่ได้ และไม่มี checkpoint ให้ย้อน
                ref: packages/engine/src/tools/context.ts#resolveWritable
                emits: [is outside the workspace]
          - id: ask-rule
            label: ไฟล์ที่กฎ ask ครอบ
            steps:
              - lane: policy
                beat:
                  title: กฎของคุณสั่งให้ถามก่อนแก้
                  text: กฎ `Edit(src/generated/**)` แบบ ask ครอบไฟล์นี้ แม้ในโหมด Auto Geno ก็ไม่ให้ classifier (การเรียก model แยกที่โหมด Auto ใช้ตัดสินแทนคุณ) ตัดสิน เพราะกฎบอกให้ถามคุณ
                  from: engine
                  to: engine
                at: rules
                do: >-
                  `pathRuleFor` เจอกฎ ask `Edit(src/generated/**)` `userRuleDenial` สร้างคำถาม `workspace-ask` สำหรับ `edit src/generated/api.ts`
                  (ในโหมด Plan คำถามนี้กลายเป็นปฏิเสธ)
                ref: packages/core/src/permission-rules.ts#userRuleDenial
                emits: [workspace-ask]
              - lane: policy
                at: settle
                do: >-
                  `settle` ไม่ส่งให้ classifier แม้ในโหมด Auto เพราะคำตัดสินคือ `ask` ไม่ใช่ `classify` ไม่มี hook ตอบแทน จึงถามผู้ใช้
                ref: packages/engine/src/tools/agent.ts#settle
              - lane: server
                beat:
                  title: Geno หยุด turn แล้วถามคุณ
                  text: Geno ส่งคำขอ permission ให้ VS Code แผงแชตเลื่อนมาให้เห็นและรอคำตอบของคุณ
                  from: engine
                  to: panel
                at: approvals
                do: >-
                  `editorTurn.approve` ส่งคำขอ ACP `session/request_permission` ชนิดของ call เป็น `execute` เพราะกฎ workspace ไม่มีชนิดของตัวเอง
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
                  text: การ์ดใช้หน้าตาเดียวกับการขอรันคำสั่ง และบอกว่ากฎข้อไหนของคุณทำให้ Geno ถาม
                  from: panel
                  to: you
                  sees:
                    kind: permission
                    command: edit src/generated/api.ts
                    reason: Geno asks because it uses the workspace rule that asks before `Edit(src/generated/**)`.
                    options:
                      - Allow
                      - Deny
                      - No, and tell the agent…
                at: card
                do: >-
                  การ์ดใช้หน้าตาของคำสั่ง ไม่ใช่การ์ด "Change this file?" ซึ่งใช้กับ agent ภายนอกเท่านั้น
                sees: >-
                  การ์ด "Run this command?" แสดง `edit src/generated/api.ts`
                  "Geno asks because it uses the workspace rule that asks before `Edit(src/generated/**)`, which the user set in ..."
                  ปุ่ม [Allow] [Deny] [No, and tell the agent…]
                ref: packages/extension/src/chat/render.ts#permissionCard
              - lane: user
                beat:
                  title: คุณกด Allow แล้ว Geno แก้ไฟล์ตามปกติ
                  text: การ์ดย่อเหลือ Allowed Geno จดว่าคุณเป็นคนอนุญาต แล้วการแก้เดินต่อแบบเดียวกับไฟล์ที่ไม่มีกฎครอบ
                  from: you
                  to: panel
                  end: แก้ไฟล์ตามปกติ
                do: ผู้ใช้กด Allow
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
                  `settle` คืนบันทึก `decidedBy: user, verdict: allow` แล้ว `edit` ทำงานตามปกติ ผลของมันแนบบันทึกว่าผู้ใช้อนุญาต
                ref: packages/engine/src/tools/agent.ts#settle
                phase: running-tools
                goto: edit.applied-as-diff
          - id: deny-rule
            label: ไฟล์ที่กฎ deny ครอบ
            then: refused
            steps:
              - lane: policy
                beat:
                  title: กฎของคุณปฏิเสธทันที
                  text: กฎ `Edit(src/generated/**)` แบบ deny ครอบไฟล์นี้ Geno ไม่ถามใคร และจดว่ากฎเป็นคนปฏิเสธ เหตุผลอยู่ในผลที่ถึง model ตอนเรียกครั้งถัดไป
                  from: engine
                  to: engine
                at: rules
                do: >-
                  กฎเป็น deny `settle` ไม่ถามใครและบันทึก `decidedBy: rule, verdict: deny` `refusalOf` โยน `ToolDenied`
                  "denied: `edit src/generated/api.ts` matches the workspace rule that denies `Edit(src/generated/**)` ..."
                ref: packages/engine/src/tools/agent.ts#refusalOf
                emits: [ToolDenied, workspace-deny]

    - id: refused
      beat:
        title: Geno ไม่เขียนอะไรเลย
        text: ไฟล์ไม่ถูกแตะ Geno ไม่ได้อ่านมันด้วยซ้ำ ผลบอกเหตุผลให้ model ทาง `/etc/hosts` ขั้นของ edit ในแชตขึ้นว่าล้มเหลวอย่างที่เห็นข้างล่าง ทางกฎ deny ขั้นเดียวกันขึ้นว่าถูกปฏิเสธ (Denied) แทน
        from: engine
        to: panel
        sees:
          kind: step
          label: edit
          status: failed
      lane: tool
      at: executor
      runs: 0
      do: >-
        ไม่มีอะไรถูกเขียน ไฟล์ไม่ถูกอ่านผ่าน editor ด้วยซ้ำ ผลของ call เป็น `error` (นอก workspace) หรือ `denied` (กฎ deny)
        ผล `denied` พาบันทึกการตัดสินของกฎไปด้วย update ปิดของมันจึงมี `APPROVAL_META` ส่วนผล `error` ไม่มีบันทึก
      ref: packages/engine/src/tools/index.ts#runExecutor

    - use: tool-result-returns

    - id: next
      beat:
        title: Model อ่านเหตุผลแล้วตัดสินใจต่อ
        text: >-
          turn ไม่จบ model อ่านเหตุผลแล้วบอกคุณ หรือหาทางอื่นที่อยู่ในที่ที่แก้ได้ ในการบันทึกทาง `/etc/hosts` ผลที่ model ได้คือ error
          "/etc/hosts is outside the workspace" การ์ดข้างล่างคือ event หนึ่งใน stream ของคำตอบถัดไปของ model ดู `text` ที่ไฮไลต์
          model บอกว่าแก้ไฟล์นี้ไม่ได้ และบอกให้คุณเพิ่มบรรทัดเอง แล้วคำตอบจบด้วย `stop_reason: end_turn`
        from: model
        to: engine
        end: Model อ่านเหตุผลแล้วทำต่อ
        sees:
          kind: payload
          source: packages/docs/src/data/recorded/edit-where-edits-may-go.jsonl#line=5
          select: '[2]'
          highlight: [data.delta.text]
      lane: loop
      at: step
      do: >-
        `loopStep` ตัดสิน `call-model` turn ไม่จบ model อ่านเหตุผลแล้วบอกผู้ใช้ หรือหาทางอื่น
      ref: packages/core/src/loop.ts#loopStep
      emits: [call-model]
      phase: calling-model
      end: { turn: continues, reason: call-model }
---

หน้านี้เล่าว่าเกิดอะไรเมื่อ model ขอแก้ไฟล์ที่อยู่นอกโฟลเดอร์ที่คุณเปิด หรือไฟล์ที่กฎของคุณสั่งให้ถามหรือห้าม
มีสามทาง ปฏิเสธเงียบๆ ถามคุณด้วยการ์ด หรือปฏิเสธตามกฎ และ model เห็นผลต่างกัน

`edit` ไม่ถามก่อนแก้ไฟล์ใน workspace ในโหมด Ask หรือ Auto ผู้ใช้ตรวจการแก้ทีหลังเป็น [hunk](/start/glossary/) ใน editor
ที่ที่ edit ไปไม่ได้หรือต้องถาม จึงถูกกำหนดด้วยที่อยู่ของไฟล์ Geno ดูจาก path จริงของไฟล์หลังตาม symlink แล้ว

| ไฟล์ | ผล | สถานะของผล |
| --- | --- | --- |
| ใน workspace ไม่มีกฎ | แก้ทันที | `ok` |
| ใน scratchpad ของ session | แก้ทันที | `ok` |
| ในโฟลเดอร์ `additionalDirectories` ที่ตั้งให้เขียนได้ | แก้ทันที | `ok` |
| ครอบด้วยกฎ `Edit(...)` แบบ ask | การ์ด (โหมด Plan ปฏิเสธ) | ตามคำตอบ |
| ครอบด้วยกฎ `Edit(...)` แบบ deny หรือ `Read(...)` แบบ deny | ปฏิเสธ | `denied` |
| ที่อื่น รวม symlink ที่ชี้ออกไปนอกที่ข้างบน | ปฏิเสธ ไม่มีการ์ด | `error` |

สิ่งที่ควรสังเกต

- **การ์ดของกฎ Edit เขียนว่า "Run this command?"** engine ส่งชนิด `execute` ให้ทุกกฎของ workspace แผงจึงใช้หน้าตาของคำสั่ง
  ทั้งที่สิ่งที่ถามคือการแก้ไฟล์
- **นอก workspace ไม่ใช่การปฏิเสธของนโยบาย** ข้อความไม่มีป้าย "Denied" ขั้นแค่ล้มเหลว
  วิธีให้ Geno เขียนนอก workspace คือเพิ่มโฟลเดอร์ใน `additionalDirectories` แบบเขียนได้ ไม่ใช่ตอบการ์ด
- **กฎ `Edit` ของ Claude Code ใช้ได้ด้วย** กฎ path ใน `.claude/settings.json` ถูกอ่านเป็นกฎของ workspace แบบเดียวกัน
  และ `Edit` แบบไม่มี path ห้าม `edit` กับ `notebook_edit` ทั้งตัว
