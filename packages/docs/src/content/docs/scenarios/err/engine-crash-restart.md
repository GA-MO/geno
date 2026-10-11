---
title: engine ตายแล้วเริ่มใหม่
description: process ของ engine จบกลาง turn แผงขึ้น error และ turn ล้ม หนึ่งวินาทีต่อมาหน้าต่างเปิด engine ใหม่ ซึ่งรับช่วงการรอและลูกที่ถูกตัด แต่ไม่ทำ turn ที่ตายต่อเอง
tableOfContents: false
sidebar:
  order: 4
scenario:
  surface: vscode
  given:
    - ผู้ใช้ส่งข้อความในแผงแชตของ VS Code และ turn กำลังทำงาน
    - engine (`gcode serve`) เป็น process แยกจาก VS Code และทุกหน้าต่างของโฟลเดอร์นี้ต่อ engine ตัวเดียวกัน
  trigger: >-
    process ของ engine จบกะทันหัน เช่นถูก kill หรือหน่วยความจำหมด
  covers: [err.engine-crash-restart]
  related: [err.offline-wait, err.exception-escapes-loop, sess.reload-while-running, start.open-window]
  steps:
    - id: dies
      lane: loop
      at: drive
      do: >-
        ทุกอย่างของ turn ที่อยู่ในหน่วยความจำหายไปพร้อม process: `AbortController` ข้อความที่กำลัง stream และคำสั่งที่กำลังรัน
        ที่เหลืออยู่คือ log ของ session ซึ่ง `record` เขียนทีละ event ถ้า process ตายกลางบรรทัด บรรทัดสุดท้ายจะขาด
        และการเขียนครั้งต่อไปตัดมันทิ้งด้วย `dropTornTail`
      ref: "packages/engine/src/drive.ts#\"await appendEvent(file, numbered);\""
      phase: ending

    - id: closed
      lane: editor
      at: engine-link
      do: >-
        socket ปิด `Engine` เขียน "engine: connection closed" ลง output channel ล้างการเชื่อมต่อปัจจุบัน
        แล้วตั้งเวลาเชื่อมใหม่ใน 1 วินาที
      ref: "packages/extension/src/chat/engine.ts#\"socket.on('close', () => {\""

    - id: rejected
      lane: editor
      at: chat
      do: >-
        ACP SDK ปฏิเสธทุกคำขอที่ค้างบนการเชื่อมต่อนั้นด้วย "ACP connection closed" รวมถึง `session/prompt` ของ turn นี้
        `prompt()` จับ error แล้วส่ง action `error` ตามด้วย `turn-end` สถานะ `failed`
      ref: "packages/extension/src/chat/chat.ts#\"this.dispatch({ type: 'error', message: error instanceof Error ? error.message : String(error) });\""
      emits: [error, turn-end]

    - id: shown
      lane: panel
      at: rail
      do: >-
        turn ในแผงจบเป็น failed ข้อความที่ stream มาแล้วยังค้างอยู่ ขั้นที่ยังหมุนเปลี่ยนเป็น cancelled
      sees: แถบ error สีแดง "ACP connection closed" หัวข้อ "failed after 34s" และปุ่ม Send กลับมา
      ref: packages/extension/src/chat/render.ts#errorBlock

    - id: restart
      lane: editor
      at: engine-link
      do: >-
        ครบ 1 วินาที `restart` ขอการเชื่อมต่อใหม่ ไม่มีอะไรฟังที่ socket เดิมแล้ว จึงเปิด engine ตัวใหม่
      ref: packages/extension/src/chat/engine.ts#Engine.restart

    - use: start-engine-connects

    - id: takeup
      lane: server
      at: sessions
      do: >-
        การเชื่อมต่อแรกของ engine ตัวใหม่เรียก `takeUpWaits`: `recoverInterrupted` ตอบ call ที่ค้างใน log ของเอเจนต์ลูกที่ถูกตัด
        บอก session แม่ด้วยโน้ต `interrupted` และให้แผง Tasks มีปุ่มให้ทำต่อ แล้วจึงหา session ที่ log จบด้วยการรอ
        และรับช่วงการปลุกที่ตั้งไว้
      ref: packages/engine/src/interrupted.ts#recoverInterrupted
      emits: [interrupted]
      fork:
        ask: log ของ turn ที่ตายจบด้วยอะไร
        options:
          - id: wait
            label: การรอเครือข่ายหรือ rate limit
            steps:
              - lane: server
                at: turns
                do: >-
                  `waitsLeft` พบว่า log จบด้วย event `wait` ที่ยังไม่ปิด engine จึงเปิด turn แบบ `resume` โดยไม่มี prompt ใหม่
                  งานของแชตกลับมาในแผง Tasks
                ref: "packages/engine/src/serve.ts#\"void runTurn(id, [], undefined, self(), 'resume')\""
                phase: waiting-retry
              - lane: loop
                at: gateway
                do: >-
                  `callModel` ส่งการรอที่ค้างให้ gateway การรอออฟไลน์ตรวจ host ทันที การรอ rate limit รอต่อจนถึงเวลาเดิม
                  แล้วการเรียกโมเดลจึงออกไปตามปกติ
                ref: "packages/engine/src/gateway.ts#\"if (input.waiting !== undefined) {\""
                end: { turn: continues, reason: call-model }

          - id: mid-turn
            label: การเรียกโมเดลหรือเครื่องมือที่ยังไม่จบ
            steps:
              - lane: server
                at: sessions
                do: >-
                  ไม่มีอะไรรับช่วง turn นี้ engine ใหม่ไม่ทำต่อเอง log ยังจบที่ prompt ที่ไม่มีคำตอบ หรือที่ `tool_use` ที่ไม่มีผล
                ref: packages/engine/src/serve.ts#takeUpWaits
              - lane: user
                do: ผู้ใช้ส่งข้อความถัดไป เช่น "ทำต่อ"
                phase: starting
              - lane: editor
                at: chat
                do: >-
                  การเชื่อมต่อนี้ยังไม่มี session `openSession` จึงส่ง `session/resume` ถึงแชตที่แผงแสดงอยู่ก่อน แล้วจึงส่ง `session/prompt`
                ref: packages/extension/src/chat/chat.ts#Chat.openSession
              - lane: loop
                at: step
                do: >-
                  `drive` บันทึก prompt ใหม่ แล้ว `loopStep` หา `tool_use` ของคำตอบล่าสุดที่ยังไม่มีผล ถ้า engine ตายขณะเครื่องมือรัน
                  call นั้นยังค้าง และไม่เข้าเงื่อนไขของ `unrunnable` จึงได้ `run-tools` คำสั่งเดิมรันอีกครั้งก่อนโมเดลจะเห็น prompt ใหม่
                  ถ้า engine ตายขณะเรียกโมเดล ได้ `call-model` และโมเดลเห็นทั้ง prompt เดิมและ prompt ใหม่
                ref: packages/core/src/loop.ts#pendingToolUses
                emits: [run-tools, call-model]
                phase: running-tools
                end: { turn: continues, reason: run-tools }
