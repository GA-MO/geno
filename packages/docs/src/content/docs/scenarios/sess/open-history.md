---
title: "เปิดแชตเก่าจาก History"
description: ผู้ใช้เปิดรายการแชต เลือกแชตเก่า engine เล่น log ซ้ำให้แผงวาดบทสนทนาทั้งหมด แชตของโปรเจกต์อื่นเปิดในหน้าต่างใหม่
tableOfContents: false
sidebar:
  order: 2
scenario:
  surface: vscode
  given:
    - แผงแชตเปิดอยู่ และ engine เชื่อมต่อแล้ว
    - มีแชตเก่าทั้งของโปรเจกต์นี้และของโปรเจกต์อื่นในเครื่อง
  trigger: >-
    ผู้ใช้คลิกปุ่ม Chat History (นาฬิกา) บนหัวแผง แล้วเลือกแชตหนึ่งแชต
  covers: [sess.open-history]
  related: [sess.new-chat, start.open-window, sess.reload-while-running, sess.history-manage]
  steps:
    - id: click
      beat:
        title: คุณกดปุ่ม Chat History
        text: แผงเปิด History ในขอบเขต "This project" `/history` ทำแบบเดียวกัน
        from: you
        to: panel
      lane: user
      do: ผู้ใช้กดปุ่ม Chat History บนหัวแผง
      phase: idle

    - id: open-list
      lane: editor
      at: vscode-ui
      do: >-
        คำสั่ง `gcode.chat.history` โฟกัสแผงแล้วส่ง `show-history` ให้ webview (`/history` ทำแบบเดียวกัน)
      ref: packages/extension/src/chat/chat.ts#Chat.showHistory
      emits: [show-history]

    - id: ask-list
      beat:
        title: แชตขอรายการแชต
        text: engine อ่านชื่อ จำนวน turn ค่าใช้จ่าย และเวลาจาก log ของแต่ละแชต
        from: panel
        to: engine
      lane: panel
      at: rail
      do: >-
        แผง History เปิดในขอบเขต "This project" และขอรายการด้วย `list-sessions` สลับเป็น "All projects" ได้
      ref: packages/extension/src/chat/history.ts#historyPanel
      emits: [list-sessions]

    - id: list
      lane: editor
      at: chat
      do: >-
        `listSessions` ส่งคำขอ ACP `session/list` (มีโฟลเดอร์เมื่อขอเฉพาะโปรเจกต์นี้) แล้วแปลงแต่ละแถวเป็นชื่อ โปรเจกต์
        จำนวน turn ค่าใช้จ่าย และเวลา engine อ่านจาก log ของแต่ละแชต
      ref: packages/extension/src/chat/chat.ts#Chat.listSessions

    - id: rows
      beat:
        title: รายการแชตเรียงตามเวลา
        text: ช่องค้นหาค้นข้อความในแชตได้ด้วย และสลับเป็น All projects ได้
        from: panel
        to: you
        sees: รายการแชตแต่ละแถวมีชื่อ ชื่อโปรเจกต์ "4 turns" ค่าใช้จ่าย และเวลา ด้านบนมีช่อง "Search chats" และปุ่ม This project / All projects
      lane: panel
      at: rail
      do: >-
        แผงแสดงรายการเรียงตามเวลาล่าสุด ช่องค้นหาค้นข้อความในแชตด้วยคำขอ `_gcode/searchSessions` แล้วแสดงข้อความที่ตรงพร้อม turn ที่เจอ
      sees: >-
        รายการแชตแต่ละแถวมีชื่อ ชื่อโปรเจกต์ "4 turns" ค่าใช้จ่าย และเวลา ด้านบนมีช่อง "Search chats" และปุ่ม This project / All projects
      ref: packages/extension/src/chat/history.ts#historyPanel

    - id: pick
      beat:
        title: คุณคลิกแชตที่ต้องการ
        text: แชตเทียบโฟลเดอร์ของแชตนั้นกับโฟลเดอร์ของหน้าต่าง lane ของโฟลเดอร์นี้นับเป็นที่เดียวกัน
        from: you
        to: panel
        ask: แชตของที่ไหน
      lane: user
      do: ผู้ใช้คลิกแถวของแชตที่ต้องการ

    - id: open-session
      lane: panel
      at: rail
      do: >-
        แผงโพสต์ `open-session` พร้อม id ของแชต โฟลเดอร์ของมัน และ turn ที่ตรงกับคำค้น (ถ้าเปิดจากผลค้นหา)
      ref: "packages/extension/src/chat/history.ts#\"onclick: () => post({ type: 'open-session', id: row.id, workspace: row.workspace, turnSeq: hit?.turn?.seq }),\""
      emits: [open-session]

    - id: where
      lane: editor
      at: chat
      do: >-
        `openChat` เทียบโฟลเดอร์ของแชตกับโฟลเดอร์ของหน้าต่าง (lane ของโฟลเดอร์นี้นับเป็นที่เดียวกัน)
      ref: packages/extension/src/chat/chat.ts#Chat.openChat
      fork:
        ask: แชตนี้เป็นของโปรเจกต์ไหน
        options:
          - id: here
            label: โปรเจกต์นี้
            steps:
              - lane: editor
                beat:
                  title: แผงย้ายไปแชตนั้น
                  text: History ปิด ถ้าแชตปัจจุบันมี turn ทำงานอยู่ turn นั้นทำงานต่อเบื้องหลัง แชตขอโหลดแชตเก่า
                  from: panel
                  to: engine
                at: chat
                do: >-
                  ปิดแผง History แล้ว `moveTo` ย้ายแผงไปแชตนั้น ถ้าแชตปัจจุบันมี turn ทำงานอยู่ turn นั้นถูกปล่อยให้ทำงานต่อในเบื้องหลัง
                  `Chat.load` ส่งคำขอ ACP `session/load`
                ref: packages/extension/src/chat/chat.ts#Chat.load
              - lane: server
                beat:
                  title: Geno เล่น log ซ้ำ
                  text: engine ปฏิเสธถ้าแชตเป็นของ workspace อื่น แล้วส่งทุก turn ตามลำดับ ข้อความของคุณ คำตอบ และ tool call
                  from: engine
                  to: panel
                at: sessions
                do: >-
                  engine ปฏิเสธถ้า session เป็นของ workspace อื่น แล้ว `replayUpdates` แปลง log เป็น `session/update` ตามลำดับ:
                  ข้อความของผู้ใช้แต่ละ turn พร้อม `REPLAYED_TURN_META` (เวลา สถานะ usage) ข้อความของ model tool และผล
                  การแก้พร้อมสถานะ review ถ้า turn ยังทำงานอยู่ก็ส่งข้อความที่กำลัง stream ต่อท้าย แล้วปิดด้วยชื่อแชต
                ref: packages/engine/src/session-replay.ts#replayUpdates
                emits: [user_message_chunk, REPLAYED_TURN_META, session_info_update]
              - lane: editor
                at: chat
                do: >-
                  `Chat.updated` เห็นว่ากำลังเล่นซ้ำ จึงรวมอัปเดตไว้ในบทสนทนาชุดใหม่ ไม่ส่งให้แผงทีละอัน
                  เมื่อชื่อแชตมาถึง (หรือครบ 5 วินาที) `show` ส่ง action `reset` ทีเดียว ถ้าคำตอบบอกว่า turn ยังทำงาน
                  แผงรับ turn นั้นมาดูแล ปุ่ม Stop ใช้ได้ และอัปเดตสดตามมาหลังการเล่นซ้ำ
                ref: packages/extension/src/chat/chat.ts#Chat.updated
                emits: [reset]
              - lane: panel
                beat:
                  title: แผงวาดบทสนทนาทั้งหมดในครั้งเดียว
                  text: ข้อความไม่ค่อยๆ ขึ้นเหมือนตอน stream ถ้าเปิดจากผลค้นหา แผงเลื่อนไปที่ turn ที่ตรง
                  from: panel
                  to: you
                  sees: บทสนทนาเดิมครบทุก turn พร้อมท้าย turn (model token ค่าใช้จ่าย) diff ของการแก้ และชื่อแชตบนหัวแผง
                at: rail
                do: >-
                  แผงวาดบทสนทนาทั้งหมดในครั้งเดียว ข้อความไม่ค่อยๆ ขึ้นเหมือนตอน stream ถ้าเปิดจากผลค้นหา แผงเลื่อนไปที่ turn ที่ตรง
                sees: >-
                  บทสนทนาเดิมครบทุก turn พร้อมท้าย turn (model token ค่าใช้จ่าย) diff ของการแก้ และชื่อแชตบนหัวแผง
                ref: packages/extension/src/chat/webview.ts#render
              - lane: server
                beat:
                  title: Geno ปิด session ที่ออกมา
                  text: ถ้าแชตที่ออกมาไม่มี turn ทำงาน engine ปิด MCP server ของมัน ข้อความถัดไปของคุณต่อท้าย log ของแชตที่เปิด
                  from: engine
                  to: engine
                  end: คุยต่อในแชตเก่า
                at: sessions
                do: >-
                  ถ้าแชตที่ออกมาไม่มี turn ทำงาน `moveTo` ส่ง `session/close` ให้ engine ปิด MCP server ของมัน
                  ข้อความถัดไปที่ผู้ใช้ส่งต่อท้าย log ของแชตที่เปิด
                ref: "packages/engine/src/serve.ts#\".onRequest(acp.methods.agent.session.close, async ({ params }) => {\""
                end: { turn: none }
          - id: elsewhere
            label: โปรเจกต์อื่น
            steps:
              - lane: editor
                beat:
                  title: VS Code เปิดโฟลเดอร์ในหน้าต่างใหม่
                  text: ส่วนขยายฝาก id ของแชตไว้กับโฟลเดอร์นั้น แล้วเปิดโฟลเดอร์ในหน้าต่างใหม่ หน้าต่างนี้ไม่เปลี่ยน
                  from: panel
                  to: panel
                at: vscode-ui
                do: >-
                  `openElsewhere` ตรวจว่าโฟลเดอร์ยังอยู่ เก็บ id ของแชตไว้ใน global state ของ extension ผูกกับโฟลเดอร์นั้น
                  แล้วสั่ง VS Code เปิดโฟลเดอร์ในหน้าต่างใหม่ หน้าต่างนี้ไม่เปลี่ยน
                ref: packages/extension/src/extension.ts#openElsewhere
              - lane: editor
                beat:
                  title: หน้าต่างใหม่โหลดแชตนั้น
                  text: หน้าต่างใหม่รับ id ที่ฝากไว้ครั้งเดียว โหลดแชต และโฟกัสแผงแชต จากนั้นเหมือนเปิดหน้าต่างที่จำแชตไว้
                  from: panel
                  to: panel
                  end: ไปที่หน้าต่างใหม่
                at: vscode-ui
                do: >-
                  หน้าต่างใหม่ activate แล้ว `takeHandoff` รับ id ที่ฝากไว้ (ครั้งเดียว) จำเป็นแชตของหน้าต่าง โหลดมันทันที
                  และโฟกัสแผงแชต จากนั้นเป็นการเปิดหน้าต่างที่จำแชตไว้ตามปกติ
                ref: packages/extension/src/extension.ts#takeHandoff
                goto: start.open-window
