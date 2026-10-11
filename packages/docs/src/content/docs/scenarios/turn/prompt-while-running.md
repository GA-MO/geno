---
title: ส่งข้อความซ้อนขณะ turn ทำงาน
description: อีกหน้าต่างหนึ่งส่ง session/prompt ถึงแชตที่มี turn ทำงานอยู่ engine ปฏิเสธทันที turn เดิมไม่ถูกแตะ
tableOfContents: false
sidebar:
  order: 3
scenario:
  surface: vscode
  given:
    - เปิดโฟลเดอร์เดียวกันไว้สองหน้าต่าง ทั้งสองต่อ engine ตัวเดียวกัน เพราะที่อยู่ socket มาจากโฟลเดอร์และการตั้งค่า
    - หน้าต่าง A เริ่ม turn ในแชตหนึ่ง และ turn นั้นยังทำงานอยู่
    - หน้าต่าง B แสดงแชตเดียวกัน แต่แผงของ B ไม่ได้ถือ turn นั้น ปุ่มของ B จึงยังเป็น Send
  trigger: >-
    ผู้ใช้พิมพ์ข้อความในแผงของหน้าต่าง B แล้วกด Enter
  covers: [turn.prompt-while-running]
  related: [ctl.queued-followup, ctl.steer-delivered, sess.leave-running]
  steps:
    - id: type
      lane: user
      do: ผู้ใช้พิมพ์ข้อความในหน้าต่าง B แล้วกด Enter
      phase: idle

    - id: send
      lane: panel
      at: composer
      do: >-
        `submit()` ของแผง B ไม่เห็น turn ที่ทำงาน จึงโพสต์ `send` ไปให้ extension host ทันที แทนที่จะเข้าคิว
      ref: packages/extension/src/chat/webview.ts#submit
      emits: [send]

    - id: turn-start
      lane: editor
      at: chat
      do: >-
        `Chat` ของหน้าต่าง B ไม่ได้ถือ turn ใด (`this.turn` ว่าง) จึงผ่านการตรวจของตัวเอง
        `prompt()` ส่ง action `turn-start` ให้แผง แล้วส่งคำขอ ACP `session/prompt`
      sees: บับเบิลข้อความใหม่ในหน้าต่าง B หัวข้อเป็น "working" และปุ่ม Stop มาแทน Send
      ref: packages/extension/src/chat/chat.ts#Chat.prompt
      emits: [turn-start, session/prompt]
      phase: starting

    - id: refuse
      lane: server
      at: turns
      do: >-
        `runTurn` เห็นว่าทะเบียน `turns` มี `AbortController` ของ session นี้อยู่แล้ว จึงโยน `invalidRequest`
        "a turn is already running" ก่อนอ่าน log ไม่มีอะไรถูกบันทึก ไม่เปิดงานใน Tasks และ turn ของหน้าต่าง A ทำงานต่อโดยไม่รู้เรื่อง
      ref: "packages/engine/src/serve.ts#\"if (turns.get(sessionId) !== undefined) throw acp.RequestError.invalidRequest({ sessionId }, 'a turn is already running');\""
      emits: [a turn is already running]
      phase: ending

    - id: failed
      lane: editor
      at: chat
      do: >-
        คำขอ `session/prompt` ถูกปฏิเสธ `prompt()` จับ error แล้วส่ง action `error` ด้วยข้อความของมัน
        ตามด้วย `turn-end` สถานะ `failed`
      ref: "packages/extension/src/chat/chat.ts#\"this.dispatch({ type: 'error', message: error instanceof Error ? error.message : String(error) });\""
      emits: [error, turn-end]

    - id: shown
      lane: panel
      at: rail
      do: >-
        turn ใหม่ในแผง B จบเป็น failed พร้อมแถบ error ข้อความของผู้ใช้ไม่ได้ไปถึงโมเดล ผู้ใช้ต้องรอให้ turn ของหน้าต่าง A จบแล้วส่งใหม่
      sees: >-
        แถบ error สีแดง "Invalid request: a turn is already running" หัวข้อ "failed after 0.1s" และปุ่ม Send กลับมา
      ref: packages/extension/src/chat/render.ts#errorBlock
      end: { turn: failed, reason: a turn is already running }
---

engine ยอมให้แต่ละ session มี turn ได้ทีละหนึ่ง ทะเบียน `turns` ใน `serve.ts` คือตัวกั้น
ภายในหน้าต่างเดียว ข้อความที่พิมพ์ระหว่าง turn ทำงานไม่มาถึงจุดนี้ เพราะแผงเก็บเป็นข้อความ Queued
หรือส่งเป็น steer ด้วย Send now ดู [พิมพ์ต่อคิวไว้ขณะเทิร์นทำงาน](/scenarios/ctl/queued-followup/)

สิ่งที่ควรสังเกต

- **มีตัวกั้นสองชั้น** `Chat.prompt` ใน extension โยน "a turn is already running; stop it first" เมื่อแผงเดียวกันถือ turn อยู่แล้ว
  เช่นเมื่อ Cmd-K เรียก `prompt()` ระหว่าง turn ส่วน engine กั้นทุก client ที่ต่อเข้ามา ไม่ว่าหน้าต่างไหนหรือ editor ACP ตัวไหน
- **ไม่มีอะไรเข้า log** การปฏิเสธเกิดก่อน `openSessionLog` ข้อความที่ถูกปฏิเสธจึงไม่อยู่ในประวัติของแชต
  การ reload หน้าต่าง B จะไม่เห็นข้อความนั้นและไม่เห็นแถบ error
- **แผง B แสดงเป็น turn ที่ล้ม** `turn-start` เกิดก่อนติดต่อ engine แผงจึงวาด turn ใหม่ไว้แล้ว เมื่อถูกปฏิเสธ turn นั้นจบเป็น failed
  ข้อความของผู้ใช้ไม่กลับไปที่ช่องพิมพ์
