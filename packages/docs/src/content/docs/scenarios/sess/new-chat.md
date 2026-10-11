---
title: เริ่มแชทใหม่
description: ผู้ใช้กด New Chat Geno สร้าง session ใหม่ทันที แผงกลับเป็นหน้าเริ่มต้น และ turn ของแชตเดิมที่ยังทำงานไปต่อในเบื้องหลัง
tableOfContents: false
sidebar:
  order: 1
scenario:
  surface: vscode
  given:
    - แผงแชตแสดงแชตที่มี turn แล้วอย่างน้อยหนึ่ง turn
  trigger: >-
    ผู้ใช้คลิกปุ่ม New Chat (+) บนหัวแผง หรือพิมพ์ `/new` แล้วกด Enter
  covers: [sess.new-chat]
  related: [sess.open-history, sess.leave-running, start.new-session-context, start.open-window]
  steps:
    - id: click
      lane: user
      do: ผู้ใช้กดปุ่ม + บนหัวแผงแชต
      phase: idle

    - id: new-chat
      lane: editor
      at: vscode-ui
      do: >-
        ปุ่มรันคำสั่ง `gcode.chat.new` ซึ่งเรียก `Chat.newChat` (`/new` ไปถึงที่เดียวกันผ่านคำสั่งที่ editor ทำเอง)
        ถ้าแชตที่แสดงยังไม่มี turn เลย มันเป็นแชตใหม่อยู่แล้ว จึงไม่ทำอะไร
      ref: packages/extension/src/chat/chat.ts#Chat.newChat

    - id: leave
      lane: editor
      at: chat
      do: >-
        `moveTo` ดูว่าแชตเดิมมี turn ที่แผงนี้เริ่มไว้และยังทำงานอยู่หรือไม่
      ref: packages/extension/src/chat/chat.ts#Chat.moveTo
      fork:
        ask: turn ของแชตเดิมยังทำงานอยู่หรือไม่
        options:
          - id: idle
            label: ไม่มี turn ทำงาน
          - id: running
            label: ยังทำงานอยู่
            steps:
              - lane: editor
                at: chat
                do: >-
                  `leaveRunning` ปล่อย turn ไว้ การ์ดขออนุญาตและคำถามที่เปิดอยู่ถูกตอบว่า "ไม่ได้แสดง"
                  engine จะถามใหม่ในหน้าต่างถัดไปที่แสดง session นั้น แล้วส่งคำขอ ACP `_gcode/detach`
                ref: "packages/extension/src/chat/chat.ts#\"if (running !== undefined) await connection.agent.request<unknown, DetachRequest>(DETACH_METHOD\""
              - lane: server
                at: sessions
                do: >-
                  engine เลิกส่งอัปเดตของ session นั้นมาที่หน้าต่างนี้ turn ทำงานต่อจนจบ และยังเห็นได้ในแผง Tasks
                ref: "packages/engine/src/serve.ts#\".onRequest(DETACH_METHOD, sessionRequest, async ({ params }) => {\""

    - id: fresh
      lane: editor
      at: chat
      do: >-
        `fresh()` ส่งคำขอ ACP `session/new` พร้อมโฟลเดอร์และ MCP server จาก `mcp.json` ของผู้ใช้ใน VS Code
      ref: packages/extension/src/chat/chat.ts#Chat.fresh

    - id: start
      lane: server
      at: sessions
      do: >-
        engine สร้าง session ทันที โหลดไฟล์คำสั่ง หน่วยความจำ สกิล และสภาพแวดล้อม แล้วเขียน `session-start` เป็นบรรทัดแรกของ log
        จากนั้นลงทะเบียน session ให้หน้าต่างนี้แสดง และตอบ id โหมด และตัวเลือก effort
      ref: "packages/engine/src/serve.ts#\".onRequest(acp.methods.agent.session.new, async ({ params, client }) => {\""
      emits: [session-start]

    - id: show
      lane: editor
      at: chat
      do: >-
        `show` ตั้ง session ใหม่เป็นของแผง ส่ง action `reset` ที่บทสนทนาว่าง ล้างชื่อแชต จำ id ใหม่ไว้สำหรับหน้าต่างครั้งหน้า
        และแจ้งให้ review โหลดสถานะของ session ใหม่
      ref: packages/extension/src/chat/chat.ts#Chat.show
      emits: [reset]

    - id: page
      lane: panel
      at: rail
      do: >-
        บทสนทนาว่างจึงวาดหน้าเริ่มต้น หน้าเริ่มต้นขอรายการแชตของโปรเจกต์ใหม่ แชตที่เพิ่งออกมาจึงอยู่ในรายการ Continue
      sees: >-
        หน้าเริ่มต้นกับ Noodle คำว่า "geno" และรายการ "Continue" ที่มีแชตเดิมอยู่บนสุด ช่องพิมพ์ว่างและพร้อมพิมพ์
      ref: packages/extension/src/chat/start-page.ts#startPage

    - id: close
      lane: server
      at: sessions
      do: >-
        ถ้าแชตเดิมไม่มี turn ทำงาน `moveTo` ส่งคำขอ ACP `session/close` ให้ engine ปิด MCP server ของ session นั้น
        log ยังอยู่ เปิดจาก History ได้เสมอ ถ้า turn ยังทำงาน แชตเดิมไม่ถูกปิด
      ref: "packages/engine/src/serve.ts#\".onRequest(acp.methods.agent.session.close, async ({ params }) => {\""
      end: { turn: none }
---

New Chat ไม่ได้ลบอะไร แชตเดิมอยู่ใน log ของมันตามเดิม สิ่งที่เปลี่ยนคือ session ที่แผงแสดงและจำไว้

สิ่งที่ควรสังเกต

- **session ใหม่เกิดตอนกดปุ่ม** ไม่ใช่ตอนพิมพ์ข้อความแรก ไฟล์คำสั่งและหน่วยความจำจึงถูกอ่านตอนนี้
  ถ้าแก้ `AGENTS.md` หลังกด New Chat แต่ก่อนส่งข้อความ แชตนี้จะไม่เห็นการแก้
  ดู [โหลดคำสั่งโปรเจกต์ หน่วยความจำ และสกิล](/scenarios/start/new-session-context/)
- **กดซ้ำไม่สร้างแชตว่างซ้อน** ถ้าแชตที่แสดงยังไม่มี turn `newChat` ไม่ทำอะไร
- **turn ที่ปล่อยไว้** ทำงานต่อใน engine การ์ดขออนุญาตของมันไปรออยู่ที่แผง Tasks (ป้ายบนไอคอน Geno นับงานที่รอผู้ใช้)
  ผู้ใช้กลับไปเปิดแชตนั้นจาก Tasks หรือ History ได้
- **ข้อความที่รอในคิวไม่ถูกล้าง** ถ้าช่องพิมพ์มีข้อความ Queued ของแชตเดิมอยู่ ป้าย Queued ยังค้างในแชตใหม่
  ดู [พิมพ์ต่อคิวไว้ขณะเทิร์นทำงาน](/scenarios/ctl/queued-followup/)
