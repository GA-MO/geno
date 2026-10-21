---
title: "@mention เรียก subagent โดยตรง"
description: ผู้ใช้พิมพ์ @explore ตามด้วยคำถาม ข้อความกลายเป็น call agent ของผู้ใช้เอง ลูกตอบ แล้ว turn จบโดยไม่เรียก model ของแม่เลย
scenario:
  surface: vscode
  given:
    - เปิด Geno ในแผงแชตของ VS Code โหมดใดก็ได้ (`@` ใช้ได้แม้ `agentTool` ไม่ได้เปิดไว้)
    - session นี้ไม่มี turn ทำงานอยู่
  trigger: >-
    ผู้ใช้พิมพ์ "@explore parseConfig ถูกนิยามไว้ที่ไหน" แล้วกด Enter
  covers: [sub.at-mention]
  related: [sub.blocking-report, sub.user-cancels-child, ext.slash-template]
  steps:
    - use: prompt-starts-turn
      beat:
        title: คุณพิมพ์ `@explore` ตามด้วยคำถาม
        text: >-
          คุณพิมพ์ "@explore parseConfig ถูกนิยามไว้ที่ไหน" แล้วกด Enter subagent คือ session ลูกที่ทำงานย่อยงานหนึ่ง
          แล้วส่งรายงานสั้นกลับ explore เป็น subagent ในตัว Geno ที่ค้นโค้ดแบบอ่านอย่างเดียว
          `@` ใช้ได้ทุกโหมด แม้ model จะเรียก subagent เองไม่ได้
        from: you
        to: panel
        sees:
          kind: message
          from: you
          text: "@explore parseConfig ถูกนิยามไว้ที่ไหน"

    - id: issued
      beat:
        title: Geno สร้าง tool call `agent` ในนามคุณ
        text: >-
          Geno เห็นว่า prompt ขึ้นต้นด้วยชื่อ subagent จึงไม่ถาม model ของแม่ (แม่คือ session หลักที่คุณคุยอยู่)
          ปกติ model ของแม่เป็นคนเขียน `tool_use` เพื่อขอเรียก tool ครั้งนี้ Geno สร้าง `tool_use` ชื่อ `agent` เองในนามคุณ
          (`id` ขึ้นต้นด้วย `toolu_gcode_`) `input` คือ `agent: "explore"` และ `task` คือข้อความหลังชื่อ ไม่มี `background`
          และไม่มี `fork` ไม่มี request ไปหา model ของแม่ใน turn นี้เลย
        from: engine
        to: engine
      lane: loop
      at: step
      do: >-
        `runAgent` เห็นแล้วว่า prompt ขึ้นต้นด้วย `@explore` (`mentionedCall`) จึงสร้าง call `agent` ของผู้ใช้เอง
        พร้อม `task` คือข้อความหลังชื่อ และตั้ง director แบบ `issuedOnce` เมื่อ `loopStep` ตัดสิน `call-model`
        `drive` ไม่เรียก model แต่บันทึก call นั้นเป็น event `assistant` ที่มี `issuedBy: 'user'`
      ref: packages/engine/src/subagents.ts#mentionedCall
      emits: [assistant, issuedBy]

    - id: run
      lane: loop
      at: step
      do: >-
        `loopStep` เห็น `tool_use` ที่ยังไม่มีผล จึงตัดสิน `run-tools` เหมือน call ที่ model ขอ
      ref: packages/core/src/loop.ts#loopStep
      emits: [run-tools]
      phase: running-tools

    - use: sub-child-starts
      beat:
        title: Geno เปิด session ให้ explore
        text: >-
          explore ได้บันทึกและงบของตัวเอง แชตขึ้นแถวของมันพร้อมนาฬิกาและปุ่ม Cancel request แรกของ explore
          เป็น request แรกของทั้ง turn: system prompt คือกรอบ subagent กับ role ของ explore จากนิยามในตัว Geno
          (แท็บสอง) tool มีแค่ glob, grep, list, read และ `report` และข้อความแรกคือ environment กับคำที่คุณพิมพ์หลัง `@explore` (แท็บสาม การ์ดมาจากการบันทึกที่พิมพ์ "Where is parseVersion called?" Geno ส่งคำของคุณไปตามที่พิมพ์ ไม่แปลหรือเขียนใหม่)
        from: engine
        to: model
        sees:
          - kind: task
            title: explore
            status: running
            detail: 0:02
            actions:
              - Cancel
          - kind: payload
            source: packages/docs/src/data/recorded/at-mention.jsonl#line=2
            select: system
            quote: You are explore, a search subagent.
          - kind: payload
            source: packages/docs/src/data/recorded/at-mention.jsonl#line=2
            select: messages[0]
            highlight: ['content[1].text']

    - id: report
      beat:
        title: explore ส่งรายงานที่อ้าง `path:line`
        text: >-
          รอบสุดท้าย explore เรียก tool `report` พร้อมคำตอบ แล้วจบงานของตัวเอง การ์ดเป็นรายงานจริงจากการรันที่ explore หาจุดเรียก `getUser`
          ดู `input.message` ที่ไฮไลต์ เป็นข้อความของรายงาน ทุกจุดอ้างไฟล์กับเลขบรรทัดแบบ `path:line`
        from: model
        to: engine
        sees:
          kind: payload
          source: docs/results/real-usecases/runs/A11-explore-subagent/fix-a1/child-181ba39b-227d-4bba-814b-cfb5a5eb66be.jsonl#seq=16
          select: content[0]
          highlight:
            - input.message
      lane: child@explore
      at: model
      do: >-
        ในรอบสุดท้าย ลูกเรียก `report` พร้อมคำตอบที่อ้าง `path:line` เช่น `src/config.ts:42`
      ref: packages/engine/src/subagents.ts#reportExecutor
      emits: [report]

    - id: child-done
      lane: child@explore
      at: loop
      do: >-
        `loopStep` ของลูกจบ `done(end_turn)` `runPlaced` ดึงรายงาน คืนงบที่ไม่ได้ใช้ และบันทึกรอบกับค่าใช้จ่าย
      ref: packages/core/src/handback.ts#handedBack

    - id: ended
      beat:
        title: แชตติดเครื่องหมายว่า explore เสร็จ
        text: แถวของ explore หยุดนาฬิกา ขึ้นเครื่องหมายถูก เวลาที่ใช้ และค่าใช้จ่าย
        from: panel
        to: you
        sees:
          kind: task
          title: explore
          status: done
          detail: 9s · $0.01
      lane: server
      at: updates
      do: >-
        `acpChildHost.ended` ส่ง `subagent_update` สถานะ `idle` งานของลูกใน Tasks จบ
      ref: packages/engine/src/subagent-acp.ts#acpChildHost
      emits: [subagent_update, idle]

    - id: row-done
      lane: panel
      at: rail
      alongside: true
      do: แถวของลูกขึ้นเครื่องหมายถูก เวลาที่ใช้ และค่าใช้จ่าย
      sees: แถว "✓ explore · <model> · 9s · $0.01"
      ref: packages/extension/src/chat/subagent-view.ts#childLook

    - id: fenced
      beat:
        title: Geno ล้อมรั้วรายงานเป็นผลของ call
        text: >-
          Geno ห่อรายงานด้วยแท็ก `<subagent_report>` ที่บอกว่าข้างในเป็นข้อมูล ไม่ใช่คำสั่งของคุณ แล้วบันทึกเป็นผลของ call `agent`
          การ์ดเป็นผลจริงจากการรันเดียวกัน ซึ่ง model เป็นคนเรียก explore ดู `output` ที่ไฮไลต์ แท็กเปิดบอกชื่อลูก สถานะ
          จำนวนรอบ ค่าใช้จ่าย และเวลา แล้วจึงเป็นข้อความรายงาน
        from: engine
        to: engine
        sees:
          kind: payload
          source: docs/results/real-usecases/runs/A11-explore-subagent/fix-a1/session.jsonl#seq=6
          highlight:
            - output
      lane: loop
      at: tools
      do: >-
        `launch` บันทึก `child-end` ลง log แล้วคืนรายงานในรั้ว `<subagent_report agent="explore" ...>` เป็นผลของ call
      ref: packages/core/src/subagent.ts#childReport
      emits: [child-end, subagent_report]

    - use: tool-result-returns

    - id: no-model
      beat:
        title: Turn จบโดยไม่เรียก model ของแม่
        text: call ที่ Geno สร้างให้คุณมีตัวเดียว เมื่อได้ผลแล้ว turn จึงจบทันที model ของแม่ไม่ถูกเรียกเลย รายงานอยู่ใน log ให้ prompt ถัดไปของคุณ
        from: engine
        to: panel
      lane: loop
      at: step
      do: >-
        `loopStep` ตัดสิน `call-model` อีกครั้ง แต่ director ไม่มี call เหลือให้ `drive` จึงจบ `end_turn` ทันที
        model ของแม่ไม่ถูกเรียกเลย และทางนี้ไม่ผ่าน Stop hook รายงานอยู่ใน log ให้ prompt ถัดไปของผู้ใช้
      ref: "packages/engine/src/drive.ts#\"if (issued === undefined) return end('end_turn');\""
      emits: [end_turn]
      phase: ending

    - id: response
      lane: server
      at: turns
      do: >-
        `runTurn` ตอบ `stopReason: end_turn` งานจบแบบ `done`
      ref: packages/engine/src/serve.ts#TURN_ENDS
      emits: [TURN_END_META]

    - id: turn-end
      lane: editor
      at: chat
      do: >-
        `turnEndOf` อ่าน `_meta` ได้ `done` แล้ว `prompt()` ส่ง action `turn-end`
      ref: "packages/extension/src/chat/chat.ts#\"this.dispatch({ type: 'turn-end', at: Date.now(), status, usage: usageOf(response)\""
      emits: [turn-end]

    - id: footer
      beat:
        title: แชตบอกว่าไม่มีคำตอบ ทั้งที่ explore ตอบแล้ว
        text: คำตอบของ explore อยู่ในผลของขั้น agent และในบทสนทนาของมัน ไม่มีข้อความของ Geno ตามหลัง แชตจึงขึ้นประกาศว่าคำตอบไม่มีข้อความ
        from: panel
        to: you
        sees:
          kind: notice
          text: Geno stopped without a reply
          detail: Its last reply had no text.
          actions:
            - Continue
            - Retry
          tone: warning
        end: Turn จบ คำตอบอยู่ในขั้น agent
      lane: panel
      at: rail
      do: >-
        คำตอบของ explore อยู่ในผลของขั้น `agent` และในบทสนทนาของลูก ไม่มีข้อความของ Geno ตามหลังขั้นนั้น
        `missingReply` จึงแสดงประกาศว่าคำตอบไม่มีข้อความ ทั้งที่ลูกตอบแล้ว
      sees: >-
        หัวข้อ "worked for 10s" ขั้น "agent explore: parseConfig ถูกนิยามไว้ที่ไหน" กับแถวของลูกที่เสร็จแล้ว
        และประกาศ "Geno stopped without a reply · Its last reply had no text." [Continue] [Retry]
      ref: packages/extension/src/chat/rail.ts#missingReply
      end: { turn: done, reason: end_turn }
