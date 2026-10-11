---
title: engine หยุดขณะลูกทำงาน แล้ว Resume
description: engine ตายระหว่างที่ worker กำลังทำงาน engine ตัวใหม่ปิดงานที่ค้างใน log บอก session ว่าลูกถูกตัด แล้วผู้ใช้กด Resume ในแผง Tasks ให้ลูกทำต่อจาก transcript ของตัวเอง
tableOfContents: false
sidebar:
  order: 10
scenario:
  surface: vscode
  given:
    - turn ของแม่รอรายงานจาก `worker` แบบรอ (ไม่ใช่เบื้องหลัง) worker แก้ไปสองไฟล์และกำลังรัน `pnpm test`
    - หน้าต่าง VS Code ยังเปิดอยู่
  trigger: >-
    process ของ engine จบลงกลางทาง เช่นถูก kill หรือ crash
  covers: [sub.cut-off-by-engine-stop]
  related: [sub.message-finished-resume, err.engine-crash-restart, sess.reload-while-running, bg.task-attention]
  steps:
    - id: dies
      lane: server
      at: turns
      do: >-
        engine หยุดทันที ไม่มีใครเขียนอะไรต่อ log ของลูกมี `child-start` ที่จด pid ของ engine (`by`) แต่ไม่มี `child-end`
        call ที่ลูกค้างไว้ไม่มีผล และ call `agent` ของแม่ก็ไม่มีผล
      ref: packages/core/src/interrupted.ts#openRunsOf
      phase: running-tools

    - id: closed
      lane: editor
      at: engine-link
      do: >-
        socket ปิด extension เขียน "engine: connection closed" ลง output channel แล้วตั้งเวลาต่อใหม่
        คำขอ `session/prompt` ที่ค้างอยู่ล้มเหลว `prompt()` จึงส่ง action `error` และ `turn-end` สถานะ `failed`
      ref: "packages/extension/src/chat/chat.ts#\"this.dispatch({ type: 'turn-end', at: Date.now(), status: 'failed', usage: undefined });\""
      emits: [error, turn-end]

    - id: failed
      lane: panel
      at: rail
      alongside: true
      do: >-
        turn ขึ้นแถบ error กับหัวข้อ "failed after ..." แถวของ worker ถูกปิดเป็น Cancelled ไปพร้อม turn
      sees: แถบ error สีแดงพร้อมข้อความ error ของคำขอที่ล้มเหลว หัวข้อ "failed after 2m 10s" และแถว worker ขึ้น Cancelled
      ref: packages/extension/src/chat/render.ts#errorBlock
      phase: idle

    - id: relaunch
      lane: editor
      at: engine-link
      do: >-
        หลังรอครู่หนึ่ง `restart` ต่อ socket ใหม่ ไม่มี engine ฟังอยู่ `launch` จึงเปิด `gcode serve` ตัวใหม่แล้วส่ง `initialize`
      ref: packages/extension/src/chat/engine.ts#Engine.launch
      emits: [initialize]

    - id: recover
      lane: server
      at: sessions
      do: >-
        การเชื่อมต่อแรกของ process นี้เรียก `takeUpWaits` ซึ่งเริ่มจาก `recoverInterrupted`: ถือ lock ของโฟลเดอร์ sessions
        หา run ของลูกที่เปิดค้างโดย engine ที่ pid ไม่อยู่แล้วและทำงานในโฟลเดอร์เดียวกัน
      ref: packages/engine/src/interrupted.ts#recoverInterrupted

    - id: child-answered
      lane: child@worker
      at: loop
      do: >-
        ใน log ของลูก call ที่ค้าง (`pnpm test`) ได้ผลว่า "[Geno stopped] Geno stopped while this call ran, so it may have partly run and its result is lost."
      ref: packages/core/src/interrupted.ts#INTERRUPTED_CALL
      emits: [tool-result]

    - id: parent-told
      lane: loop
      at: drive
      do: >-
        ใน log ของแม่ call `agent` ได้ผลแบบเดียวกัน ตามด้วยโน้ต `wake` ชนิด `interrupted` ครั้งเดียวต่อ run:
        ลูกตัวไหนถูกตัด รายงานเท่าที่มี และวิธีทำต่อด้วย `message_agent` โน้ตนี้ไปกับ turn ถัดไป ไม่ปลุก session
        แล้วจึงบันทึก `child-end` แบบ `interrupted`
      ref: packages/core/src/interrupted.ts#interruptedText
      emits: [wake, interrupted, child-end]

    - id: task-row
      lane: server
      at: tasks
      do: >-
        `tasks.interrupted` ใส่รายชื่อลูกที่ถูกตัดไว้ในงานของ session นี้ และ engine เขียนลง output channel ว่า
        session นี้มี subagent 1 ตัวถูกตัดเมื่อ engine ตัวก่อนหยุด
      ref: packages/engine/src/tasks.ts#Tasks.interrupted
      emits: [_gcode/taskUpdate]

    - id: shown
      lane: panel
      at: tasks
      do: >-
        แผง Tasks แสดงงานของ session พร้อมรายการลูกที่ถูกตัด แต่ละตัวมีข้อความล่าสุดของมัน ช่องข้อความ และปุ่ม Resume
        ปุ่มขึ้นเฉพาะตอนที่ session ไม่มี turn ทำงาน
      sees: >-
        ป้าย "Cut off" ใต้งาน แถว "worker: <สรุปสิ่งที่ทำไปแล้ว>" ช่องข้อความที่มีค่า "Continue where you stopped." และปุ่ม [Resume]
      ref: "packages/extension/src/chat/lanes-panel.ts#\"function interruptedItem(\""

    - id: resume
      lane: user
      do: ผู้ใช้อ่านแล้วกด Resume โดยไม่แก้ข้อความ

    - id: ask
      lane: editor
      at: chat
      do: >-
        `task-resume` เปิดแชตของ session นั้น แล้ว `resumeAgent` ส่ง `session/prompt` ที่ข้อความคือ "Continue where you stopped."
        และ `_meta` `gcode/resumeAgent` คือ session id ของ worker
      ref: "packages/extension/src/chat/chat.ts#\"async resumeAgent(child: string, text: string)\""
      emits: [session/prompt, gcode/resumeAgent]

    - id: issued
      lane: loop
      at: agent
      do: >-
        `runTurn` ส่ง id นี้ให้ `runAgent` ซึ่งใช้ `resumeCall` สร้าง call `message_agent` ในนามผู้ใช้ (`issuedBy: user`)
        turn นี้จึงไม่เรียกโมเดลของแม่ก่อนรัน call
      ref: packages/engine/src/subagents.ts#resumeCall
      emits: [message_agent]
      phase: running-tools

    - id: reopen
      lane: child@worker
      at: loop
      do: >-
        `resumable` เห็นว่า run ล่าสุดของลูกจบแบบ `interrupted` จึงต่อ log ของลูกด้วยข้อความจากแม่ที่มีหมายเหตุว่า
        Geno หยุดระหว่างที่ลูกทำงาน call ที่ค้างไม่มีผล ให้ทำต่อจากที่ transcript จบ ลูกได้เพดานชุดใหม่
      ref: packages/core/src/steer.ts#resumeEvent
      emits: [user]

    - id: row
      lane: panel
      at: rail
      do: >-
        แถวของ worker ขึ้นใหม่ใต้ขั้นของ `message_agent` และป้าย Cut off ของแผง Tasks หายไปเพราะลูกเริ่มรันอีกครั้ง
      sees: แถว "worker · <โมเดล> · 0:01" พร้อมไดโนเสาร์ที่ขยับ
      ref: packages/extension/src/chat/subagent-view.ts#childRow

    - id: works
      lane: child@worker
      at: model
      do: >-
        ลูกอ่าน transcript ของตัวเอง เห็นว่า `pnpm test` ไม่มีผล จึงรันใหม่ แล้วเรียก `report`
      ref: packages/engine/src/subagents.ts#reportExecutor
      emits: [report]

    - id: result
      lane: loop
      at: tools
      do: >-
        worker เดิมเป็นลูกแบบรอ call `message_agent` จึงรอและได้รายงานใหม่ในรั้วเป็นผล แล้วบันทึก `child-end`
      ref: packages/core/src/subagent.ts#childReport
      emits: [tool-result, child-end]

    - id: ends
      lane: loop
      at: step
      do: >-
        `loopStep` ตัดสิน `call-model` แต่ director ที่ออก call นี้ไม่มีอะไรจะออกอีก run จึงจบ `end_turn` โดยไม่เรียกโมเดลของแม่
        รายงานกับโน้ต `interrupted` รออยู่ใน log ให้โมเดลอ่านใน turn ถัดไปของผู้ใช้
      ref: "packages/engine/src/drive.ts#\"if (issued === undefined) return end('end_turn');\""
      emits: [end_turn]
      phase: ending

    - id: footer
      lane: panel
      at: rail
      do: >-
        turn จบแบบ done ผู้ใช้อ่านรายงานของ worker ได้จากผลของขั้น `message_agent`
      sees: หัวข้อ "worked for 1m 4s" ขั้น "message_agent ..." และแถว worker ขึ้น Done
      ref: packages/extension/src/chat/rail.ts#headerOf
      end: { turn: done, reason: end_turn }
