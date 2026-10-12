---
title: อ่านไฟล์นอก workspace
description: โมเดลอ่านไฟล์ในโปรเจกต์อื่น Geno ถามก่อนเหมือน cat ของ path นั้น ผู้ใช้อนุญาตครั้งเดียว อนุญาตทั้งโฟลเดอร์ตลอด session หรือปฏิเสธ
tableOfContents: false
sidebar:
  order: 7
scenario:
  surface: vscode
  given:
    - turn กำลังทำงานในโหมด Ask
    - "`/Users/me/shared-lib` ไม่อยู่ใน workspace ไม่ได้อยู่ใน `additionalDirectories` และยังไม่เคยอนุญาตใน session นี้"
  trigger: >-
    โมเดลขอเรียก `read` ด้วย path `/Users/me/shared-lib/src/date.ts`
  covers: [perm.read-outside-workspace]
  related: [perm.secret-read, perm.ask-allow, perm.ask-deny-ends-turn, tool.read-special-files]
  steps:
    - id: asks
      lane: model
      do: >-
        โมเดลขอ `read` ไฟล์ด้วย path แบบเต็มนอก workspace จบด้วย `stop_reason: tool_use`
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

    - id: outside
      lane: tool
      at: executor
      runs: 0
      do: >-
        `read` ถูกห่อด้วย `withReach` ซึ่งรันมันตัวเดียวในชุดเพราะ path อาจออกนอก workspace
        `outsideOf` หา path จริงแล้วพบว่าไม่อยู่ใน workspace ที่เก็บผลยาว หรือโฟลเดอร์ที่อ่านได้ใดๆ ไม่มีกฎ Read deny ตรง จึงต้องถาม
      ref: "packages/engine/src/tools/agent.ts#\"const outsideOf = async (ctx: ToolContext, name: ReachTool, given: string): Promise<Outside | undefined> => {\""

    - id: judge
      lane: policy
      at: rules
      do: >-
        `outsideReadDenial` ใช้กฎ `path-outside-workspace` เดียวกับ `cat` ของ path นั้น ในโหมด Ask คือถาม
        และเสนอโฟลเดอร์ `/Users/me/shared-lib/src` ให้อนุญาตตลอด session เพราะ path ไม่ใช่ไฟล์ลับ
      ref: packages/core/src/approval.ts#outsideReadDenial
      emits: [path-outside-workspace]

    - id: settle
      lane: policy
      at: settle
      do: >-
        `settle` ไม่มี hook ตอบแทน จึงส่งคำถามต่อให้ผู้ใช้ผ่าน `approval.approve`
      ref: packages/engine/src/tools/agent.ts#settle

    - id: ask
      lane: server
      at: approvals
      do: >-
        `editorTurn.approve` ส่งคำขอ ACP `session/request_permission` ด้วยตัวเลือกของโฟลเดอร์ ซึ่งมี
        "Allow this directory for the session" แทน "Always allow in this workspace"
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
      do: >-
        การ์ดใช้หน้าตาของการอ่านนอก workspace
      sees: >-
        "Read outside the workspace?" "Geno asks about a path outside the workspace."
        [Allow] [Allow this directory for the session] [Deny] [No, and tell the agent…]
      ref: "packages/extension/src/chat/render.ts#\"read: reachFace('Geno asks to read outside the workspace', 'folder-opened'),\""

    - id: choice
      lane: user
      do: ผู้ใช้เลือกปุ่มบนการ์ด
      fork:
        ask: ผู้ใช้กดปุ่มไหน
        options:
          - id: allow
            label: Allow
            then: read
            steps:
              - lane: editor
                at: chat
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
                  `settle` คืนบันทึก `decidedBy: user, verdict: allow` สำหรับไฟล์นี้ครั้งเดียว
                ref: packages/engine/src/tools/agent.ts#settle
                phase: running-tools
          - id: allow-session
            label: Allow this directory for the session
            then: read
            steps:
              - lane: editor
                at: chat
                do: >-
                  `askPermission` ตอบ engine ว่า `selected` ตัวเลือก `allow-session`
                ref: packages/extension/src/chat/chat.ts#Chat.askPermission
                emits: [permission-done, allow-session]
              - lane: server
                at: approvals
                do: >-
                  `permissionAnswerOf` แปลงคำตอบเป็น `allow-session`
                ref: packages/engine/src/serve.ts#permissionAnswerOf
              - lane: policy
                at: settle
                do: >-
                  `settle` เรียก `keep` ซึ่งเพิ่ม `/Users/me/shared-lib/src` เข้าโฟลเดอร์ที่ session นี้อ่านได้
                  การอ่านครั้งต่อไปใต้โฟลเดอร์นี้ไม่ถามอีก แต่ไฟล์ลับในนั้นยังถามแยก
                ref: "packages/engine/src/tools/agent.ts#\"if (answer === 'allow-session' && denial.directory !== undefined) tools.directories.allow(denial.directory);\""
                phase: running-tools
          - id: reject
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
                  `settle` คืนบันทึก `verdict: deny` และ `outsideRefusal` โยน `ToolRejected` ไฟล์ไม่ถูกอ่าน turn จบรอผู้ใช้
                ref: packages/engine/src/tools/agent.ts#outsideRefusal
                emits: [ToolRejected]
                phase: running-tools
                goto: perm.ask-deny-ends-turn

    - id: read
      lane: tool
      at: executor
      runs: 1
      do: >-
        `read` อ่านไฟล์โดยให้ราก filesystem เป็นโฟลเดอร์ที่อ่านได้สำหรับ call นี้ และยังตรวจกฎไฟล์ลับกับ path เต็ม
        ผลมีบันทึกว่าผู้ใช้อนุญาต (`approval`) อัปเดตผลของ call นี้จึงมี `APPROVAL_META`
      ref: "packages/engine/src/tools/agent.ts#\"const approval = await askOutside(name, outside, reach);\""

    - use: tool-result-returns

    - id: next
      lane: loop
      at: step
      do: >-
        `loopStep` เห็น `tool-result` ล่าสุดจึงตัดสิน `call-model`
      ref: packages/core/src/loop.ts#loopStep
      emits: [call-model]
      phase: calling-model
      end: { turn: continues, reason: call-model }
