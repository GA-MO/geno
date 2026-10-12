---
title: "ส่ง prompt จากอีกหน้าต่างขณะ turn ยังทำงาน"
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
      beat:
        title: "คุณพิมพ์ในหน้าต่างที่สอง"
        text: >-
          คุณเปิดโฟลเดอร์เดียวกันไว้สองหน้าต่าง หน้าต่าง A มี turn ทำงานอยู่ คุณพิมพ์ข้อความในแชตเดียวกันจากหน้าต่าง B
          แล้วกด Enter
        from: you
        to: panel
      do: ผู้ใช้พิมพ์ข้อความในหน้าต่าง B แล้วกด Enter
      phase: idle

    - id: send
      lane: panel
      at: composer
      beat:
        title: "แผงของหน้าต่าง B ส่งข้อความทันที"
        text: >-
          แผงของ B ไม่รู้ว่าหน้าต่าง A มี turn ค้างอยู่ ปุ่มของมันยังเป็น Send
          มันจึงส่งข้อความต่อทันทีแทนที่จะเก็บไว้ในคิว
        from: panel
        to: panel
      do: >-
        `submit()` ของแผง B ไม่เห็น turn ที่ทำงาน จึงโพสต์ `send` ไปให้ extension host ทันที แทนที่จะเข้าคิว
      ref: packages/extension/src/chat/webview.ts#submit
      emits: [send]

    - id: turn-start
      lane: editor
      at: chat
      beat:
        title: "B เปิด turn ใหม่ในแชตแล้วขอ engine"
        text: >-
          หน้าต่าง B ไม่ได้ถือ turn ไหนอยู่ จึงผ่านการตรวจของตัวเอง แชตของ B ขึ้นข้อความของคุณกับปุ่ม Stop ทันที
          แล้วส่งคำขอเริ่ม turn ไปที่ engine ตัวเดียวกับที่หน้าต่าง A ใช้
        from: panel
        to: engine
        sees: { kind: composer, state: working, header: working }
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
      beat:
        title: "Geno ปฏิเสธเพราะมี turn ทำงานอยู่แล้ว"
        text: >-
          engine ยอมให้แต่ละ session มี turn ได้ทีละหนึ่ง มันเห็นว่า session นี้มี turn ของหน้าต่าง A อยู่
          จึงปฏิเสธทันที ไม่มีอะไรถูกบันทึก และ turn ของหน้าต่าง A ทำงานต่อโดยไม่รู้เรื่อง
        from: engine
        to: panel
      do: >-
        `runTurn` เห็นว่าทะเบียน `turns` มี `AbortController` ของ session นี้อยู่แล้ว จึงโยน `invalidRequest`
        "a turn is already running" ก่อนอ่าน log ไม่มีอะไรถูกบันทึก ไม่เปิดงานใน Tasks และ turn ของหน้าต่าง A ทำงานต่อโดยไม่รู้เรื่อง
      ref: "packages/engine/src/serve.ts#\"if (turns.get(sessionId) !== undefined) throw acp.RequestError.invalidRequest({ sessionId }, 'a turn is already running');\""
      emits: [a turn is already running]
      phase: ending

    - id: failed
      lane: editor
      at: chat
      beat:
        title: "หน้าต่าง B ได้ error กลับมา"
        text: >-
          คำขอของ B ถูกปฏิเสธ VS Code รับ error นั้นแล้วบอกแผงว่า turn ใหม่นี้ล้มเหลว
        from: panel
        to: panel
      do: >-
        คำขอ `session/prompt` ถูกปฏิเสธ `prompt()` จับ error แล้วส่ง action `error` ด้วยข้อความของมัน
        ตามด้วย `turn-end` สถานะ `failed`
      ref: "packages/extension/src/chat/chat.ts#\"this.dispatch({ type: 'error', message: error instanceof Error ? error.message : String(error) });\""
      emits: [error, turn-end]

    - id: shown
      lane: panel
      at: rail
      beat:
        title: "แชตของ B ขึ้นแถบ error"
        text: >-
          turn ใหม่ใน B จบเป็น failed ภายในเสี้ยววินาที ข้อความของคุณไม่ได้ไปถึง model และไม่กลับไปที่ช่องพิมพ์
          คุณต้องรอให้ turn ของหน้าต่าง A จบแล้วส่งใหม่
        from: panel
        to: you
        end: "B ถูกปฏิเสธ turn ของ A ทำต่อ"
        sees: { kind: notice, text: "Invalid request: a turn is already running", tone: error }
      do: >-
        turn ใหม่ในแผง B จบเป็น failed พร้อมแถบ error ข้อความของผู้ใช้ไม่ได้ไปถึง model ผู้ใช้ต้องรอให้ turn ของหน้าต่าง A จบแล้วส่งใหม่
      sees: >-
        แถบ error สีแดง "Invalid request: a turn is already running" หัวข้อ "failed after" ตามด้วยเวลาไม่ถึงวินาทีเป็นมิลลิวินาที เช่น "failed after 90ms" และปุ่ม Send กลับมา
      ref: packages/extension/src/chat/render.ts#errorBlock
      end: { turn: failed, reason: a turn is already running }
---

engine ยอมให้แต่ละ session มี turn ได้ทีละหนึ่ง ทะเบียน `turns` ใน `serve.ts` คือตัวกั้น
ภายในหน้าต่างเดียว ข้อความที่พิมพ์ระหว่าง turn ทำงานไม่มาถึงจุดนี้ เพราะแผงเก็บเป็นข้อความ Queued
หรือส่งเป็น steer ด้วย Send now ดู [พิมพ์ข้อความถัดไปเข้าคิวขณะ turn ทำงาน](/scenarios/ctl/queued-followup/)

สิ่งที่ควรสังเกต

- **มีตัวกั้นสองชั้น** `Chat.prompt` ใน extension โยน "a turn is already running; stop it first" เมื่อแผงเดียวกันถือ turn อยู่แล้ว
  เช่นเมื่อ Cmd-K เรียก `prompt()` ระหว่าง turn ส่วน engine กั้นทุก client ที่ต่อเข้ามา ไม่ว่าหน้าต่างไหนหรือ editor ACP ตัวไหน
- **ไม่มีอะไรเข้า log** การปฏิเสธเกิดก่อน `openSessionLog` ข้อความที่ถูกปฏิเสธจึงไม่อยู่ในประวัติของแชต
  การ reload หน้าต่าง B จะไม่เห็นข้อความนั้นและไม่เห็นแถบ error
- **แผง B แสดงเป็น turn ที่ล้ม** `turn-start` เกิดก่อนติดต่อ engine แผงจึงวาด turn ใหม่ไว้แล้ว เมื่อถูกปฏิเสธ turn นั้นจบเป็น failed
  ข้อความของผู้ใช้ไม่กลับไปที่ช่องพิมพ์

ถ้าข้อความถูกพิมพ์ในหน้าต่างเดียวกับที่ turn ทำงานอยู่ ดู [ส่งข้อความแทรก (steer) เข้า turn ที่กำลังทำงาน](/scenarios/ctl/steer-delivered/)
