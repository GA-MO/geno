---
title: "ยกเลิก subagent ระหว่างทำงาน"
description: ผู้ใช้กด Cancel บนแถวของลูก ลูกหยุด แม่ได้รายงานเท่าที่ลูกมี แล้ว turn ของแม่ทำต่อ
tableOfContents: false
sidebar:
  order: 3
scenario:
  surface: vscode
  given:
    - ค่า `agentTool` มีโหมดปัจจุบัน และมี turn ทำงานอยู่
    - โมเดลของแม่ส่งคำถามกว้างๆ ให้ `explore` และลูกกำลังค้นอยู่นาน
  trigger: >-
    ผู้ใช้เห็นว่าลูกค้นผิดทาง จึงกด Cancel บนแถวของลูก
  covers: [sub.user-cancels-child]
  related: [sub.parent-stop-with-children, sub.blocking-report, bg.task-stop-or-list]
  steps:
    - id: wants
      beat:
        title: Model ส่งงานค้นหาให้ explore
        text: model ของแม่ส่งคำถามกว้างๆ ให้ explore แล้วรอรายงาน
        to: engine
      lane: model
      do: >-
        โมเดลของแม่ขอเรียก `agent` ด้วย `agent: "explore"` และงานค้นหา จบคำตอบด้วย `stop_reason: tool_use`
      ref: packages/core/src/subagent.ts#agentToolDefinition
      emits: [tool_use]
      phase: calling-model

    - id: decide
      lane: loop
      at: step
      do: >-
        `loopStep` ตัดสินว่า `run-tools` call `agent` แบบรอผลค้างอยู่จนกว่าลูกจะจบ
      ref: packages/core/src/loop.ts#loopStep
      emits: [run-tools]
      phase: running-tools

    - use: sub-child-starts
      beat:
        title: Geno เปิด session ให้ explore
        text: แชตขึ้นแถวของ explore พร้อมนาฬิกาและปุ่ม Cancel explore ค้นอยู่นาน
        sees:
          kind: task
          title: explore
          status: running
          detail: 0:38
          actions:
            - Cancel

    - id: click
      beat:
        title: คุณกด Cancel บนแถวของ explore
        text: คุณเห็นว่า explore ค้นผิดทาง ปุ่มบอกว่ามันหยุดแค่ explore และ turn ทำต่อด้วยสิ่งที่มันหาได้
        to: panel
      lane: user
      do: ผู้ใช้กด Cancel บนแถวของ explore (ปุ่มบอกว่า "Stop explore; the turn goes on with what it found")

    - id: post
      lane: panel
      at: rail
      do: >-
        ปุ่มโพสต์ข้อความ `cancel-child` พร้อม session id ของลูก
      ref: "packages/extension/src/chat/subagent-view.ts#\"onclick: () => ui.post({ type: 'cancel-child', id: child.id })\""
      emits: [cancel-child]

    - id: cancel
      beat:
        title: แชตยกเลิกแค่ session ของ explore
        text: คำขอยกเลิกใช้ session ของ explore ไม่ใช่ของแม่ engine หาตัวยกเลิกของ explore เจอ turn ของแม่ไม่ถูกแตะ
        to: engine
      lane: editor
      at: chat
      do: >-
        `cancelChild` ตรวจว่าลูกยังรันอยู่ แล้วส่ง notification ACP `session/cancel` ที่ใช้ session id ของ**ลูก** ไม่ใช่ของแม่
      ref: packages/extension/src/chat/chat.ts#Chat.cancelChild
      emits: [session/cancel]

    - id: found
      lane: server
      at: turns
      do: >-
        engine ไม่เจอ turn ของ id นี้ใน `turns` แต่เจอใน `childCancels` ที่ `acpChildHost` ลงทะเบียนไว้ จึงเรียกตัวยกเลิกของลูก
        turn ของแม่ไม่ถูกแตะ
      ref: "packages/engine/src/serve.ts#\"childCancels.get(params.sessionId)?.();\""

    - id: aborted
      beat:
        title: explore หยุด
        text: สิ่งที่ explore กำลังรอหยุดทันที มันจบแบบ cancelled
      lane: child@explore
      at: loop
      do: >-
        controller ของลูกถูก abort การเรียกโมเดลหรือเครื่องมือที่ค้างอยู่ของลูกหยุด ลูกบันทึก error ชนิด `abort` แล้ว loop ของลูกจบ
        `childEndOf` เห็นว่ามีการยกเลิก จึงได้ `cancelled` (ไม่มี `by` เพราะผู้ใช้เป็นคนยกเลิก)
      ref: packages/core/src/subagent.ts#childEndOf
      emits: [abort, cancelled]

    - id: partial
      beat:
        title: Geno ส่งรายงานเท่าที่ explore มี
        text: Geno รวมข้อความที่ explore เขียนไว้เป็นรายงานบางส่วน และบอกว่ามันถูกยกเลิกก่อนเสร็จ
      lane: loop
      at: tools
      do: >-
        `handedBack` แบบบางส่วนรวมข้อความทุกส่วนที่ลูกเขียนไว้ (หรือ "(no report)" ถ้าไม่มี)
        `childReport` ใส่ `status="cancelled" partial="true"` และบรรทัดบอกว่านี่คือสิ่งที่ลูกมีก่อนถูกยกเลิก
        `launch` บันทึก `child-end` แล้วคืนข้อความนี้เป็นผลปกติของ call `agent`
      ref: packages/core/src/subagent.ts#childReport
      emits: [child-end, partial]

    - id: ended
      beat:
        title: แถวของ explore ขึ้นว่ายกเลิก
        text: แถวหยุดนาฬิกาและขึ้นไอคอนยกเลิก ปุ่ม Cancel หายไป
        sees: แถว "⊘ explore · <โมเดล> · 41s" สถานะ Cancelled
      lane: server
      at: updates
      do: >-
        `acpChildHost.ended` ส่ง `subagent_update` สถานะ `idle` stop reason `cancelled`
      ref: packages/engine/src/subagent-acp.ts#acpChildHost
      emits: [subagent_update, cancelled]

    - id: row-cancelled
      lane: panel
      at: rail
      alongside: true
      do: แถวของลูกหยุดนาฬิกาและขึ้นไอคอนยกเลิก ปุ่ม Cancel หายไป
      sees: แถว "⊘ explore · <โมเดล> · 41s" สถานะ Cancelled
      ref: packages/extension/src/chat/subagent-view.ts#childLook

    - use: tool-result-returns

    - id: goes-on
      beat:
        title: Model อ่านรายงานบางส่วนแล้วทำต่อ
        text: การยกเลิกลูกไม่ใช่การปฏิเสธ turn ของแม่ไม่จบ model ทำงานต่อเอง หรือถามคุณว่าจะไปทางไหน
        to: model
        end: Turn ทำต่อ
      lane: loop
      at: step
      do: >-
        ผลของ call `agent` มีสถานะ `ok` ไม่ใช่ `rejected` `loopStep` จึงตัดสิน `call-model`
        โมเดลของแม่อ่านรายงานบางส่วนแล้วทำต่อเอง หรือถามผู้ใช้ว่าจะไปทางไหน
      ref: packages/core/src/loop.ts#loopStep
      emits: [call-model]
      phase: calling-model
      end: { turn: continues, reason: call-model }
