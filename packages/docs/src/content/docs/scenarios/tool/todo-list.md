---
title: อัปเดตรายการ todo
description: โมเดลตั้งรายการงานด้วย todo แผงแชตปักรายการไว้ท้าย turn ทันทีที่ call จบ และ harness เตือนโมเดลถ้าไม่อัปเดตนาน
tableOfContents: false
sidebar:
  order: 7
scenario:
  surface: vscode
  given:
    - turn กำลังทำงานกับงานหลายขั้น และยังไม่มีรายการ todo
  trigger: >-
    โมเดลขอเรียก `todo` พร้อม `read src/date.ts` ในคำตอบเดียว รายการมีสี่ข้อ ข้อแรก `done` ข้อที่สอง "Write tests" เป็น `in_progress`
  covers: [tool.todo-list]
  related: [tool.parallel-read-batch, turn.with-tools, perm.plan-start-building]
  steps:
    - id: asks
      lane: model
      do: >-
        โมเดลส่ง `todo` ที่มี `items` สี่ข้อ (แต่ละข้อมี `id` `text` และ `status`) และ `read` อีกหนึ่ง call จบด้วย `stop_reason: tool_use`
      ref: "packages/engine/src/gateway.ts#\"stopReason: message.stop_reason,\""
      emits: [tool_use]
      phase: calling-model

    - id: logged
      lane: loop
      at: drive
      do: >-
        `drive` บันทึก event `assistant` ที่มีบล็อก `tool_use` ทั้งสองลง log
      ref: "packages/engine/src/drive.ts#\"await record({ kind: 'assistant', seq: nextSeq(events), at, ...result.turn\""
      emits: [assistant]

    - use: tool-call-opens

    - id: parse
      lane: tool
      at: executor
      do: >-
        `todo` รันพร้อม `read` ได้เพราะไม่เปลี่ยนอะไรและไม่ถามใคร `parseTodo` ตรวจรายการ: ไม่เกินจำนวนที่กำหนด
        `id` ไม่ซ้ำ และ `in_progress` มีได้ข้อเดียว ถ้าผิดกฎข้อใด call ล้มเหลวพร้อมบอกว่าผิดตรงไหน
        รอบนี้ผ่าน ผลคือรายการทั้งหมดและข้อความ "Updated the todo list: 1 of 4 done, \"Write tests\" in progress."
      ref: packages/core/src/todo.ts#parseTodo

    - id: early
      lane: server
      at: updates
      do: >-
        ทันทีที่ `todo` จบ `watcher.toolEnd` ส่ง `tool_call_update` ที่มีรายการใน `TODO_META`
        ไม่ต้องรอให้ `read` ในชุดเดียวกันจบหรือให้ผลลง log
      ref: "packages/engine/src/serve.ts#\"toolEnd(use, status, todo) {\""
      emits: [tool_call_update, TODO_META]

    - id: relay
      lane: editor
      at: chat
      alongside: true
      do: >-
        `actionOf` อ่าน `TODO_META` แล้วใส่รายการลงใน action ของขั้นนั้น
      ref: packages/extension/src/chat/session-updates.ts#actionOf

    - id: pinned
      lane: panel
      at: rail
      alongside: true
      do: >-
        `railOf` ไม่วาด `todo` เป็นขั้นของเครื่องมือ แต่ปักรายการล่าสุดไว้ก่อนขั้นสุดท้ายของ turn ที่กำลังทำงาน และเปิดรายการไว้
      sees: >-
        กล่อง "1 of 4 done · write tests" ข้อที่เสร็จมีเครื่องหมายถูก ข้อ "Write tests" มีไอคอนหมุน ข้อที่เหลือเป็นวงกลมว่าง
      ref: packages/extension/src/chat/todo-view.ts#todoStep

    - use: tool-result-returns

    - id: next
      lane: loop
      at: step
      do: >-
        `loopStep` เห็น `tool-result` ล่าสุดจึงตัดสิน `call-model` ถ้า loop เรียกโมเดลไป 10 ครั้งโดยที่โมเดลไม่อัปเดตรายการที่ยังไม่เสร็จ
        `deliver()` จะเพิ่ม `notice` ที่แนบรายการมาเตือน (`todoReminder`)
      ref: packages/core/src/loop.ts#todoReminder
      emits: [call-model]
      phase: calling-model
      end: { turn: continues, reason: call-model }
---

รายการ todo เป็นของ session ไม่ใช่ของเครื่องมือ `todo` ไม่เก็บอะไรไว้ในหน่วยความจำ
รายการล่าสุดคือผลของ call `todo` ล่าสุดใน log แผงแชต การ replay และคำเตือนอ่านจากที่เดียวกัน

| เมื่อไร | แผงแสดงรายการอย่างไร |
| --- | --- |
| turn กำลังทำงาน | ปักไว้ก่อนขั้นสุดท้าย เปิดอยู่ |
| turn จบแล้ว | อยู่ใน turn นั้นเป็นแถวเดียวที่พับไว้ |
| turn ใหม่เริ่มโดยยังไม่ตั้งรายการ | แสดงรายการของ turn ก่อนที่ยังไม่เสร็จ พร้อมคำว่า "from an earlier turn" |

สิ่งที่ควรสังเกต

- **รายการไปถึงแผงก่อนผลอื่น** สถานะจบของ call ส่งทันทีที่ call จบ และ `todo` ฝากรายการมากับสถานะนั้น
  ผู้ใช้จึงเห็นความคืบหน้าแม้ call อื่นในชุดยังทำงาน
- **เตือนเมื่อรายการค้าง** นอกจากเตือนหลัง 10 ครั้งแล้ว ถ้าผู้ใช้พิมพ์ prompt ใหม่ขณะที่รายการยังไม่เสร็จ
  การเรียกโมเดลครั้งแรกของ turn ใหม่ได้รายการเดิมพร้อมบอกว่า turn ก่อนจบก่อนรายการเสร็จหรือไม่
- **ส่งรายการว่างคือการล้าง** `items: []` ได้ผล "Cleared the todo list." และแผงไม่ปักอะไร