---

`@agent` คือทางลัดที่ข้าม model ของแม่: ข้อความของผู้ใช้กลายเป็น call `agent` ตรงๆ
จึงไม่เสียค่าเรียก model ของแม่ และไม่มีการตีความงานซ้ำ

สิ่งที่ควรสังเกต

- **ใช้ได้ทุกโหมด** setting `agentTool` ตัดสินแค่ว่า model ของแม่เห็น tool `agent` ใน `tools` ไหม
  ส่วน executor (ฟังก์ชันที่รัน tool) ของ `agent` มีอยู่เสมอเมื่อ Geno สร้าง call ในนามคุณ ดู [subagent](/start/glossary/) ในคำศัพท์
- **`@review` แนบ diff เสมอ** ทุก `@review` แนบผลของ `git diff HEAD` ไม่เกิน 60,000 ตัวอักษรไปกับงาน
  ถ้าพิมพ์ `@review` โดยไม่มีงาน บรรทัดแรกของงานจะเป็น "Review the changes in this diff."
- **พิมพ์ชื่ออย่างเดียว** `@explore` ที่ไม่มีงาน ลูกจะตอบสั้นๆ ว่าทำอะไรได้บ้าง
- **ชื่อที่ไม่รู้จักไม่ใช่ mention** ถ้าไม่มีลูกชื่อนั้น ข้อความไปเป็น prompt ธรรมดาให้ model ของแม่
- **ประกาศ "Geno stopped without a reply" ขึ้นหลังทุก `@agent`** (อ่านจากโค้ด) turn แบบนี้จบโดยไม่มีข้อความของ Geno
  `missingReply` ไม่ยกเว้นกรณีนี้ ปุ่ม Continue จะส่ง prompt ให้ model ของแม่ ซึ่งเห็นรายงานใน log แล้วเล่าต่อได้
