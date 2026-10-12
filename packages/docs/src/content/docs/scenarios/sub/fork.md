---
title: "fork subagent จากบทสนทนา"
description: model ขอลูกแบบ fork ลูกเริ่มจากสำเนาบทสนทนาของแม่ ใช้ system prompt และ tool ชุดเดียวกันเพื่อแชร์ cache แล้วส่งข้อความสุดท้ายกลับเป็นรายงาน
scenario:
  surface: vscode
  given:
    - ค่า `agentTool` มีโหมดปัจจุบัน model จึงเรียก `agent` ได้
    - ผู้ใช้ขอแผนการทำให้ `parseVersion` โยน error เมื่อได้สตริงว่างโดยไม่ทำให้ที่เรียกใช้พัง และ model อ่าน `src/version.ts` ในบทสนทนานี้ไปแล้ว
  trigger: >-
    model ต้องการแผนที่อิงสิ่งที่อ่านไปแล้วในบทสนทนา จึงขอ `agent` แบบ `fork: true`
  covers: [sub.fork]
  related: [sub.blocking-report, sub.worktree-lane, ext.skill-fork]
  steps:
    - id: wants
      beat:
        title: Model ขอ fork subagent ชื่อ plan
        text: >-
          schema ของ tool `agent` มี `fork` ที่บอกว่า "Start from a copy of this conversation" (แท็บแรก)
          model ส่ง `tool_use` ที่มี `agent: "plan"`, `fork: true` และ `task` สั้นๆ ที่อ้าง "the change we just discussed" (แท็บสอง)
          task สั้นได้เพราะลูกแบบ fork เห็นบทสนทนานี้ทั้งหมด
        from: model
        to: engine
        sees:
          - kind: payload
            source: packages/docs/src/data/recorded/fork.jsonl#line=2
            select: tools[9]
            highlight: [input_schema.properties.fork]
          - kind: payload
            source: packages/docs/src/data/recorded/fork.jsonl#line=10
            select: messages[3].content
            highlight: ['[1].input']
      lane: model
      do: >-
        model ขอเรียก `agent` ด้วย `agent: "plan"`, `fork: true` และ `task` สั้นๆ ว่า "Plan the change we just discussed"
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
      beat:
        title: Geno เปิด plan พร้อมงบของมัน
        text: plan อ่านอย่างเดียว จึงรันพร้อมลูกอ่านอย่างเดียวตัวอื่นได้ งบของมันไม่เกิน 12 รอบและ $0.05 และไม่เกินงบที่รอบของแม่ยังเหลือ
        from: engine
        to: engine
      lane: loop
      at: tools
      runs: 1
      do: >-
        executor ของ `agent` เรียก `launch` แบบ `start: 'fork'` `plan` อ่านอย่างเดียว จึงรันพร้อมลูกอ่านอย่างเดียวตัวอื่นได้
        `runChild` ตั้งเพดาน 12 รอบ และ $0.05 แต่ไม่เกินงบที่รอบของแม่ยังเหลือให้ลูก
      ref: packages/engine/src/subagents.ts#runChild

    - id: copy
      beat:
        title: plan ได้สำเนาบทสนทนาของแม่
        text: >-
          request แรกของ plan มีทุกข้อความของแม่: prompt ของคุณ การอ่าน `src/version.ts` และ call ที่ขอ fork
          call นั้นได้ผลว่า "This call started you, a forked subagent" แล้วต่อด้วยคำสั่งของ plan
          Geno ใช้ model เดียวกับแม่เสมอ เพื่อให้ใช้ cache ร่วมกันได้
        from: engine
        to: model
        sees:
          kind: payload
          source: packages/docs/src/data/recorded/fork.jsonl#line=6
          select: messages
          highlight: ['[3]', '[4].content[0]']
      lane: child@plan
      at: loop
      do: >-
        `openSpawn` เปิด log ของลูก model ของลูกคือ model ของแม่เสมอ (cache ใช้ร่วมกันได้เฉพาะ model เดียวกัน)
        `forkOpening` คัดลอกบทสนทนาของแม่จนถึงคำตอบที่ขอ fork แล้วตอบ call ที่ค้างทุกตัว: call นี้ได้
        "This call started you, a forked subagent. Your task follows." ส่วน call อื่นในชุดเดียวกันได้ว่ามันรันนอก fork
      ref: packages/core/src/subagent.ts#forkOpening
      emits: [tool-result]

    - id: noted
      lane: loop
      at: drive
      do: >-
        `runPlaced` บันทึก event `child-start` (มี `start: fork`) ลง log ของแม่ model ของแม่ไม่เห็น event นี้
      ref: "packages/engine/src/subagents.ts#\"await ctx.logNote!({ kind: 'child-start'\""
      emits: [child-start]

    - id: announce
      beat:
        title: แชตขึ้นแถวของ plan
        text: ใต้ขั้นที่ส่งงานขึ้นแถวของ plan พร้อมนาฬิกาและปุ่ม Cancel แผง Tasks มีงานของมันเพิ่มขึ้น
        from: panel
        to: you
        sees:
          kind: task
          title: plan
          status: running
          detail: 0:03
          actions:
            - Cancel
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
      sees: แถว "plan · <model เดียวกับแม่> · 0:03" และปุ่ม [Cancel]
      ref: packages/extension/src/chat/subagent-view.ts#childRow

    - id: mode
      beat:
        title: plan ใช้ system prompt และ tool ชุดเดียวกับแม่
        text: >-
          role ของ plan ไม่ได้อยู่ใน system prompt แต่อยู่ในโน้ต `[Geno] You are now plan` ท้ายข้อความล่าสุด (แท็บแรก):
          ใช้ได้แค่ glob, grep, list, read ห้ามส่งงานต่อ และข้อความสุดท้ายคือรายงาน ตามด้วย role ของ plan จากนิยามในตัว Geno
          และ `Task:` รายการ tool ใน request ยังเป็นของแม่ทั้งชุด รวม `agent` (แท็บสอง) เพื่อให้ prefix ตรงกับ cache
          แต่ Geno รันได้เฉพาะ tool ของ plan มันไม่มี tool `report` และไม่ถูกเตือนให้รายงาน
        from: engine
        to: model
        sees:
          - kind: payload
            source: packages/docs/src/data/recorded/fork.jsonl#line=6
            select: messages[4]
            highlight: ['content[1].text']
          - kind: payload
            source: packages/docs/src/data/recorded/fork.jsonl#line=6
            select: tools[9]
            highlight: [name]
      lane: child@plan
      at: loop
      do: >-
        ลูกแบบ fork ใช้ system prompt และรายการ tool ของแม่ทั้งชุดเพื่อให้ prefix ตรงกับ cache ของแม่
        แต่มี executor เฉพาะ tool ของ `plan` ไม่มี tool `report` ไม่มี MCP และไม่ถูกเตือนให้รายงาน
        คำสั่งของลูกอยู่ในข้อความแรกแทน (`forkTask`): ตอนนี้คุณคือ plan ใช้ได้แค่ tool เหล่านี้ และข้อความสุดท้ายคือรายงาน
      ref: packages/core/src/subagent.ts#forkTask

    - id: works
      beat:
        title: plan อ่านไฟล์แล้วเขียนแผน
        text: คำขอของ plan อ่านส่วนต้นจาก cache มัน `grep` หาที่เรียก `parseVersion` แล้วเขียนแผนเป็นข้อความสุดท้าย
        from: model
        to: engine
        sees:
          kind: payload
          source: packages/docs/src/data/recorded/fork.jsonl#line=8
          select: messages[5].content
          highlight: ['[1].input']
      lane: child@plan
      at: model
      do: >-
        ลูกเรียก model ผ่าน gateway ของแม่ ส่วนต้นของคำขอซ้ำกับคำขอของแม่ จึงอ่านจาก cache
        model ของลูกอ่านไฟล์ที่เกี่ยวข้อง แล้วเขียนแผนเป็นข้อความสุดท้าย จบด้วย `stop_reason: end_turn`
      ref: packages/engine/src/gateway.ts#gatewayFor.turn
      emits: [end_turn]

    - id: handed
      beat:
        title: ข้อความสุดท้ายของ plan กลายเป็นรายงาน
        text: plan ไม่มี tool `report` Geno จึงใช้ข้อความสุดท้ายของมันเป็นรายงาน แถวของ plan ขึ้นเครื่องหมายถูก เวลาที่ใช้ และค่าใช้จ่าย
        from: engine
        to: engine
        sees:
          kind: task
          title: plan
          status: done
      lane: child@plan
      at: loop
      do: >-
        `loopStep` ของลูกจบ `done(end_turn)` ลูกไม่มี tool `report` `handedBack` จึงใช้ข้อความสุดท้ายของลูกเป็นรายงาน
      ref: packages/core/src/handback.ts#handedBack

    - id: row-done
      lane: server
      at: updates
      do: >-
        `acpChildHost.ended` ส่ง `subagent_update` สถานะ `idle` พร้อมจำนวนรอบและค่าใช้จ่าย แถวของลูกขึ้นเครื่องหมายถูก เวลาที่ใช้ และค่าใช้จ่าย
      ref: packages/engine/src/subagent-acp.ts#acpChildHost
      emits: [subagent_update, idle]

    - id: fenced
      beat:
        title: Geno ล้อมรั้วรายงานแล้วส่งให้ model
        text: >-
          ใน request ถัดไปของแม่ ผลของ call `agent` ไม่ใช่ข้อความ "This call started you" อีกแล้ว แต่เป็นแผนของ plan
          ใน `<subagent_report agent="plan" ...>` ทุกบรรทัดเยื้องสองช่อง ตามด้วยคำเตือนว่ารายงานไม่ใช่คำสั่งของคุณ
          บทสนทนาของแม่ไม่มีการ grep ของ plan มีแค่ผลนี้
        from: engine
        to: model
        sees:
          kind: payload
          source: packages/docs/src/data/recorded/fork.jsonl#line=10
          select: messages[4].content[0]
          highlight: [content]
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
      beat:
        title: Model เล่าแผนให้คุณฟัง
        text: model ของแม่อ่านแผนแล้วเล่าให้คุณฟังด้วยคำของตัวเอง
        from: model
        to: panel
        end: Turn จบ
      lane: model
      do: >-
        model ของแม่อ่านรายงานแล้วเล่าแผนให้ผู้ใช้ด้วยคำของตัวเอง
      ref: "packages/engine/src/gateway.ts#\"stopReason: message.stop_reason,\""
      emits: [end_turn]
      end: { turn: done, reason: end_turn }