---

แชตหนึ่งแชตผูกกับ workspace ของมัน เพราะ tool ของมันอ่าน เขียน และรันคำสั่งใน workspace นั้น
แชตของโปรเจกต์อื่นจึงไม่เปิดในหน้าต่างนี้ แต่เปิดในหน้าต่างของโปรเจกต์นั้น และ engine เองก็ปฏิเสธ `session/load`
ของ session ที่เป็นของ workspace อื่น

สิ่งที่ควรสังเกต

- **การเล่นซ้ำมาจาก log ไม่ใช่จาก cache ของแผง** ทุกสิ่งที่แผงแสดงถูกสร้างใหม่จาก event ใน log
  ข้อความที่ model เขียนไม่จบเพราะถูก Stop จึงไม่กลับมา ดู [กด Stop ขณะ model กำลังเขียน](/scenarios/ctl/stop-while-streaming/)
- **turn ที่ยังทำงานถูกรับมาดูแล** ถ้าแชตที่เปิดมี turn ที่ยังไม่จบ (เช่นที่ปล่อยไว้ตอนกด New Chat) แผงแสดงสิ่งที่ทำไปแล้ว
  ต่อด้วยอัปเดตสด และ turn จบเมื่อแผง Tasks บอกว่างานจบ
- **แชตนั้นทำต่อได้ทันที** ข้อความถัดไปเป็น turn ใหม่ของ session เดิม และ model เห็นบทสนทนาทั้งหมดที่ผ่านมา