---

engine เป็น process ที่อยู่ต่อแม้หน้าต่างปิด สถานะทั้งหมดของ session อยู่ใน log
engine ตัวใหม่จึงรู้ทุกอย่างที่ถูกบันทึกแล้ว แต่ไม่รู้ว่า turn ไหนกำลังทำอะไรอยู่ตอนที่ตัวเก่าตาย

| สิ่งที่ค้างตอน engine ตาย | engine ตัวใหม่ทำอะไร |
| --- | --- |
| การรอเครือข่ายหรือ rate limit (`wait`) | เปิด turn แบบ `resume` ทันที |
| เอเจนต์ลูกที่กำลังทำงาน | ตอบ call ที่ค้างของลูกว่า "[Geno stopped] ..." บอกแม่ และให้ทำต่อได้จากแผง Tasks |
| การปลุกที่ตั้งไว้ | รับช่วงไปปลุกตามเวลา |
| turn ของแชตที่กำลังเรียกโมเดลหรือรันเครื่องมือ | ไม่ทำอะไร จนกว่าผู้ใช้จะส่งข้อความ |

สิ่งที่ควรสังเกต

- **call ที่ถูกตัดของแชตหลักรันซ้ำ** ลูกที่ถูกตัดได้คำตอบ `INTERRUPTED_CALL` ว่าอาจรันไปบางส่วน
  แต่ session หลักไม่ได้คำตอบแบบนั้น `tool_use` ที่ค้างจึงถูกรันใหม่เมื่อผู้ใช้ส่งข้อความถัดไป (ได้จากการอ่าน `loopStep` และ `recoverInterrupted` ไม่ได้รันจริง)
  คำสั่งที่มีผลข้างเคียง เช่นการ migrate ฐานข้อมูล อาจรันสองครั้ง ในโหมด Ask คำสั่งนอก safe list ยังต้องผ่านการ์ดอีกครั้ง
- **แผงบอกแค่ว่าการเชื่อมต่อปิด** "ACP connection closed" มาจาก ACP SDK ไม่ใช่จาก engine เหตุผลที่ engine ตายอยู่ในไฟล์ log
  ของ engine ที่ output channel "Geno engine" ชี้ไป
- **ข้อความที่ stream ค้างไม่อยู่ใน log** เหมือนการกด Stop กลาง stream การเปิดแชตใหม่จะไม่เห็นข้อความนั้น
