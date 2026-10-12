---
title: สร้างเอเจนต์ลูกแล้วรอรายงาน
description: โมเดลส่งงานให้ worker ลูกทำงานใน session ของตัวเอง ขออนุญาตผ่านการ์ดเดียวกับแม่ แล้วส่งรายงานที่ถูกล้อมรั้วกลับมาเป็นผลของ call
tableOfContents: false
sidebar:
  order: 1
scenario:
  surface: vscode
  given:
    - ค่า `agentTool` ในไฟล์ตั้งค่าของ Geno มี `ask` โมเดลในโหมด Ask จึงมีเครื่องมือ `agent`
    - เปิด Geno ในโหมด Ask มี turn ทำงานอยู่ และรอบนี้ยังไม่ได้ใช้งบไปกับลูกตัวอื่น
  trigger: >-
    ผู้ใช้ขอให้เพิ่มเทสต์ให้ parser โมเดลตัดสินใจส่งงานนี้ให้ subagent `worker`
  covers: [sub.blocking-report, sub.asks-permission]
  related: [sub.at-mention, sub.user-cancels-child, sub.parent-stop-with-children, bg.child-wakes-parent, perm.ask-allow]
  steps:
    - id: wants
      lane: model
      do: >-
        โมเดลขอเรียก `agent` ด้วย `agent: "worker"` และ `task` ที่เขียนให้ครบในตัว เพราะลูกไม่เห็นบทสนทนานี้
        จบคำตอบด้วย `stop_reason: tool_use`
      ref: packages/core/src/subagent.ts#agentToolDefinition
      emits: [tool_use]
      phase: calling-model

    - id: decide
      lane: loop
      at: step
      do: >-
        `drive` บันทึก event `assistant` แล้ว `loopStep` ตัดสินว่า `run-tools`
      ref: packages/core/src/loop.ts#loopStep
      emits: [run-tools]
      phase: running-tools

    - id: launch
      lane: loop
      at: tools
      runs: 1
      do: >-
        executor ของ `agent` เรียก `launch` `worker` แก้ไฟล์ได้ จึงรันทีละตัวบน checkout หลัก (ลูกแบบอ่านอย่างเดียวรันพร้อมกันได้ 4 ตัว)
        `runChild` ตั้งเพดานของลูก: 30 รอบ และ $0.20 แต่ไม่เกินงบที่รอบของแม่ยังเหลือให้ลูกทั้งหมด (งบ $0.40 ของแม่คืองบรวมของลูกด้วย)
      ref: packages/engine/src/subagents.ts#runChild

    - id: spawn
      lane: child@worker
      at: loop
      do: >-
        `openSpawn` เปิด log ของลูกเป็น session ใหม่: `session-start` ที่มีโมเดล คำสั่งโปรเจกต์ หน่วยความจำ สภาพแวดล้อม
        และข้อมูลว่าใครเป็นแม่ SubagentStart hook (ถ้ามี) ได้ใส่บริบทเพิ่ม
      ref: packages/engine/src/subagents.ts#openSpawn

    - id: noted
      lane: loop
      at: drive
      do: >-
        `runPlaced` บันทึก event `child-start` ลง log ของแม่ event นี้ไม่ใช่ส่วนของบทสนทนา โมเดลของแม่ไม่เห็น
      ref: "packages/engine/src/subagents.ts#\"await ctx.logNote!({ kind: 'child-start'\""
      emits: [child-start]

    - id: announce
      lane: server
      at: updates
      do: >-
        `acpChildHost.started` ลงทะเบียนตัวยกเลิกของลูก เพิ่มงานของลูกในแผง Tasks
        แล้วส่ง `session/update` ชนิด `subagent_update` สถานะ `running` บน session ของแม่
        อัปเดตของลูกเองส่งแยกภายใต้ session id ของลูก
      ref: packages/engine/src/subagent-acp.ts#acpChildHost
      emits: [subagent_update, running]

    - id: row-start
      lane: editor
      at: chat
      alongside: true
      do: >-
        `subagentAction` แปลงอัปเดตเป็น action `child-start` ผูกกับ call `agent` ด้วย `toolUseId`
      ref: packages/extension/src/chat/subagent-host.ts#subagentAction
      emits: [child-start]

    - id: row
      lane: panel
      at: rail
      alongside: true
      do: >-
        ใต้ขั้นของ `agent` ขึ้นแถวของลูก: ไดโนเสาร์ผู้ช่วย ชื่อ โมเดล นาฬิกา และปุ่ม Cancel คลิกแถวเพื่อเปิดบทสนทนาของลูก
      sees: แถว "worker · <โมเดล> · 0:04" พร้อมไดโนเสาร์ที่ขยับ และปุ่ม [Cancel]
      ref: packages/extension/src/chat/subagent-view.ts#childRow

    - id: child-model
      lane: child@worker
      at: model
      do: >-
        ลูกเรียกโมเดลผ่าน gateway ของแม่ system prompt ของลูกคือ `childSystemPrompt`: กรอบงาน คำสั่งให้จบด้วย `report`
        และเนื้อหาของนิยาม `worker` โมเดลของลูกอ่านไฟล์ แล้วขอรัน `bash` ด้วย `pnpm add -D vitest`
      ref: packages/core/src/subagent.ts#childSystemPrompt
      emits: [tool_use]

    - id: child-judge
      lane: policy
      at: rules
      do: >-
        ลูกใช้นโยบายและโหมดเดียวกับแม่ `ruledDenial` ได้ `unlisted` ซึ่งในโหมด Ask ต้องถาม
        ตัวขออนุญาตของลูก (`asker`) แนบชื่อและ session ของลูกไปกับคำถาม
      ref: packages/core/src/permission-rules.ts#ruledDenial
      emits: [unlisted]

    - id: child-ask
      lane: server
      at: approvals
      do: >-
        `editorTurn.approve` ส่งคำขอ ACP `session/request_permission` หัวข้อขึ้นต้นด้วยชื่อลูก งานของลูกเป็น `needs-input`
        และรวมขึ้นไปที่แถวของแม่ในแผง Tasks
      ref: packages/engine/src/serve.ts#editorTurn.approve
      emits: [requestPermission, needs-input]
      phase: waiting-user

    - id: child-forward
      lane: editor
      at: chat
      do: >-
        `askPermission` ส่ง action `permission` ให้ webview และโฟกัสแผงแชต
      ref: packages/extension/src/chat/chat.ts#Chat.askPermission
      emits: [permission]

    - id: child-card
      lane: panel
      at: card
      do: >-
        การ์ดขออนุญาตขึ้นในบทสนทนาของแม่ หัวข้อของคำขอ ACP ขึ้นต้นด้วย `[worker]` แต่การ์ดใช้หัวข้อของตัวเอง
        จึงไม่บอกว่าลูกตัวไหนเป็นคนขอ
      sees: >-
        "Run this command?" คำสั่ง `pnpm add -D vitest` และ "Geno asks because it uses ..."
        [Allow] [Deny] [Always allow in this workspace] [No, and tell the agent…]
      ref: packages/extension/src/chat/render.ts#permissionCard

    - id: answer
      lane: user
      do: ผู้ใช้อ่านการ์ดแล้วตอบ ทั้งแม่และลูกรออยู่ตรงนี้
      fork:
        ask: ผู้ใช้ตอบอะไร
        options:
          - id: allow
            label: Allow
            then: report
            steps:
              - lane: editor
                at: chat
                do: >-
                  `askPermission` ตอบ engine ว่า `selected` ตัวเลือก `allow`
                ref: packages/extension/src/chat/chat.ts#Chat.askPermission
                emits: [permission-done]
              - lane: policy
                at: settle
                do: >-
                  `settle` คืนบันทึก `decidedBy: user, verdict: allow` บนผลของ call ในลูก
                ref: packages/engine/src/tools/agent.ts#settle
                phase: running-tools
              - lane: tool
                at: shell
                do: >-
                  `bash` ของลูกรัน `pnpm add -D vitest` ใน sandbox แล้วลูกทำงานต่อ: เขียนเทสต์และรันเทสต์
                ref: "packages/engine/src/tools/agent.ts#\"tools.sandbox.run(command\""

          - id: reject
            label: Deny
            steps:
              - lane: editor
                at: chat
                do: >-
                  `askPermission` ตอบ engine ว่า `selected` ตัวเลือก `reject`
                ref: packages/extension/src/chat/chat.ts#Chat.askPermission
                emits: [permission-done]
              - lane: policy
                at: settle
                do: >-
                  `settle` คืนบันทึก `verdict: deny` โดยไม่มีความเห็น จึงเป็น `ToolRejected` คำสั่งไม่ได้รัน
                ref: packages/engine/src/tools/agent.ts#refusalOf
                emits: [ToolRejected]
                phase: running-tools
              - lane: child@worker
                at: loop
                do: >-
                  ผลของ call ในลูกมีสถานะ `rejected` `loopStep` ของลูกจบ `done(end_turn)` ทันทีเพราะผู้ใช้เป็นคนพูดต่อ
                  ลูกจบแบบ `done` โดยไม่มีรายงาน
                ref: packages/core/src/loop.ts#loopStep
                emits: [rejected]
              - lane: loop
                at: tools
                do: >-
                  `launch` บันทึก `child-end` ลง log ของแม่ เห็นว่าลูกมี call ที่ผู้ใช้ปฏิเสธ จึงโยน `ToolRejected` ให้ call `agent` ของแม่ด้วย
                  ข้อความบอกว่า worker หยุดเพราะผู้ใช้ปฏิเสธ และให้หยุดรอผู้ใช้
                ref: "packages/engine/src/subagents.ts#\"if (rejected) throw new ToolRejected(\""
                emits: [ToolRejected, child-end]
              - lane: loop
                at: step
                do: >-
                  call `agent` ของแม่มีผล `rejected` `loopStep` ของแม่จึงตัดสิน `done(end_turn)` โดยไม่เรียกโมเดล
                  เหมือนผู้ใช้ปฏิเสธ call ของแม่เอง
                ref: packages/core/src/loop.ts#loopStep
                emits: [end_turn]
                phase: ending
              - lane: server
                at: turns
                do: >-
                  `runTurn` ตอบ `stopReason: end_turn` งานจบแบบ `done`
                ref: packages/engine/src/serve.ts#TURN_ENDS
                emits: [TURN_END_META]
              - lane: panel
                at: rail
                do: >-
                  แถวของลูกขึ้นเครื่องหมายถูกของ `done` ขั้นของ `agent` เป็นล้มเหลว (ไม่มีป้าย "Denied by you" เพราะผลของแม่ไม่มีบันทึกการอนุญาต)
                  `missingReply` จึงบอกว่าคำตอบไม่มีข้อความ แทนที่จะบอกว่าหยุดที่ call ที่ถูกปฏิเสธ
                sees: >-
                  แถว "✓ worker · <โมเดล> · <เวลา>" (คำว่า Done อยู่แค่ใน tooltip ของแถว) และประกาศ "Geno stopped without a reply · Its last reply had no text." [Continue] [Retry]
                ref: packages/extension/src/chat/rail.ts#missingReply
                end: { turn: done, reason: end_turn }

    - id: report
      lane: child@worker
      at: model
      do: >-
        เมื่อเทสต์ผ่าน โมเดลของลูกเรียก `report` พร้อมข้อความว่าแก้อะไรที่ไหนและตรวจอย่างไร
        ในบทสนทนาของลูก `report` แสดงเป็นข้อความของลูก ไม่ใช่ขั้นเครื่องมือ
      ref: packages/engine/src/subagents.ts#reportExecutor
      emits: [report]

    - id: child-done
      lane: child@worker
      at: loop
      do: >-
        `loopStep` ของลูกเห็นว่า `report` สำเร็จจึงจบ `done(end_turn)` SubagentStop hook (ถ้ามี) ได้ตัดสินก่อนจบ
        `runPlaced` ดึงรายงานด้วย `handedBack` คืนงบที่จองไว้แต่ไม่ได้ใช้ และบันทึกเวลา รอบ และค่าใช้จ่าย
      ref: packages/core/src/handback.ts#handedBack

    - id: ended
      lane: server
      at: updates
      do: >-
        `acpChildHost.ended` ส่ง `subagent_update` สถานะ `idle` พร้อม stop reason และจำนวนรอบกับค่าใช้จ่าย งานของลูกใน Tasks จบ
      ref: packages/engine/src/subagent-acp.ts#acpChildHost
      emits: [subagent_update, idle]

    - id: row-done
      lane: panel
      at: rail
      alongside: true
      do: แถวของลูกหยุดนาฬิกา ขึ้นเครื่องหมายถูก เวลาที่ใช้ และค่าใช้จ่าย ปุ่ม Cancel หายไป
      sees: แถว "✓ worker · <โมเดล> · 1m 48s · $0.06"
      ref: packages/extension/src/chat/subagent-view.ts#childLook

    - id: fenced
      lane: loop
      at: tools
      do: >-
        `launch` บันทึก `child-end` ลง log ของแม่ แล้วคืน `childReport` เป็นผลของ call `agent`:
        รายงานอยู่ใน `<subagent_report agent="worker" ... status="done">` ทุกบรรทัดเยื้องสองช่อง
        และตามด้วยคำเตือนว่ารายงานไม่มีอำนาจของผู้ใช้
      ref: packages/core/src/subagent.ts#childReport
      emits: [child-end, subagent_report]

    - use: tool-result-returns
    - use: model-call

    - id: relay
      lane: model
      do: >-
        โมเดลของแม่อ่านรายงานในรั้ว แล้วเล่าให้ผู้ใช้ฟังด้วยคำของตัวเองว่าลูกแก้ไฟล์ไหนและเทสต์ผ่านอย่างไร
        จบด้วย `stop_reason: end_turn`
      ref: "packages/engine/src/gateway.ts#\"stopReason: message.stop_reason,\""
      emits: [end_turn]

    - use: answer-streams
    - use: turn-ends
