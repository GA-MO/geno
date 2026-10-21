---
title: "จบแผนแล้วคุณกด Start building"
description: หลัง turn ในโหมด Plan จบ ผู้ใช้กด Start building ส่วนขยายสลับโหมดเป็น Ask หรือ Auto แล้วส่ง "Go ahead with the plan." เป็น turn ใหม่ ที่ model ได้ประกาศโหมดและรายการ todo ของแผน
scenario:
  surface: vscode
  given:
    - session อยู่ในโหมด Plan และ turn ล่าสุดจบแบบ done ในโหมด Plan
    - model เขียนแผนเป็นคำตอบ และตั้งรายการ todo ห้าข้อที่ยัง `pending` ทั้งหมด
    - การตั้งค่า `gcode.approvalMode` ของแชตใหม่เป็น Ask (ค่าตั้งต้น)
  trigger: >-
    ผู้ใช้อ่านแผนแล้วคลิกปุ่ม Start building ใต้ turn นั้น
  covers: [perm.plan-start-building]
  related: [perm.plan-command-denied, perm.mode-switch-mid-turn, tool.todo-list]
  steps:
    - id: offered
      lane: panel
      at: rail
      beat:
        title: "แชตขึ้นปุ่ม Start building ใต้แผน"
        text: >-
          turn ล่าสุดจบในโหมด Plan model เขียนแผนและตั้งรายการ todo ห้าข้อที่ยังไม่เริ่ม แผงวาดปุ่ม Start building ใต้
          turn นั้น เพราะ session ยังอยู่ในโหมด Plan
        from: panel
        to: you
        sees: "ปุ่ม \"Start building\" ไอคอน play ใต้แผน และป้าย \"Plan\" ข้างหัวข้อของ turn"
      do: >-
        แผงวาดปุ่ม Start building ใต้ turn ล่าสุดเมื่อ turn นั้นจบแบบ done ในโหมด Plan และ session ยังอยู่ในโหมด Plan
      sees: ปุ่ม "Start building" ไอคอน play ใต้แผน และป้าย "Plan" ข้างหัวข้อของ turn
      ref: packages/extension/src/chat/render.ts#startBuilding
      phase: idle

    - id: click
      lane: user
      beat:
        title: "คุณคลิก Start building"
        text: >-
          คุณอ่านแผนแล้วคลิกปุ่ม แผงส่งคำขอไปที่ VS Code
        from: you
        to: panel
      do: ผู้ใช้คลิก Start building

    - id: post
      lane: panel
      at: rail
      do: >-
        ปุ่มโพสต์ `start-building` ไปให้ extension host
      ref: "packages/extension/src/chat/render.ts#\"onclick: () => ui.post({ type: 'start-building' })\""
      emits: [start-building]

    - id: switch
      lane: editor
      at: chat
      beat:
        title: "VS Code เปลี่ยนโหมดเป็น Ask"
        text: >-
          ไม่มี turn ทำงานอยู่ VS Code เปลี่ยนโหมดเป็นโหมดของแชตใหม่ตามการตั้งค่า ซึ่งคือ Ask เว้นแต่คุณตั้งเป็น Auto
          engine เปลี่ยนโหมดและบันทึกลงบันทึกของ session
        from: panel
        to: engine
      do: >-
        `startBuilding` ตรวจว่าไม่มี turn ทำงาน แล้วเรียก `setMode` ด้วยโหมดของแชตใหม่ตามการตั้งค่า (Ask เว้นแต่ตั้งเป็น Auto)
        ซึ่งส่งคำขอ ACP `session/set_mode`
      ref: packages/extension/src/chat/chat.ts#Chat.startBuilding

    - id: mode
      lane: server
      at: sessions
      do: >-
        `switchMode` เปลี่ยนโหมดใน `modes` ส่ง `current_mode_update` และบันทึก event `mode` ลง log
      ref: "packages/engine/src/serve.ts#\"const switchMode = async (client: acp.AgentContext, sessionId: string, mode: SessionMode) => {\""
      emits: [current_mode_update]

    - id: picker
      lane: panel
      at: composer
      beat:
        title: "ปุ่มโหมดเป็น Ask และปุ่ม Start building หาย"
        text: >-
          session ไม่อยู่ในโหมด Plan แล้ว ปุ่ม Start building จึงหายไป
        from: panel
        to: you
        sees: { kind: composer, state: idle }
      alongside: true
      do: >-
        ปุ่มโหมดเปลี่ยนเป็น Ask และปุ่ม Start building หายไป เพราะ session ไม่อยู่ในโหมด Plan แล้ว
      sees: ปุ่มโหมดในช่องพิมพ์เป็น "Ask"
      ref: packages/extension/src/chat/modes.ts#modePicker

    - id: send
      lane: editor
      at: chat
      beat:
        title: "VS Code ส่ง “Go ahead with the plan.”"
        text: >-
          VS Code ส่งคำขอคงที่ในนามคุณ พร้อมป้ายว่ามาจากปุ่ม Start building แชตขึ้นบับเบิลใหม่และหัวข้อ working
        from: panel
        to: engine
        sees: { kind: message, from: you, text: Go ahead with the plan. }
      do: >-
        `startBuilding` เรียก `act('start-building')` ซึ่งส่งข้อความ `PROMPT_ACTIONS['start-building']` ผ่าน `prompt()`
        พร้อม `_meta` `gcode/action: start-building` `prompt()` ส่ง action `turn-start` แล้วส่งคำขอ ACP `session/prompt`
      sees: บับเบิลใหม่ "Go ahead with the plan." หัวข้อ "working"
      ref: packages/extension/src/chat/chat.ts#Chat.act
      emits: [turn-start]

    - id: accept
      lane: server
      at: turns
      beat:
        title: "Geno เริ่ม turn ใหม่ในโหมด Ask"
        text: >-
          engine รับเป็น turn ใหม่ที่คุณส่ง และไม่ตีความข้อความเป็นคำสั่ง `/` (slash command)
          ทุก call ใน turn นี้ตัดสินด้วยโหมด Ask และงบของ turn (จำนวนครั้งที่เรียก model และเงิน) เริ่มนับใหม่
          Geno บันทึกข้อความแล้วตัดสินว่าขั้นต่อไปคือเรียก model
        from: engine
        to: engine
      do: >-
        `runTurn` รับเป็น turn ใหม่ที่ผู้ใช้ส่ง เห็น `gcode/action` จึงไม่ขยายคำสั่ง / แล้วเรียก `runAgent` ซึ่งตัดสินแต่ละ call ด้วยโหมด Ask ขีดจำกัดของรอบนับใหม่จาก prompt นี้
      ref: packages/engine/src/serve.ts#runTurn
      phase: starting

    - id: record
      lane: loop
      at: drive
      do: >-
        `logPrompt` บันทึก event `user` ของข้อความนี้พร้อม `action: start-building` ก่อนเริ่ม run แล้ว `drive` ได้ prompt ว่าง
        และไม่บันทึกซ้ำ
      ref: packages/engine/src/serve.ts#logPrompt
      emits: [user]

    - id: decide
      lane: loop
      at: step
      do: >-
        `loopStep` ตัดสิน `call-model`
      ref: packages/core/src/loop.ts#loopStep
      emits: [call-model]
      phase: calling-model

    - id: notice
      lane: loop
      at: drive
      beat:
        title: "Geno บอก model เรื่องโหมดและรายการ todo"
        text: >-
          ก่อนเรียก model (จุดปลอดภัยที่ประกาศแทรกได้) Geno เพิ่มประกาศหนึ่งก้อนที่รวมสองเรื่อง โหมดเปลี่ยนจาก Plan เป็น Ask และรายการ todo
          ของแผนยังไม่เสร็จ จึงแนบรายการเดิมมาด้วย ประกาศนี้อยู่ใน log และถึง model พร้อมคำขอถัดไป
        from: engine
        to: engine
      do: >-
        `deliver()` บันทึก `notice` หนึ่งตัวที่รวมสองเรื่อง: `noticeFor` เห็นว่าโหมดเปลี่ยนจาก Plan เป็น Ask
        และ `todoReminder` เห็นว่ารายการยังไม่เสร็จหลัง prompt ที่ผู้ใช้พิมพ์ จึงแนบรายการเดิมมาด้วย
      ref: packages/engine/src/drive.ts#deliver
      emits: [notice]

    - id: carried
      lane: panel
      at: rail
      beat:
        title: "แชตปักรายการ todo ของแผน"
        text: >-
          turn ใหม่ยังไม่ได้ตั้งรายการของตัวเอง แชตจึงปักรายการที่ยังไม่เสร็จจาก turn ก่อนไว้ โดยไม่มีข้อไหนหมุน
        from: panel
        to: you
        sees: "กล่อง \"0 of 5 done · from an earlier turn\" ที่พับไว้"
      alongside: true
      do: >-
        turn ใหม่ยังไม่ได้ตั้งรายการของตัวเอง แผงจึงปักรายการที่ยังไม่เสร็จจาก turn ก่อนไว้ โดยไม่มีข้อไหนหมุน
      sees: กล่อง "0 of 5 done · from an earlier turn" ที่พับไว้
      ref: packages/extension/src/chat/todo-view.ts#todoStep

    - use: model-call
      beat:
        title: "Model เริ่มทำตามแผน"
        text: >-
          Geno เรียก model model อ่านว่าคุณเปลี่ยนเป็นโหมด Ask แล้วแก้โค้ดได้ ตามด้วยรายการ todo ของแผน
          แล้วเริ่มแก้โค้ดตามขั้นแรก การ์ดข้างล่างเป็นการบันทึกที่รัน Geno จริงกับ model จำลองที่ตอบตามบทที่เขียนไว้ก่อน การ์ดคือข้อความท้ายของคำขอนี้ ดูสามบล็อกที่ไฮไลต์:
          ประกาศโหมด Ask รายการ todo ที่ยังไม่เสร็จ และคำขอของปุ่มที่ Geno ห่อเป็นโน้ตว่าคุณกดปุ่ม
        from: engine
        to: model
        sees:
          kind: payload
          source: packages/docs/src/data/recorded/perm-plan-start-building.jsonl#line=8
          select: messages[-1].content
          highlight: ['[0].text', '[1].text', '[3].text']
        end: "เริ่มสร้างตามแผน"

    - id: builds
      lane: model
      do: >-
        model อ่าน "[Geno] The user switched this session to Ask mode. You can change code ..." ตามด้วยรายการ todo ของแผน
        แล้วเริ่มแก้โค้ดตามขั้นแรก
      ref: packages/core/src/notice.ts#MODE_NOTICES
      end: { turn: continues, reason: call-model }