---

Cancel บนแถวของลูกกับ Stop ของแม่ต่างกันที่เป้าหมาย: Cancel ส่ง `session/cancel` ด้วย id ของลูก จึงหยุดแค่ลูก
ส่วน Stop ส่ง id ของแม่ ซึ่งหยุดทั้ง turn และลูกทุกตัว ดู [หยุดเทิร์นแม่ขณะลูกทำงาน](/scenarios/sub/parent-stop-with-children/)

สิ่งที่ควรสังเกต

- **แม่ไม่รู้ว่าผู้ใช้กด Cancel จนกว่าจะอ่านผล** ผลของ call บอกว่าลูกถูกผู้ใช้ยกเลิก
  และข้อความในรั้วคือสิ่งที่ลูกเขียนไว้ก่อนหน้า ไม่ใช่คำตอบที่ลูกตั้งใจส่ง
- **ข้อความที่ stream อยู่หายไป** ลูกบันทึกข้อความของตัวเองตอนจบการเรียกโมเดลแต่ละครั้ง ข้อความที่กำลัง stream ตอนกด Cancel
  จึงไม่อยู่ในรายงาน
- **Cancel ใช้ได้ระหว่างที่ turn ของแม่ยังรันอยู่ในแผงนี้** `cancelChild` ไม่ทำอะไรถ้าแผงไม่มี turn หรือแถวไม่ได้รันอยู่แล้ว
- **บรรทัดหลังรั้วอ่านติดขัด** `childReport` ต่อคำเป็น "The subagent cancelled by the user before it finished, so this is what it had."
  ซึ่งขาดคำว่า "was" (`END_WORDS.cancelled` ไม่มีคำกริยา ต่างจาก `was stopped with task_stop`)
