---
title: จบแผนแล้วกด Start building
description: หลัง turn ในโหมด Plan จบ ผู้ใช้กด Start building ส่วนขยายสลับโหมดเป็น Ask หรือ Auto แล้วส่ง "Go ahead with the plan." เป็น turn ใหม่ ที่โมเดลได้ประกาศโหมดและรายการ todo ของแผน
tableOfContents: false
sidebar:
  order: 6
scenario:
  surface: vscode
  given:
    - session อยู่ในโหมด Plan และ turn ล่าสุดจบแบบ done ในโหมด Plan
    - โมเดลเขียนแผนเป็นคำตอบ และตั้งรายการ todo ห้าข้อที่ยัง `pending` ทั้งหมด
    - การตั้งค่า `gcode.approvalMode` ของแชตใหม่เป็น Ask (ค่าตั้งต้น)
  trigger: >-
    ผู้ใช้อ่านแผนแล้วคลิกปุ่ม Start building ใต้ turn นั้น
  covers: [perm.plan-start-building]
  related: [perm.plan-command-denied, perm.mode-switch-mid-turn, tool.todo-list]
  steps:
    - id: offered
      lane: panel
      at: rail
      do: >-
        แผงวาดปุ่ม Start building ใต้ turn ล่าสุดเมื่อ turn นั้นจบแบบ done ในโหมด Plan และ session ยังอยู่ในโหมด Plan
      sees: ปุ่ม "Start building" ไอคอน play ใต้แผน และป้าย "Plan" ข้างหัวข้อของ turn
      ref: packages/extension/src/chat/render.ts#startBuilding
      phase: idle

    - id: click
      lane: user
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
      alongside: true
      do: >-
        ปุ่มโหมดเปลี่ยนเป็น Ask และปุ่ม Start building หายไป เพราะ session ไม่อยู่ในโหมด Plan แล้ว
      sees: ปุ่มโหมดในช่องพิมพ์เป็น "Ask"
      ref: packages/extension/src/chat/modes.ts#modePicker

    - id: send
      lane: editor
      at: chat
      do: >-
        `startBuilding` ส่งข้อความคงที่ `START_BUILDING_PROMPT` ผ่านทางเดียวกับข้อความที่ผู้ใช้พิมพ์ `prompt()` ส่ง action `turn-start`
        แล้วส่งคำขอ ACP `session/prompt`
      sees: บับเบิลใหม่ "Go ahead with the plan." หัวข้อ "working"
      ref: packages/extension/src/chat/chat.ts#START_BUILDING_PROMPT
      emits: [turn-start]

    - id: accept
      lane: server
      at: turns
      do: >-
        `runTurn` รับเป็น turn ใหม่ที่ผู้ใช้ส่ง ล้างขีดจำกัดของรอบ และเรียก `runAgent` ด้วยโหมด Ask
      ref: packages/engine/src/serve.ts#runTurn
      phase: starting

    - id: record
      lane: loop
      at: drive
      do: >-
        `drive` บันทึก event `user` ของข้อความนี้
      ref: "packages/engine/src/drive.ts#\"await record({ kind: 'user', seq: nextSeq(events), at: new Date().toISOString(), content: prompt });\""
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
      do: >-
        `deliver()` บันทึก `notice` หนึ่งตัวที่รวมสองเรื่อง: `noticeFor` เห็นว่าโหมดเปลี่ยนจาก Plan เป็น Ask
        และ `todoReminder` เห็นว่ารายการยังไม่เสร็จหลัง prompt ที่ผู้ใช้พิมพ์ จึงแนบรายการเดิมมาด้วย
      ref: packages/engine/src/drive.ts#deliver
      emits: [notice]

    - id: carried
      lane: panel
      at: rail
      alongside: true
      do: >-
        turn ใหม่ยังไม่ได้ตั้งรายการของตัวเอง แผงจึงปักรายการที่ยังไม่เสร็จจาก turn ก่อนไว้ โดยไม่มีข้อไหนหมุน
      sees: กล่อง "0 of 5 done · from an earlier turn" ที่พับไว้
      ref: packages/extension/src/chat/todo-view.ts#todoStep

    - use: model-call

    - id: builds
      lane: model
      do: >-
        โมเดลอ่าน "[Geno] The user switched this session to Ask mode. You can change code ..." ตามด้วยรายการ todo ของแผน
        แล้วเริ่มแก้โค้ดตามขั้นแรก
      ref: packages/core/src/notice.ts#MODE_NOTICES
      end: { turn: continues, reason: call-model }
---

Start building คือทางลัดของสองอย่างที่ผู้ใช้ทำเองได้: สลับโหมดออกจาก Plan และส่งข้อความสั้นๆ ให้ลงมือ
แผนไม่ได้ถูกส่งซ้ำ มันอยู่ใน log แล้ว โมเดลเห็นแผนของตัวเองในบทสนทนา และเห็นรายการ todo ในประกาศ

สิ่งที่ควรสังเกต

- **โหมดที่ได้มาจากการตั้งค่า ไม่ใช่โหมดก่อน Plan** `startBuilding` ใช้ `gcode.approvalMode` ของแชตใหม่
  ถ้าผู้ใช้อยู่ใน Auto ก่อนสลับเป็น Plan การกดปุ่มนี้จะได้ Ask เว้นแต่การตั้งค่าเป็น Auto
- **รายการ todo เป็นสะพาน** ประกาศโหมด Plan ขอให้โมเดลเขียนขั้นตอนลงรายการ todo เมื่อเริ่มสร้าง รายการเดิมกลับมาพร้อมประกาศ
  และแผงแสดงรายการเดิมจนกว่าโมเดลจะตั้งรายการใหม่
- **ปุ่มอยู่เฉพาะ turn ล่าสุด** ถ้าผู้ใช้สลับโหมดออกจาก Plan เองหรือส่งข้อความอื่นก่อน ปุ่มหายไป
