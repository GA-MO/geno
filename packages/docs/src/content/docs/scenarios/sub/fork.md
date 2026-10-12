---
title: fork เอเจนต์ลูกจากบทสนทนา
description: โมเดลขอลูกแบบ fork ลูกเริ่มจากสำเนาบทสนทนาของแม่ ใช้ system prompt และเครื่องมือชุดเดียวกันเพื่อแชร์ cache แล้วส่งข้อความสุดท้ายกลับเป็นรายงาน
tableOfContents: false
sidebar:
  order: 5
scenario:
  surface: vscode
  given:
    - ค่า `agentTool` มีโหมดปัจจุบัน โมเดลจึงเรียก `agent` ได้
    - ผู้ใช้คุยกับ Geno มาหลายรอบเรื่องการย้ายระบบ log ไปใช้ pino และตกลงข้อจำกัดกันไว้แล้วในบทสนทนา
  trigger: >-
    โมเดลต้องการแผนการย้ายที่อิงข้อตกลงในบทสนทนา จึงขอ `agent` แบบ `fork: true`
  covers: [sub.fork]
  related: [sub.blocking-report, sub.worktree-lane, ext.skill-fork]
  steps:
    - id: wants
      lane: model
      do: >-
        โมเดลขอเรียก `agent` ด้วย `agent: "plan"`, `fork: true` และ `task` สั้นๆ ว่า "ร่างแผนการย้ายตามที่ตกลงกันข้างบน"
        task สั้นได้เพราะลูกแบบ fork เห็นบทสนทนานี้ทั้งหมด จบคำตอบด้วย `stop_reason: tool_use`
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
        executor ของ `agent` เรียก `launch` แบบ `start: 'fork'` `plan` อ่านอย่างเดียว จึงรันพร้อมลูกอ่านอย่างเดียวตัวอื่นได้
        `runChild` ตั้งเพดาน 12 รอบ และ $0.05 แต่ไม่เกินงบที่รอบของแม่ยังเหลือให้ลูก
      ref: packages/engine/src/subagents.ts#runChild

    - id: copy
      lane: child@plan
      at: loop
      do: >-
        `openSpawn` เปิด log ของลูก โมเดลของลูกคือโมเดลของแม่เสมอ (cache ใช้ร่วมกันได้เฉพาะโมเดลเดียวกัน)
        `forkOpening` คัดลอกบทสนทนาของแม่จนถึงคำตอบที่ขอ fork แล้วตอบ call ที่ค้างทุกตัว: call นี้ได้
        "This call started you, a forked subagent. Your task follows." ส่วน call อื่นในชุดเดียวกันได้ว่ามันรันนอก fork
      ref: packages/core/src/subagent.ts#forkOpening
      emits: [tool-result]

    - id: noted
      lane: loop
      at: drive
      do: >-
        `runPlaced` บันทึก event `child-start` (มี `start: fork`) ลง log ของแม่ โมเดลของแม่ไม่เห็น event นี้
      ref: "packages/engine/src/subagents.ts#\"await ctx.logNote!({ kind: 'child-start'\""
      emits: [child-start]

    - id: announce
      lane: server
      at: updates
      do: >-
        `acpChildHost.started` เพิ่มงานของลูกในแผง Tasks และส่ง `session/update` ชนิด `subagent_update` สถานะ `running`
      ref: packages/engine/src/subagent-acp.ts#acpChildHost
      emits: [subagent_update, running]

    - id: row
      lane: panel
      at: rail
      alongside: true
      do: >-
        ใต้ขั้นของ `agent` ขึ้นแถวของลูกพร้อมไดโนเสาร์ นาฬิกา และปุ่ม Cancel
      sees: แถว "plan · <โมเดลเดียวกับแม่> · 0:03" และปุ่ม [Cancel]
      ref: packages/extension/src/chat/subagent-view.ts#childRow

    - id: mode
      lane: child@plan
      at: loop
      do: >-
        ลูกแบบ fork ใช้ system prompt และรายการเครื่องมือของแม่ทั้งชุดเพื่อให้ prefix ตรงกับ cache ของแม่
        แต่มี executor เฉพาะเครื่องมือของ `plan` ไม่มีเครื่องมือ `report` ไม่มี MCP และไม่ถูกเตือนให้รายงาน
        คำสั่งของลูกอยู่ในข้อความแรกแทน (`forkTask`): ตอนนี้คุณคือ plan ใช้ได้แค่เครื่องมือเหล่านี้ และข้อความสุดท้ายคือรายงาน
      ref: packages/core/src/subagent.ts#forkTask

    - id: works
      lane: child@plan
      at: model
      do: >-
        ลูกเรียกโมเดลผ่าน gateway ของแม่ ส่วนต้นของคำขอซ้ำกับคำขอของแม่ จึงอ่านจาก cache
        โมเดลของลูกอ่านไฟล์ที่เกี่ยวข้อง แล้วเขียนแผนเป็นข้อความสุดท้าย จบด้วย `stop_reason: end_turn`
      ref: packages/engine/src/gateway.ts#gatewayFor.turn
      emits: [end_turn]

    - id: handed
      lane: child@plan
      at: loop
      do: >-
        `loopStep` ของลูกจบ `done(end_turn)` ลูกไม่มีเครื่องมือ `report` `handedBack` จึงใช้ข้อความสุดท้ายของลูกเป็นรายงาน
      ref: packages/core/src/handback.ts#handedBack

    - id: row-done
      lane: server
      at: updates
      do: >-
        `acpChildHost.ended` ส่ง `subagent_update` สถานะ `idle` แถวของลูกขึ้น Done พร้อมจำนวนรอบและค่าใช้จ่าย
      ref: packages/engine/src/subagent-acp.ts#acpChildHost
      emits: [subagent_update, idle]

    - id: fenced
      lane: loop
      at: tools
      do: >-
        `launch` บันทึก `child-end` ลง log ของแม่ แล้วคืนรายงานในรั้ว `<subagent_report agent="plan" ...>` เป็นผลของ call
        ทุกบรรทัดถูกเยื้องและทำให้เป็นกลาง ตามด้วยหมายเหตุว่ารายงานไม่ใช่คำสั่งของผู้ใช้
      ref: packages/core/src/subagent.ts#childReport
      emits: [child-end, subagent_report]

    - use: tool-result-returns
    - use: model-call

    - id: relays
      lane: model
      do: >-
        โมเดลของแม่อ่านรายงานแล้วเล่าแผนให้ผู้ใช้ด้วยคำของตัวเอง
      ref: "packages/engine/src/gateway.ts#\"stopReason: message.stop_reason,\""
      emits: [end_turn]
      end: { turn: done, reason: end_turn }