---

engine เก็บสถานะของลูกที่กำลังรันไว้ในหน่วยความจำ เมื่อ process ตาย สิ่งที่เหลือคือ log
engine ตัวถัดไปอ่าน log แล้วปิดสิ่งที่ค้างให้ครบ ทุก call มีผล ทุก run มีจุดจบ แต่ไม่รันอะไรแทนผู้ใช้

สิ่งที่ควรสังเกต

- **ไม่มีอะไรทำต่อเอง** โน้ต `interrupted` ไม่ปลุก session ผู้ใช้ต้องกด Resume หรือโมเดลต้องเรียก `message_agent` เอง
- **บอกครั้งเดียว** engine สองตัวที่เริ่มพร้อมกันแย่งกันด้วย lock และ run ที่อยู่ในโน้ตแล้วไม่ถูกบอกซ้ำ ถ้า engine ตายกลางการปิด รอบถัดไปปิดต่อได้
- **ลูกของ workflow** ถ้าลูกที่ถูกตัดเป็นขั้นของ workflow โน้ตไปที่ session ที่เริ่ม workflow และบอกว่ารายงานของ workflow จะไม่มา
- **Resume ไม่เรียกโมเดลของแม่** turn ที่ Resume สร้างจบทันทีหลังลูกรายงาน ถ้าอยากให้แม่สรุป ผู้ใช้ต้องส่งข้อความต่อ