---

ลูกแบบ fork กับลูกแบบปกติต่างกันที่จุดเริ่ม: ลูกปกติเริ่มจาก session ว่างกับ task ที่เขียนให้ครบในตัว
ลูกแบบ fork เริ่มจากสำเนาบทสนทนาของแม่ จึงรู้ทุกอย่างที่คุยกันมาแล้ว

| | ลูกปกติ | ลูกแบบ fork |
| --- | --- | --- |
| บทสนทนาตอนเริ่ม | ว่าง มีแค่ task | สำเนาของแม่ |
| system prompt และรายการ tool | ของลูกเอง | ของแม่ (เพื่อ cache) |
| model | ตามนิยามของลูก | ของแม่เสมอ |
| รายงาน | เรียก tool `report` | ข้อความสุดท้าย |
| MCP | ตามที่นิยามให้ | ไม่มี |

สิ่งที่ควรสังเกต

- **เห็น tool มากกว่าที่ใช้ได้** ลูกแบบ fork ได้รายการ tool ของแม่ทั้งหมดเพื่อให้ cache ตรง แต่ executor มีแค่ของ `plan`
  ถ้า model ของลูกเรียก tool ที่ไม่มี call นั้นได้ error แทน `forkTask` บอกไว้ก่อนว่าใช้ได้เฉพาะตัวไหน
- **ลูกเรียกลูกต่อไม่ได้** แม้ `agent` อยู่ในรายการ tool ที่ลูกเห็น ลูกไม่มี executor ของมัน
- **ลูกที่จบโดยไม่เขียนอะไร** ส่งรายงานว่างกลับ ลูกแบบ fork ไม่มีการเตือนให้รายงานแบบที่ลูกปกติได้
