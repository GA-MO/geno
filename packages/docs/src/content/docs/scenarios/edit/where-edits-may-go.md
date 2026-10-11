---
title: แก้ไฟล์นอก workspace หรือในที่ที่กฎ Edit ครอบ
description: edit เขียนได้เฉพาะใน workspace และโฟลเดอร์ที่ตั้งให้เขียนได้ ที่อื่นถูกปฏิเสธโดยไม่มีการ์ด ภายใน workspace กฎ Edit(...) ของผู้ใช้ทำให้ถามหรือปฏิเสธก่อนแก้
tableOfContents: false
sidebar:
  order: 4
scenario:
  surface: vscode
  given:
    - turn กำลังทำงานในโหมด Ask หรือ Auto
    - ผู้ใช้ตั้งกฎ path ไว้ใน Settings ส่วน Permissions คือ `Edit(src/generated/**)` แบบ ask หรือแบบ deny
  trigger: >-
    โมเดลขอเรียก `edit` กับไฟล์ที่ไม่ได้อยู่ในที่ที่ edit เขียนได้อย่างอิสระ
  covers: [edit.outside-workspace, edit.path-rule]
  related: [edit.applied-as-diff, edit.without-read-or-stale, perm.read-outside-workspace, perm.deny-rule, perm.ask-allow]
  steps:
    - id: asks
      lane: model
      do: >-
        โมเดลขอ `edit` และจบคำตอบด้วย `stop_reason: tool_use`
      ref: "packages/engine/src/gateway.ts#\"stopReason: message.stop_reason,\""
      emits: [tool_use]
      phase: calling-model

    - use: tool-call-opens

    - id: rules
      lane: policy
      at: rules
      do: >-
        `withPathRules` อ่านกฎของ workspace ใหม่ทุก call ถ้ามีกฎ path อยู่ `askPathRule` หาที่เขียนจริงด้วย `resolveWritable`
        แล้วหากฎ `edit` ที่ครอบ path นั้น ถ้าไม่มีกฎ path เลย `edit` ก็เรียก `resolveWritable` เองตอนเริ่ม
      ref: packages/engine/src/tools/agent.ts#withPathRules
      fork:
        ask: โมเดลขอแก้ไฟล์ไหน
        options:
          - id: outside
            label: /etc/hosts (นอก workspace)
            then: refused
            steps:
              - lane: tool
                at: executor
                runs: 0
                do: >-
                  `resolveWritable` เห็นว่า path ไม่อยู่ใน workspace และไม่อยู่ในโฟลเดอร์ที่ `additionalDirectories` ตั้งให้เขียนได้
                  จึงโยน `ToolError` "/etc/hosts is outside the workspace" symlink ที่ชี้ออกไปนอก workspace ก็ถูกจับแบบเดียวกัน
                  ไม่มีการ์ด เพราะการแก้นอก workspace อนุญาตไม่ได้ และไม่มี checkpoint ให้ย้อน
                ref: packages/engine/src/tools/context.ts#resolveWritable
                emits: [is outside the workspace]
          - id: ask-rule
            label: src/generated/api.ts (กฎ ask)
            steps:
              - lane: policy
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
                at: card
                do: >-
                  การ์ดใช้หน้าตาของคำสั่ง ไม่ใช่การ์ด "Change this file?" ซึ่งใช้กับ agent ภายนอกเท่านั้น
                sees: >-
                  การ์ด "Run this command?" แสดง `edit src/generated/api.ts`
                  "Geno asks because it uses the workspace rule that asks before `Edit(src/generated/**)`, which the user set in ..."
                  ปุ่ม [Allow] [Deny] [No, and tell the agent…]
                ref: packages/extension/src/chat/render.ts#permissionCard
              - lane: user
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
                  `settle` บันทึก `decidedBy: user, verdict: allow` แล้ว `edit` ทำงานตามปกติ ผลของมันแนบบันทึกว่าผู้ใช้อนุญาต
                ref: packages/engine/src/tools/agent.ts#settle
                phase: running-tools
                goto: edit.applied-as-diff
          - id: deny-rule
            label: src/generated/api.ts (กฎ deny)
            then: refused
            steps:
              - lane: policy
                at: rules
                do: >-
                  กฎเป็น deny `settle` ไม่ถามใครและบันทึก `decidedBy: rule, verdict: deny` `refusalOf` โยน `ToolDenied`
                  "denied: `edit src/generated/api.ts` matches the workspace rule that denies `Edit(src/generated/**)` ..."
                ref: packages/engine/src/tools/agent.ts#refusalOf
                emits: [ToolDenied, workspace-deny]

    - id: refused
      lane: tool
      at: executor
      runs: 0
      do: >-
        ไม่มีอะไรถูกเขียน ไฟล์ไม่ถูกอ่านผ่าน editor ด้วยซ้ำ ผลของ call เป็น `error` (นอก workspace) หรือ `denied` (กฎ deny)
      ref: packages/engine/src/tools/index.ts#runExecutor

    - use: tool-result-returns

    - id: next
      lane: loop
      at: step
      do: >-
        `loopStep` ตัดสิน `call-model` turn ไม่จบ โมเดลอ่านเหตุผลแล้วบอกผู้ใช้ หรือหาทางอื่น
      ref: packages/core/src/loop.ts#loopStep
      emits: [call-model]
      phase: calling-model
      end: { turn: continues, reason: call-model }
---

`edit` ไม่ถามก่อนแก้ไฟล์ใน workspace ในโหมด Ask หรือ Auto ผู้ใช้ตรวจการแก้ทีหลังเป็น hunk ใน editor
ที่ที่ edit ไปไม่ได้หรือต้องถาม จึงถูกกำหนดด้วยที่อยู่ของไฟล์

| ไฟล์ | ผล | สถานะของผล |
| --- | --- | --- |
| ใน workspace ไม่มีกฎ | แก้ทันที | `ok` |
| ในโฟลเดอร์ `additionalDirectories` ที่ตั้งให้เขียนได้ | แก้ทันที | `ok` |
| ครอบด้วยกฎ `Edit(...)` แบบ ask | การ์ด (โหมด Plan ปฏิเสธ) | ตามคำตอบ |
| ครอบด้วยกฎ `Edit(...)` แบบ deny หรือ `Read(...)` แบบ deny | ปฏิเสธ | `denied` |
| นอก workspace | ปฏิเสธ ไม่มีการ์ด | `error` |

สิ่งที่ควรสังเกต

- **การ์ดของกฎ Edit เขียนว่า "Run this command?"** engine ส่งชนิด `execute` ให้ทุกกฎของ workspace แผงจึงใช้หน้าตาของคำสั่ง
  ทั้งที่สิ่งที่ถามคือการแก้ไฟล์
- **นอก workspace ไม่ใช่การปฏิเสธของนโยบาย** ข้อความไม่มีป้าย "Denied" ขั้นแค่ล้มเหลว
  วิธีให้ Geno เขียนนอก workspace คือเพิ่มโฟลเดอร์ใน `additionalDirectories` แบบเขียนได้ ไม่ใช่ตอบการ์ด
- **กฎ `Edit` ของ Claude Code ใช้ได้ด้วย** กฎ path ใน `.claude/settings.json` ถูกอ่านเป็นกฎของ workspace แบบเดียวกัน
  และ `Edit` แบบไม่มี path ห้าม `edit` กับ `notebook_edit` ทั้งตัว
