---
title: "Model อัปเดตรายการ todo"
description: model ตั้งรายการงานด้วย todo แผงแชตปักรายการไว้ท้าย turn ทันทีที่ call จบ และ harness เตือน model ถ้าไม่อัปเดตนาน
scenario:
  surface: vscode
  given:
    - turn กำลังทำงานกับงานหลายขั้น และยังไม่มีรายการ todo
  trigger: >-
    model ขอเรียก `todo` พร้อม `read src/date.ts` ในคำตอบเดียว รายการมีสี่ข้อ ข้อแรก `done` ข้อที่สอง "Write tests" เป็น `in_progress`
  covers: [tool.todo-list]
  related: [tool.parallel-read-batch, turn.with-tools, perm.plan-start-building]
  steps:
    - id: asks
      lane: model
      beat:
        title: "Model ตั้งรายการ todo พร้อมอ่านไฟล์"
        text: >-
          งานนี้มีหลายขั้น model ส่งรายการสี่ข้อ ข้อแรกเสร็จ ข้อ "Write tests" กำลังทำ พร้อมขออ่าน `src/date.ts`
          ในคำตอบเดียว run จริงด้านล่างส่ง todo กับ read คู่กันแบบนี้
        from: model
        to: engine
        sees:
          kind: payload
          source: docs/results/real-usecases/runs/B09-stop-and-resume-thai/1/session-c35ff8bd-d9bb-4d36-aff0-e5a554dff67f.jsonl#seq=10
          select: content
          collapse:
            - "[0].thinking"
      do: >-
        model ส่ง `todo` ที่มี `items` สี่ข้อ (แต่ละข้อมี `id` `text` และ `status`) และ `read` อีกหนึ่ง call จบด้วย `stop_reason: tool_use`
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
      beat:
        title: "Geno จัด todo กับ read ไว้ชุดเดียว"
        text: >-
          todo ไม่เปลี่ยนอะไรบนเครื่องและไม่ถามใคร จึงรันพร้อมการอ่านไฟล์ได้
        from: engine
        to: engine

    - id: parse
      lane: tool
      at: executor
      beat:
        title: "Geno ตรวจรายการ"
        text: >-
          รายการต้องไม่ยาวเกินกำหนด id ไม่ซ้ำ และมีข้อที่กำลังทำได้ข้อเดียว ถ้าผิด call ล้มเหลวพร้อมบอกว่าผิดตรงไหน
          รอบนี้ผ่าน ผลสรุปว่าเสร็จกี่ข้อและข้อไหนกำลังทำ แบบในผลจาก run จริงด้านล่าง
        from: engine
        to: engine
        sees:
          kind: payload
          source: docs/results/real-usecases/runs/A19-poteto-thai/1/requests.jsonl#seq=35
          select: messages[-1].content[0]
          highlight:
            - content
      do: >-
        `todo` รันพร้อม `read` ได้เพราะไม่เปลี่ยนอะไรและไม่ถามใคร `parseTodo` ตรวจรายการ: ไม่เกินจำนวนที่กำหนด
        `id` ไม่ซ้ำ และ `in_progress` มีได้ข้อเดียว ถ้าผิดกฎข้อใด call ล้มเหลวพร้อมบอกว่าผิดตรงไหน
        รอบนี้ผ่าน ผลคือรายการทั้งหมดและข้อความ "Updated the todo list: 1 of 4 done, \"Write tests\" in progress."
      ref: packages/core/src/todo.ts#parseTodo

    - id: early
      lane: server
      at: updates
      beat:
        title: "Geno ส่งรายการไปที่แชตทันที"
        text: >-
          ทันทีที่ todo จบ Geno ส่งรายการไปที่แชต ไม่ต้องรอให้การอ่านไฟล์ในชุดเดียวกันจบ
        from: engine
        to: panel
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
      beat:
        title: "แชตปักรายการไว้ท้าย turn"
        text: >-
          todo ไม่ขึ้นเป็นขั้นของ tool แต่แชตปักรายการล่าสุดไว้ก่อนขั้นสุดท้ายของ turn และเปิดไว้ให้เห็น
        from: panel
        to: you
        sees: "กล่อง \"1 of 4 done · write tests\" ข้อที่เสร็จมีเครื่องหมายถูก ข้อ \"Write tests\" มีไอคอนหมุน ข้อที่เหลือเป็นวงกลมว่าง"
      alongside: true
      do: >-
        `railOf` ไม่วาด `todo` เป็นขั้นของ tool แต่ปักรายการล่าสุดไว้ก่อนขั้นสุดท้ายของ turn ที่กำลังทำงาน และเปิดรายการไว้
      sees: >-
        กล่อง "1 of 4 done · write tests" ข้อที่เสร็จมีเครื่องหมายถูก ข้อ "Write tests" มีไอคอนหมุน ข้อที่เหลือเป็นวงกลมว่าง
      ref: packages/extension/src/chat/todo-view.ts#todoStep

    - use: tool-result-returns

    - id: next
      lane: loop
      at: step
      beat:
        title: "Model ทำต่อ Geno เตือนถ้าลืมอัปเดต"
        text: >-
          Geno เรียก model ต่อ ถ้าเรียกไป 10 ครั้งโดยที่ model ไม่อัปเดตรายการที่ยังไม่เสร็จ Geno แนบรายการมาเตือน
        from: engine
        to: model
        end: "model ทำต่อ"
      do: >-
        `loopStep` เห็น `tool-result` ล่าสุดจึงตัดสิน `call-model` ถ้า loop เรียก model ไป 10 ครั้งโดยที่ model ไม่อัปเดตรายการที่ยังไม่เสร็จ
        `deliver()` จะเพิ่ม `notice` ที่แนบรายการมาเตือน (`todoReminder`)
      ref: packages/core/src/loop.ts#todoReminder
      emits: [call-model]
      phase: calling-model
      end: { turn: continues, reason: call-model }
---

รายการ todo เป็นของ session ไม่ใช่ของ tool `todo` ไม่เก็บอะไรไว้ในหน่วยความจำ
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
  การเรียก model ครั้งแรกของ turn ใหม่ได้รายการเดิมพร้อมบอกว่า turn ก่อนจบก่อนรายการเสร็จหรือไม่
- **ส่งรายการว่างคือการล้าง** `items: []` ได้ผล "Cleared the todo list." และแผงไม่ปักอะไร

อ่านต่อที่ [Model อ่านหลายไฟล์พร้อมกัน](/scenarios/tool/parallel-read-batch/)
