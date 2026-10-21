---
title: "ยกเลิก subagent ระหว่างทำงาน"
description: ผู้ใช้กด Cancel บนแถวของลูก ลูกหยุด แม่ได้รายงานเท่าที่ลูกมี แล้ว turn ของแม่ทำต่อ
scenario:
  surface: vscode
  given:
    - ค่า `agentTool` มีโหมดปัจจุบัน และมี turn ทำงานอยู่
    - model ของแม่ส่งคำถามกว้างๆ ให้ `explore` และลูกกำลังค้นอยู่
  trigger: >-
    ผู้ใช้เห็นว่าลูกค้นผิดทาง จึงกด Cancel บนแถวของลูก
  covers: [sub.user-cancels-child]
  related: [sub.parent-stop-with-children, sub.blocking-report, bg.task-stop-or-list]
  steps:
    - id: wants
      beat:
        title: Model ส่งงานค้นหาให้ explore
        text: >-
          subagent (ลูก) คือ session ใหม่ที่ model ของแม่ (session หลักที่คุณคุยอยู่) เปิดให้ทำงานย่อยแล้วส่งรายงานกลับ
          explore คือ subagent ในตัว Geno ที่ค้นโค้ดแบบอ่านอย่างเดียว
          model เลือกจาก tool `agent` ใน request ของมัน (แท็บแรก ดู `description` ที่ไฮไลต์) แล้วส่ง `tool_use` ที่มี `agent: "explore"`
          และ `task` ที่เขียนให้ครบในตัว ไม่มี `background` จึงรอรายงานใน call นี้ (แท็บสอง ดู `input` ที่ไฮไลต์)
        from: model
        to: engine
        sees:
          - kind: payload
            source: packages/docs/src/data/recorded/child-cancelled.jsonl#line=2
            select: tools[9]
            highlight: [description]
            quote: "- explore: Fast read-only search."
          - kind: payload
            source: packages/docs/src/data/recorded/child-cancelled.jsonl#line=6
            select: messages[1].content
            highlight: ['[0].input']
      lane: model
      do: >-
        model ของแม่ขอเรียก `agent` ด้วย `agent: "explore"` และงานค้นหา จบคำตอบด้วย `stop_reason: tool_use`
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
        text: >-
          แชตขึ้นแถวของ explore พร้อมนาฬิกาและปุ่ม Cancel request แรกของ explore มี system prompt ของ explore
          (กรอบ subagent กับ role จากนิยามในตัว Geno) และข้อความแรกที่มีแค่ข้อมูลสภาพแวดล้อม (เช่นโฟลเดอร์และระบบปฏิบัติการ) กับ `task`
          ไม่มีบทสนทนาของแม่ จากนั้น explore เริ่มเขียนคำตอบแรก
        from: engine
        to: model
        sees:
          - kind: task
            title: explore
            status: running
            detail: <เวลา>
            actions:
              - Cancel
          - kind: payload
            source: packages/docs/src/data/recorded/child-cancelled.jsonl#line=4
            select: system
            quote: You are explore, a search subagent.
          - kind: payload
            source: packages/docs/src/data/recorded/child-cancelled.jsonl#line=4
            select: messages[0]
            highlight: ['content[1].text']

    - id: click
      beat:
        title: คุณกด Cancel บนแถวของ explore
        text: คุณเห็นว่า explore ค้นผิดทาง ปุ่มบอกว่ามันหยุดแค่ explore และ turn ทำต่อด้วยสิ่งที่มันหาได้
        from: you
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
        from: panel
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
        text: สิ่งที่ explore กำลังรอหยุดทันที Geno ตัดคำตอบที่ model ของ explore กำลัง stream อยู่ (ส่งมาทีละชิ้นระหว่างที่ model เขียน) ทิ้ง แล้ว explore จบแบบ cancelled
        from: engine
        to: engine
      lane: child@explore
      at: loop
      do: >-
        controller ของลูกถูก abort การเรียก model หรือ tool ที่ค้างอยู่ของลูกหยุด ลูกบันทึก error ชนิด `abort` แล้ว loop ของลูกจบ
        `childEndOf` เห็นว่ามีการยกเลิก จึงได้ `cancelled` (ไม่มี `by` เพราะผู้ใช้เป็นคนยกเลิก)
      ref: packages/core/src/subagent.ts#childEndOf
      emits: [abort, cancelled]

    - id: partial
      beat:
        title: Geno ส่งรายงานเท่าที่ explore มี
        text: >-
          Geno รวมข้อความที่ explore เขียนเสร็จแล้วเป็นรายงานบางส่วน และบอกว่ามันถูกยกเลิกก่อนเสร็จ
          ข้อความที่กำลัง stream อยู่ตอนกด Cancel ไม่นับ ในการบันทึกนี้ explore stream "I will search for calls of parseVersion, then re"
          ไปแล้วครึ่งคำตอบ แต่รายงานคือ "(no report)" พร้อม `status="cancelled" partial="true"` และ `turns="0"` (explore ยังเรียก model ไม่จบสักครั้ง)
          รายงานนี้เป็นผลของ call `agent` ที่ถึง model ของแม่ตอนเรียกครั้งถัดไป ระหว่างนี้ model ไม่ได้ตอบอะไร
        from: engine
        to: engine
        sees:
          kind: payload
          source: packages/docs/src/data/recorded/child-cancelled.jsonl#line=6
          select: messages[2].content[0]
          highlight: [content]
          quote: turns="0"
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
        text: >-
          แถวหยุดนาฬิกาและขึ้นไอคอนยกเลิก ปุ่ม Cancel หายไป
          ค่า `duration="1s"` ในรายงานของการบันทึกนี้ไม่ใช่เวลาจริง ตัวบันทึกเขียน `duration` ของ subagent เป็น `1s` เสมอ
        from: panel
        to: you
        sees: แถว "⊘ explore · <model> · <เวลา>" สถานะ Cancelled
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
      sees: แถว "⊘ explore · <model> · <เวลา>" สถานะ Cancelled
      ref: packages/extension/src/chat/subagent-view.ts#childLook

    - use: tool-result-returns

    - id: goes-on
      beat:
        title: Geno เรียก model ของแม่อีกครั้ง
        text: >-
          การยกเลิกลูกไม่ใช่การปฏิเสธ turn ของแม่ไม่จบ Geno ส่งบทสนทนาทั้งหมดไปให้ model ของแม่อีกครั้งในคำขอใหม่
          ท้ายคำขอคือคำขอ `agent` ของ model และรายงานบางส่วนของ explore สองจุดที่ไฮไลต์ในการ์ดคือ `tool_use` นั้น
          และ `tool_result` ที่ตอบมัน ซึ่งมีรายงาน `status="cancelled" partial="true"`
        from: engine
        to: model
        sees:
          kind: payload
          source: packages/docs/src/data/recorded/child-cancelled.jsonl#line=6
          select: messages
          collapse: ['[0]']
          highlight: ['[1].content[0]', '[2].content[0]']
      lane: loop
      at: step
      do: >-
        ผลของ call `agent` มีสถานะ `ok` ไม่ใช่ `rejected` `loopStep` จึงตัดสิน `call-model`
        model ของแม่อ่านรายงานบางส่วนแล้วทำต่อเอง หรือถามผู้ใช้ว่าจะไปทางไหน
      ref: packages/core/src/loop.ts#loopStep
      emits: [call-model]
      phase: calling-model

    - id: reply
      beat:
        title: Model อ่านรายงานบางส่วนแล้วทำต่อ
        text: >-
          model ของแม่รู้เฉพาะสิ่งที่อยู่ในรั้วรายงาน ในทางนี้รายงานคือ "(no report)" model จริงจึงบอกได้แค่ว่า explore
          ถูกหยุดก่อนรายงานอะไร แล้วทำงานต่อเอง หรือถามคุณว่าจะไปทางไหน
          การบันทึกนี้ใช้ model จำลองที่ตอบตามบทที่เขียนไว้ก่อน บทให้มันตอบแบบนั้น: "You stopped explore before it reported
          anything, so I have no calls to show yet. Say if you want me to search again."
          แล้วจบคำตอบด้วย `end_turn` (การ์ด: event ท้าย stream ที่บอกเหตุที่หยุด)
        from: model
        to: engine
        sees:
          kind: payload
          source: packages/docs/src/data/recorded/child-cancelled.jsonl#line=7
          select: '[-2]'
          highlight: [data.delta.stop_reason]
      lane: model
      do: >-
        model ของแม่อ่าน `tool_result` ของ `agent` ที่มี `status="cancelled" partial="true"` แล้วตอบเป็นข้อความโดยไม่ขอ tool
        จบด้วย `stop_reason: end_turn`
      ref: "packages/engine/src/gateway.ts#\"stopReason: message.stop_reason,\""
      emits: [end_turn]
      phase: calling-model

    - use: answer-streams
      beat:
        title: คำตอบค่อยๆ ขึ้นในแชต
        text: Geno ส่งแต่ละส่วนที่ model เขียนผ่าน VS Code ไปถึงแผงแชตทันที คุณจึงอ่านได้ก่อน model เขียนเสร็จ
        from: engine
        to: panel
    - use: turn-ends
      beat:
        title: Turn จบ
        text: ปุ่ม Send กลับมา และท้ายคำตอบมีแถวสรุป model token และค่าใช้จ่าย
        from: engine
        to: panel
        sees:
          kind: composer
          state: idle
        end: Turn จบ
