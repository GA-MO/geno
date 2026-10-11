---
title: โหมด Ask ขออนุญาตก่อนรันคำสั่ง
description: โมเดลขอรันคำสั่งที่ไม่อยู่ใน safe list Geno หยุดถามผู้ใช้ก่อน และผู้ใช้เลือกได้สี่ทาง
tableOfContents: false
sidebar:
  order: 1
scenario:
  surface: vscode
  given:
    - เปิด Geno ในโหมด Ask
    - มี turn ทำงานอยู่ และโมเดลกำลังจะขอเรียก `bash` ด้วยคำสั่ง `pnpm add zod`
    - คำสั่งนี้ไม่ตรงกับกฎของ workspace และไม่อยู่ใน safe list
  trigger: >-
    โมเดลจบคำตอบด้วย `stop_reason: tool_use` พร้อมบล็อก `tool_use` ของ `bash`
  covers: [perm.ask-allow, perm.ask-deny-ends-turn, perm.deny-with-comment, perm.always-allow-workspace]
  related: [turn.with-tools, tool.bash-safe-runs, perm.auto-classifier-allows, ctl.stop-at-card]
  steps:
    - id: wants
      lane: model
      do: >-
        โมเดลขอเรียก `bash` ด้วยคำสั่ง `pnpm add zod` และจบคำตอบด้วย `stop_reason: tool_use`
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

    - id: judge
      lane: policy
      at: rules
      do: >-
        ก่อนรันอะไร `approveCommand` ส่งคำสั่งให้ `ruledDenial` เทียบกับกฎของ workspace และตาราง safe list
        ผลคือ `unlisted` ซึ่งในโหมด Ask แปลว่าต้องถามผู้ใช้ และแนบรูปแบบ `pnpm add` ไว้ให้เลือกบันทึกเป็นกฎ
      ref: packages/core/src/permission-rules.ts#ruledDenial
      emits: [unlisted]

    - id: settle
      lane: policy
      at: settle
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
      do: >-
        แผงแชตแสดงการ์ดขออนุญาตพร้อมคำสั่ง เหตุผล และปุ่มให้เลือก หัวข้อเปลี่ยนเป็น "waiting for you"
      sees: >-
        Allow `pnpm add zod`? It uses a command not on the safe list.
        [Allow once] [Reject] [Always allow in this workspace] [No, and tell the agent…]
      ref: packages/extension/src/chat/render.ts#permissionCard

    - id: choice
      lane: user
      do: ผู้ใช้อ่านการ์ดแล้วเลือกปุ่มหนึ่งปุ่ม turn รออยู่ตรงนี้จนกว่าผู้ใช้จะตอบหรือกด Stop
      fork:
        ask: ผู้ใช้กดปุ่มไหน
        options:
          - id: allow
            label: Allow once
            then: run
            steps:
              - lane: editor
                at: chat
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
                  `settle` บันทึก `decidedBy: user, verdict: allow` และเลื่อนสถานะ Auto ด้วย `nextAutoState`
                  บันทึกนี้ติดไปกับผลของ call ให้แผงแชตแสดงได้ว่าใครอนุญาต
                ref: packages/engine/src/tools/agent.ts#settle
                phase: running-tools

          - id: allow-workspace
            label: Always allow in this workspace
            then: run
            steps:
              - lane: editor
                at: chat
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
                  `settle` เรียก `keep` ซึ่งบันทึกกฎ allow รูปแบบ `pnpm add` ลงที่เก็บของ workspace
                  ครั้งต่อไป `ruledDenial` จะผ่านคำสั่งแบบนี้โดยไม่ถาม ยกเว้นคำสั่งอันตรายอย่าง `rm -rf`
                ref: "packages/engine/src/tools/agent.ts#\"permissions?.add({ effect: 'allow', pattern\""
                phase: running-tools

          - id: reject
            label: Reject
            steps:
              - lane: editor
                at: chat
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
                  `settle` บันทึก `verdict: deny` โดยไม่มีความเห็น `approveCommand` จึงโยน `refusalOf`
                  ซึ่งเป็น `ToolRejected` คำสั่งไม่ได้รัน
                ref: packages/engine/src/tools/agent.ts#refusalOf
                emits: [ToolRejected]
                phase: running-tools
              - lane: loop
                at: tools
                do: >-
                  ผลของ call นี้มีสถานะ `rejected` และบอกโมเดลให้หยุดรอผู้ใช้ ลูปของ batch หยุดทันที
                  call ที่เหลือใน turn เดียวกันจะไม่เริ่ม
                ref: "packages/engine/src/drive.ts#\"results.some((result) => result?.status === 'rejected')\""
                emits: [rejected]
              - lane: server
                at: updates
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
                do: >-
                  `loopStep` รอบถัดไปตอบ call ที่ยังไม่ได้รันด้วย `UNRUN_TEXTS.rejected` แล้วตัดสิน `done(end_turn)`
                  เพราะคำปฏิเสธจากผู้ใช้จบ turn ผู้ใช้คือคนที่พูดต่อ Stop hook ไม่ทำงานในทางนี้
                ref: packages/core/src/loop.ts#unrunnable
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
                  `turnEndOf` อ่านผลแล้วส่ง action `turn-end` สถานะ `done`
                ref: packages/extension/src/chat/chat.ts#turnEndOf
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
                do: ปุ่มบนการ์ดเปลี่ยนเป็นช่องให้พิมพ์ข้อความถึงเอเจนต์
                ref: packages/extension/src/chat/render.ts#commentField
              - lane: user
                do: ผู้ใช้พิมพ์ "ใช้ npm แทน" แล้วกด Send
              - lane: editor
                at: chat
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
                  `settle` บันทึก `verdict: deny` พร้อมความเห็น `refusalOf` จึงสร้าง `ToolDenied` ไม่ใช่ `ToolRejected`
                  call อื่นใน turn เดียวกันยังรันต่อได้
                ref: packages/engine/src/tools/agent.ts#refusalOf
                emits: [ToolDenied]
                phase: running-tools
              - lane: loop
                at: tools
                do: >-
                  `tool-result` สถานะ `denied` บอกโมเดลว่าคำสั่งไม่ได้รัน ตามด้วยข้อความของผู้ใช้
                  ("To tell you how to proceed, the user said: ใช้ npm แทน")
                ref: packages/engine/src/tools/agent.ts#denialText
                emits: [denied, tool-result]
              - lane: server
                at: updates
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
                do: >-
                  `loopStep` เห็น `tool-result` ล่าสุดและไม่มีการปฏิเสธเปล่าจากผู้ใช้ จึงตัดสิน `call-model`
                  โมเดลจะได้อ่านคำแนะนำของผู้ใช้ใน `tool_result` แล้วทำต่อ
                ref: packages/core/src/loop.ts#loopStep
                emits: [call-model]
                phase: calling-model
                end: { turn: continues, reason: call-model }

    - id: run
      lane: tool
      at: shell
      do: >-
        `bash` รัน `pnpm add zod` ใน sandbox ใน process group ของตัวเอง การอนุญาตไม่ได้ยกเว้น sandbox
        ผลลัพธ์แนบบันทึกว่าใครอนุญาตไว้ด้วย
      ref: "packages/engine/src/tools/agent.ts#\"tools.sandbox.run(command\""

    - use: tool-result-returns

    - id: next
      lane: loop
      at: step
      do: >-
        `loopStep` เห็น `tool-result` ล่าสุดจึงตัดสิน `call-model` โมเดลจะได้อ่านผลของคำสั่งในคำขอถัดไป
      ref: packages/core/src/loop.ts#loopStep
      emits: [call-model]
      phase: calling-model
      end: { turn: continues, reason: call-model }
---

การ์ดนี้คือจุดเดียวในโหมด Ask ที่ Geno หยุดรอคนระหว่างที่ turn ยังไม่จบ
ทางแยกทั้งสี่ต่างกันที่ผลต่อ turn

| ปุ่ม | ผลต่อคำสั่ง | ผลต่อ turn |
| --- | --- | --- |
| **Allow once** | รัน | ทำต่อ โมเดลได้อ่านผล |
| **Always allow in this workspace** | รัน และบันทึกกฎ `pnpm add` | ทำต่อ ครั้งหน้าไม่ถามอีก |
| **Reject** | ไม่รัน (`ToolRejected`) | จบทันทีแบบ `done (end_turn)` และรอผู้ใช้ |
| **No, and tell the agent…** | ไม่รัน (`ToolDenied`) | ทำต่อ โมเดลได้อ่านคำแนะนำของผู้ใช้ |

ความต่างระหว่าง Reject กับ "No, and tell the agent…" อยู่ที่ชนิดของ error:
`ToolRejected` ทำให้ batch หยุดและ turn จบ ส่วน `ToolDenied` เป็นผลธรรมดาที่โมเดลอ่านแล้วหาทางอื่นต่อ