---

Geno อ่านได้โดยไม่ถามเฉพาะใน workspace ในโฟลเดอร์ที่ตั้งใน `permissions.additionalDirectories` (หรือการตั้งค่า
`gcode.additionalDirectories`) และในโฟลเดอร์ที่ผู้ใช้อนุญาตไว้ใน session นี้ ที่อื่นต้องผ่านคำถามเดียวกับ `cat` ของ path นั้น

| โหมด | อ่านนอก workspace |
| --- | --- |
| Ask | ถามผู้ใช้ |
| Auto | classifier ตัดสิน |
| Plan | ปฏิเสธ |
| ไม่มีคนดู | ปฏิเสธ |

สิ่งที่ควรสังเกต

- **การปฏิเสธบอกทางออก** เมื่อกฎหรือ classifier ปฏิเสธ ข้อความผลบอกรายชื่อโฟลเดอร์ที่อ่านได้
  และวิธีเพิ่มโฟลเดอร์ใน `permissions.additionalDirectories` เมื่อผู้ใช้กด Deny เอง ข้อความไม่บอก เพราะผู้ใช้สั่งให้หยุด
- **ไฟล์ลับไม่ได้ปุ่มโฟลเดอร์** ถ้า path เป็นไฟล์ลับหรืออยู่ในที่เก็บรหัสของ home เช่น `~/.aws` การ์ดไม่เสนอให้อนุญาตทั้งโฟลเดอร์
- **กฎ Read deny มาก่อนคำถาม** ถ้ามีกฎ Read deny ตรง path ไม่มีการ์ด `read` ปฏิเสธตามกฎทันที