---

Cancel บนแถวของลูกกับ Stop ของแม่ต่างกันที่เป้าหมาย: Cancel ส่ง `session/cancel` ด้วย id ของลูก จึงหยุดแค่ลูก
ส่วน Stop ส่ง id ของแม่ ซึ่งหยุดทั้ง turn และลูกทุกตัว ดู [หยุด turn แม่ขณะลูกทำงาน](/scenarios/sub/parent-stop-with-children/)

สิ่งที่ควรสังเกต

- **แม่ไม่รู้ว่าผู้ใช้กด Cancel จนกว่าจะอ่านผล** ผลของ call บอกว่าลูกถูกผู้ใช้ยกเลิก
  และข้อความในรั้วคือสิ่งที่ลูกเขียนไว้ก่อนหน้า ไม่ใช่คำตอบที่ลูกตั้งใจส่ง
- **ข้อความที่ stream อยู่หายไป** ลูกบันทึกข้อความของตัวเองตอนจบการเรียก model แต่ละครั้ง ข้อความที่กำลัง stream ตอนกด Cancel
  จึงไม่อยู่ในรายงาน
- **Cancel ใช้ได้ระหว่างที่ turn ของแม่ยังรันอยู่ในแผงนี้** `cancelChild` ไม่ทำอะไรถ้าแผงไม่มี turn หรือแถวไม่ได้รันอยู่แล้ว
- **บรรทัดหลังรั้วอ่านติดขัด** `childReport` ต่อคำเป็น "The subagent cancelled by the user before it finished, so this is what it had."
  ซึ่งขาดคำว่า "was" (`END_WORDS.cancelled` ไม่มีคำกริยา ต่างจาก `was stopped with task_stop`)