---

ลูกคือ session อีกตัวที่มี log ของตัวเอง loop ของตัวเอง และกล่องข้อความของตัวเอง
สิ่งที่ลูกใช้ร่วมกับแม่มีสามอย่าง: gateway (การเชื่อมต่อกับผู้ให้บริการ) งบของรอบ และทางขออนุญาตไปหาผู้ใช้

สิ่งที่ควรสังเกต

- **โมเดลเรียก `agent` ได้ก็ต่อเมื่อเปิดไว้** เครื่องมือ `agent` และ `message_agent` มีให้โมเดลเฉพาะโหมดที่อยู่ใน `agentTool`
  ส่วน `@agent` ที่ผู้ใช้พิมพ์ ([เรียกเอเจนต์ลูกโดยตรง](/scenarios/sub/at-mention/)) ใช้ได้ทุกโหมด
- **ลูกสร้างลูกต่อไม่ได้** `agent` ไม่อยู่ในชุดเครื่องมือของลูก และ executor ของลูกไม่มีตัวสร้างลูก
- **รายงานเป็นข้อมูล** `childReport` ล้อมรั้ว เยื้องทุกบรรทัด และทำให้บรรทัดที่หน้าตาเหมือนโน้ตของ Geno ไม่มีผล
  ข้อความที่ลูกไปเจอในไฟล์หรือเว็บจึงปลอมเป็น Geno หรือผู้ใช้ไม่ได้
- **การ์ดไม่บอกชื่อลูก** engine ใส่ `[worker]` ไว้หน้าหัวข้อของ `session/request_permission` แต่ `permissionCard` ใช้หัวข้อ "Run this command?"
  ของตัวเอง ผู้ใช้จึงไม่รู้จากการ์ดว่าแม่หรือลูกตัวไหนเป็นคนขอ
- **ปฏิเสธลูกคือปฏิเสธแม่** Deny บนการ์ดของลูกจบทั้ง turn ของแม่ ส่วน "No, and tell the agent…" ส่งความเห็นไปให้ลูก และลูกทำต่อได้
- **ประกาศหลัง Deny ไม่ตรงกับเหตุ** ผล `rejected` ของ call `agent` ไม่มีบันทึกการอนุญาตติดมา แผงแชตจึงไม่ขึ้นป้าย
  "Denied by you" และ `missingReply` แสดง "Its last reply had no text." แทน "It stopped at the call that was denied."
- **ลูกที่จบโดยไม่เรียก `report`** ได้ข้อความเตือนหนึ่งครั้ง และการเรียกครั้งสุดท้ายที่เพดานยอมให้ถูกบังคับให้เป็น `report`