---

Start building คือทางลัดของสองอย่างที่ผู้ใช้ทำเองได้: สลับโหมดออกจาก Plan และส่งข้อความสั้นๆ ให้ลงมือ
ต่างกันที่ข้อความนี้เป็นคำของ Geno ไม่ใช่ของผู้ใช้ `userActionText` ห่อมันเป็นโน้ตของ Geno ว่าผู้ใช้กดปุ่ม
และให้ model ตอบต่อในภาษาที่ผู้ใช้พิมพ์เอง session ที่คุยภาษาไทยจึงไม่เปลี่ยนเป็นภาษาอังกฤษหลังกดปุ่ม
แผนไม่ได้ถูกส่งซ้ำ มันอยู่ใน log แล้ว model เห็นแผนของตัวเองในบทสนทนา และเห็นรายการ todo ในประกาศ

สิ่งที่ควรสังเกต

- **โหมดที่ได้มาจากการตั้งค่า ไม่ใช่โหมดก่อน Plan** `startBuilding` ใช้ `gcode.approvalMode` ของแชตใหม่
  ถ้าผู้ใช้อยู่ใน Auto ก่อนสลับเป็น Plan การกดปุ่มนี้จะได้ Ask เว้นแต่การตั้งค่าเป็น Auto
- **รายการ todo เป็นสะพาน** ประกาศโหมด Plan ขอให้ model เขียนขั้นตอนลงรายการ todo เมื่อเริ่มสร้าง รายการเดิมกลับมาพร้อมประกาศ
  และแผงแสดงรายการเดิมจนกว่า model จะตั้งรายการใหม่
- **ปุ่มอยู่เฉพาะ turn ล่าสุด** ถ้าผู้ใช้สลับโหมดออกจาก Plan เอง ปุ่มหายไป ถ้าส่งข้อความอื่นขณะยังอยู่ใน Plan ปุ่มย้ายไปอยู่ใต้ turn ใหม่เมื่อ turn นั้นจบแบบ done

การเปลี่ยนโหมดระหว่าง turn ดู [สลับโหมดระหว่าง turn](/scenarios/perm/mode-switch-mid-turn/)
