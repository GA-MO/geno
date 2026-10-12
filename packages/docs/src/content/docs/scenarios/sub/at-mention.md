---
title: "@mention เรียกเอเจนต์ลูกโดยตรง"
description: ผู้ใช้พิมพ์ @explore ตามด้วยคำถาม ข้อความกลายเป็น call agent ของผู้ใช้เอง ลูกตอบ แล้ว turn จบโดยไม่เรียกโมเดลของแม่เลย
tableOfContents: false
sidebar:
  order: 2
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

    - id: issued
      lane: loop
      at: step
      do: >-
        `runAgent` เห็นแล้วว่า prompt ขึ้นต้นด้วย `@explore` (`mentionedCall`) จึงสร้าง call `agent` ของผู้ใช้เอง
        พร้อม `task` คือข้อความหลังชื่อ และตั้ง director แบบ `issuedOnce` เมื่อ `loopStep` ตัดสิน `call-model`
        `drive` ไม่เรียกโมเดล แต่บันทึก call นั้นเป็น event `assistant` ที่มี `issuedBy: 'user'`
      ref: packages/engine/src/subagents.ts#mentionedCall
      emits: [assistant, issuedBy]

    - id: run
      lane: loop
      at: step
      do: >-
        `loopStep` เห็น `tool_use` ที่ยังไม่มีผล จึงตัดสิน `run-tools` เหมือน call ที่โมเดลขอ
      ref: packages/core/src/loop.ts#loopStep
      emits: [run-tools]
      phase: running-tools

    - use: sub-child-starts

    - id: report
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
      sees: แถว "✓ explore · <โมเดล> · 9s · $0.01"
      ref: packages/extension/src/chat/subagent-view.ts#childLook

    - id: fenced
      lane: loop
      at: tools
      do: >-
        `launch` บันทึก `child-end` ลง log แล้วคืนรายงานในรั้ว `<subagent_report agent="explore" ...>` เป็นผลของ call
      ref: packages/core/src/subagent.ts#childReport
      emits: [child-end, subagent_report]

    - use: tool-result-returns

    - id: no-model
      lane: loop
      at: step
      do: >-
        `loopStep` ตัดสิน `call-model` อีกครั้ง แต่ director ไม่มี call เหลือให้ `drive` จึงจบ `end_turn` ทันที
        โมเดลของแม่ไม่ถูกเรียกเลย และทางนี้ไม่ผ่าน Stop hook รายงานอยู่ใน log ให้ prompt ถัดไปของผู้ใช้
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

`@agent` คือทางลัดที่ข้ามโมเดลของแม่: ข้อความของผู้ใช้กลายเป็น call `agent` ตรงๆ
จึงไม่เสียค่าเรียกโมเดลของแม่ และไม่มีการตีความงานซ้ำ

สิ่งที่ควรสังเกต

- **ใช้ได้ทุกโหมด** การเปิด `agentTool` มีผลแค่กับโมเดล executor ของ `agent` มีให้เสมอเมื่อมี director
- **`@review` เปล่าๆ แนบ diff** ถ้าพิมพ์ `@review` โดยไม่มีงาน งานจะเป็น "Review the changes in this diff." พร้อมผลของ
  `git diff HEAD` ไม่เกิน 60,000 ตัวอักษร
- **พิมพ์ชื่ออย่างเดียว** `@explore` ที่ไม่มีงาน ลูกจะตอบสั้นๆ ว่าทำอะไรได้บ้าง
- **ชื่อที่ไม่รู้จักไม่ใช่ mention** ถ้าไม่มีลูกชื่อนั้น ข้อความไปเป็น prompt ธรรมดาให้โมเดลของแม่
- **ประกาศ "Geno stopped without a reply" ขึ้นหลังทุก `@agent`** (อ่านจากโค้ด) turn แบบนี้จบโดยไม่มีข้อความของ Geno
  `missingReply` ไม่ยกเว้นกรณีนี้ ปุ่ม Continue จะส่ง prompt ให้โมเดลของแม่ ซึ่งเห็นรายงานใน log แล้วเล่าต่อได้