---

ลูกแบบ fork กับลูกแบบปกติต่างกันที่จุดเริ่ม: ลูกปกติเริ่มจาก session ว่างกับ task ที่เขียนให้ครบในตัว
ลูกแบบ fork เริ่มจากสำเนาบทสนทนาของแม่ จึงรู้ทุกอย่างที่คุยกันมาแล้ว

| | ลูกปกติ | ลูกแบบ fork |
| --- | --- | --- |
| บทสนทนาตอนเริ่ม | ว่าง มีแค่ task | สำเนาของแม่ |
| system prompt และรายการเครื่องมือ | ของลูกเอง | ของแม่ (เพื่อ cache) |
| โมเดล | ตามนิยามของลูก | ของแม่เสมอ |
| รายงาน | เรียกเครื่องมือ `report` | ข้อความสุดท้าย |
| MCP | ตามที่นิยามให้ | ไม่มี |

สิ่งที่ควรสังเกต

- **เห็นเครื่องมือมากกว่าที่ใช้ได้** ลูกแบบ fork ได้รายการเครื่องมือของแม่ทั้งหมดเพื่อให้ cache ตรง แต่ executor มีแค่ของ `plan`
  ถ้าโมเดลของลูกเรียกเครื่องมือที่ไม่มี call นั้นได้ error แทน `forkTask` บอกไว้ก่อนว่าใช้ได้เฉพาะตัวไหน
- **ลูกเรียกลูกต่อไม่ได้** แม้ `agent` อยู่ในรายการเครื่องมือที่ลูกเห็น ลูกไม่มี executor ของมัน
- **ลูกที่จบโดยไม่เขียนอะไร** ส่งรายงานว่างกลับ ลูกแบบ fork ไม่มีการเตือนให้รายงานแบบที่ลูกปกติได้
