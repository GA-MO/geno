---
title: "เปิดหน้าต่าง VS Code แล้ว Geno ต่อ engine"
description: VS Code เปิดโฟลเดอร์ Geno เชื่อมกับ engine แล้วแผงแชตแสดงแชตเดิมหรือหน้าเริ่มต้น
scenario:
  surface: vscode
  given:
    - ติดตั้ง Geno และตั้ง API key ไว้แล้ว
    - เปิดโฟลเดอร์ใน VS Code (Geno ต้องมีโฟลเดอร์ที่เปิดอยู่)
  trigger: >-
    ผู้ใช้เปิดโฟลเดอร์ใน VS Code หรือ reload หน้าต่าง
  covers: [start.open-window]
  related: [start.first-run-no-key, start.new-session-context, sess.open-history, sess.new-chat]
  steps:
    - id: activate
      lane: editor
      at: vscode-ui
      beat:
        title: "VS Code เปิดเสร็จแล้วปลุก Geno"
        text: >-
          เมื่อ VS Code เปิดโฟลเดอร์เสร็จ Geno ลงทะเบียนแผงแชตและคำสั่งของตัวเอง ตอนนี้ยังไม่มีอะไรต่อ engine เลย
        from: panel
        to: panel
      do: >-
        เมื่อ VS Code เปิดเสร็จ (`onStartupFinished`) `activate` เรียก `registerChat` ซึ่งสร้าง `Chat` กับตัวเชื่อม `Engine`
        ลงทะเบียนแผงแชต `gcode.chat` คำสั่งของ Geno และตัวฟังการเปลี่ยนคีย์กับการตั้งค่า ตอนนี้ยังไม่มีอะไรต่อ engine
      ref: packages/extension/src/extension.ts#registerChat
      phase: idle

    - id: stored
      lane: editor
      at: chat
      beat:
        title: "Geno ดูว่าหน้าต่างนี้จำแชตไหนไว้"
        text: >-
          Geno รับแชตที่หน้าต่างอื่นส่งต่อมาให้ถ้ามี แล้วอ่านว่าครั้งก่อนหน้าต่างนี้เปิดแชตไหนค้างไว้ คำตอบนี้ตัดสินว่า
          Geno จะต่อ engine ตอนไหน
        from: panel
        to: panel
        ask: "จำแชตไว้ไหม"
      do: >-
        งานตอนเริ่มรับ session ที่หน้าต่างอื่นส่งต่อมาให้ (`takeHandoff`) ถ้ามี แล้วอ่านไฟล์ `session-id`
        ใน storage ของ workspace ว่าครั้งก่อนหน้าต่างนี้แสดงแชตไหนอยู่
      ref: "packages/extension/src/extension.ts#\"if ((await chat.storedSession()) === undefined) return;\""
      fork:
        ask: หน้าต่างนี้จำแชตครั้งก่อนไว้หรือไม่
        options:
          - id: stored
            label: จำไว้ (เคยเปิดแชตในโฟลเดอร์นี้)
            steps:
              - lane: editor
                at: chat
                beat:
                  title: "Geno ต่อ engine ทันทีโดยไม่รอคุณ"
                  text: >-
                    หน้าต่างนี้จำแชตไว้ Geno จึงเริ่มต่อ engine ตั้งแต่ตอนนี้ โดยไม่รอให้คุณเปิดแผง บทสนทนาเดิมจะพร้อมก่อนคุณมองหา
                  from: panel
                  to: panel
                do: >-
                  เรียก `chat.link()` ทันทีโดยไม่รอให้ผู้ใช้เปิดแผง บทสนทนาและสถานะ review จึงกลับมาพร้อมหน้าต่าง
                ref: packages/extension/src/chat/chat.ts#Chat.link
              - use: start-engine-connects
                beat:
                  title: "Geno เปิด engine หรือต่อตัวที่มีอยู่"
                  text: >-
                    Geno ตรวจว่าตั้ง API key แล้ว แล้วต่อ socket ของ engine ที่หน้าต่างอื่นของโฟลเดอร์นี้อาจเปิดไว้แล้ว
                    ถ้ายังไม่มี Geno เปิด engine เป็น process แยกที่อยู่ต่อได้แม้หน้าต่างปิด
                  from: panel
                  to: engine

              - lane: editor
                at: chat
                beat:
                  title: "Geno ขอโหลดแชตที่จำไว้"
                  text: >-
                    VS Code ขอ engine ให้โหลดแชตนั้น ถ้าบันทึกของแชตหายไปแล้ว Geno เริ่มแชตใหม่แทน
                  from: panel
                  to: engine
                do: >-
                  `openSession` เห็นว่ายังไม่มีแชตที่แสดงอยู่ จึงโหลดแชตที่จำไว้ด้วยคำขอ ACP `session/load`
                  (ถ้า log หายไปแล้ว จะเริ่มแชตใหม่แทน)
                ref: packages/extension/src/chat/chat.ts#Chat.openSession
              - lane: server
                at: sessions
                beat:
                  title: "Engine เล่นบันทึกของแชตซ้ำ"
                  text: >-
                    engine ตรวจว่าแชตเป็นของโฟลเดอร์นี้ แล้วส่งบันทึกทีละรายการกลับมา ปิดท้ายด้วยชื่อแชต VS Code เก็บบทสนทนาไว้รอ
                    เพราะแผงยังไม่เปิด
                  from: engine
                  to: panel
                do: >-
                  engine ตรวจว่า session เป็นของ workspace นี้ แล้วเล่น log ซ้ำเป็น `session/update` ทีละรายการ
                  ปิดท้ายด้วย `session_info_update` ที่มีชื่อแชต
                ref: "packages/engine/src/serve.ts#\".onRequest(acp.methods.agent.session.load, async ({ params, client }) => {\""
                emits: [session_info_update]
              - lane: editor
                at: chat
                do: >-
                  `Chat.load` รวมอัปเดตที่เล่นซ้ำไว้ในบทสนทนาชุดใหม่จนชื่อแชตมาถึง (หรือครบ 5 วินาที)
                  แล้ว `show` ตั้งเป็นแชตของแผงด้วย action `reset` แผงยังไม่เปิด บทสนทนาจึงรออยู่ใน extension host
                ref: packages/extension/src/chat/chat.ts#Chat.load
                emits: [reset]
              - lane: user
                beat:
                  title: "คุณคลิกไอคอน Geno"
                  text: >-
                    คุณคลิกไอคอน Geno ใน activity bar เมื่อแผงพร้อม VS Code ส่งบทสนทนาทั้งชุดเข้าไปในครั้งเดียว
                    แล้วจึงส่งอัปเดตสดตามมา
                  from: you
                  to: panel
                do: ผู้ใช้คลิกไอคอน Geno ใน activity bar เพื่อเปิดแผงแชต
              - lane: editor
                at: chat
                do: >-
                  `resolveWebviewView` ใส่ HTML ของแผง เมื่อสคริปต์ในแผงส่ง `ready` มา extension host ตอบด้วย `reset`
                  ที่มีบทสนทนาทั้งชุด หัวข้อ โหมด คำสั่ง และ Tasks แล้วจึงเริ่มส่ง action สดตามมา
                ref: "packages/extension/src/chat/chat.ts#\"ready: () => {\""
                emits: [ready, reset]
              - lane: panel
                at: rail
                beat:
                  title: "บทสนทนาเดิมกลับมาครบ"
                  text: >-
                    แผงวาดบทสนทนาเดิมทั้งหมด ชื่อแชตอยู่บนหัวแผง และท้ายแต่ละ turn บอก model token และค่าใช้จ่าย
                    คุณพิมพ์ต่อได้ทันที
                  from: panel
                  to: you
                  end: "แชตเดิมกลับมา"
                  sees: { kind: composer, state: idle }
                do: แผงวาดบทสนทนาเดิมทั้งหมด พร้อมท้าย turn ที่บอก model token และค่าใช้จ่ายของแต่ละ turn
                sees: บทสนทนาครั้งก่อนกลับมาครบ ชื่อแชตอยู่บนหัวแผง และช่องพิมพ์พร้อมให้พิมพ์ต่อ
                ref: packages/extension/src/chat/webview.ts#render
                end: { turn: none }

          - id: none
            label: ไม่ได้จำไว้ (หน้าต่างแรกของโฟลเดอร์นี้)
            steps:
              - lane: user
                beat:
                  title: "คุณคลิกไอคอน Geno"
                  text: >-
                    หน้าต่างนี้ไม่ได้จำแชตไว้ จึงยังไม่มีอะไรต่อ engine จนคุณคลิกไอคอน Geno ใน activity bar VS Code
                    ส่งหน้าแผงที่ยังว่างพร้อมชื่อโปรเจกต์ branch และโหมดเข้าไป
                  from: you
                  to: panel
                do: ผู้ใช้คลิกไอคอน Geno ใน activity bar เพื่อเปิดแผงแชต
              - lane: editor
                at: chat
                do: >-
                  `resolveWebviewView` ใส่ HTML ของแผง เมื่อสคริปต์ในแผงส่ง `ready` มา extension host ตอบด้วย `reset`
                  ที่บทสนทนายังว่าง หัวข้อ (ชื่อโปรเจกต์และ branch) และโหมดที่แชตใหม่จะใช้
                ref: "packages/extension/src/chat/chat.ts#\"ready: () => {\""
                emits: [ready, reset]
              - lane: panel
                at: rail
                beat:
                  title: "แผงวาดหน้าเริ่มต้นแล้วขอรายการแชต"
                  text: >-
                    บทสนทนายังว่าง แผงจึงวาดหน้าเริ่มต้น แล้วขอรายการแชตเก่าของโปรเจกต์นี้มาแสดง
                  from: panel
                  to: panel
                do: >-
                  `render()` เห็นบทสนทนาว่างจึงวาดหน้าเริ่มต้น แล้วหน้าเริ่มต้นขอรายการแชตของโปรเจกต์นี้ด้วยข้อความ `list-sessions`
                ref: "packages/extension/src/chat/start-page.ts#\"refresh: () => post({ type: 'list-sessions', scope: 'project' }),\""
                emits: [list-sessions]
              - lane: editor
                at: chat
                beat:
                  title: "ทั้งรายการแชตและสถานะ PR รอ engine"
                  text: >-
                    การขอรายการแชตต้องใช้ engine และแถบสถานะ PR ก็เพิ่งขอ engine ไปเหมือนกัน ทั้งสองรอการต่อครั้งแรกตัวเดียวกัน
                    ยังไม่มี session ใหม่เกิดขึ้น แชตใหม่จะเกิดตอนคุณส่งข้อความแรก
                  from: panel
                  to: panel
                do: >-
                  `listSessions` ต้องใช้ engine ตอน `ready` แผงสั่งดึงสถานะ PR (`prStatus.refresh(true)`) ไปแล้ว
                  ซึ่งเรียก `Engine.connection()` ก่อน ทั้งสองจึงรอการต่อ engine ครั้งแรกตัวเดียวกัน
                  ยังไม่มี session ใดถูกสร้าง แชตใหม่จะเกิดเมื่อผู้ใช้ส่งข้อความแรก
                ref: packages/extension/src/chat/chat.ts#Chat.listSessions
              - use: start-engine-connects
                beat:
                  title: "Geno เปิด engine หรือต่อตัวที่มีอยู่"
                  text: >-
                    Geno ตรวจว่าตั้ง API key แล้ว แล้วต่อ socket ของ engine ถ้ายังไม่มี engine ฟังอยู่ Geno เปิดขึ้นมาเป็น process
                    แยก
                  from: panel
                  to: engine

              - lane: editor
                at: chat
                beat:
                  title: "Engine ตอบรายการแชตของโฟลเดอร์นี้"
                  text: >-
                    VS Code ขอรายการแชตของโฟลเดอร์ engine อ่านบันทึกทุกแชตแล้วตอบชื่อ จำนวน turn ค่าใช้จ่าย และเวลาแก้ล่าสุด
                  from: engine
                  to: panel
                do: ส่งคำขอ ACP `session/list` พร้อมโฟลเดอร์ของหน้าต่าง
                ref: packages/extension/src/chat/chat.ts#Chat.listSessions
              - lane: server
                at: sessions
                do: >-
                  engine อ่าน log ของทุกแชตใน workspace นี้ แล้วตอบเป็นแถว: ชื่อ จำนวน turn ค่าใช้จ่าย และเวลาที่แก้ล่าสุด
                ref: "packages/engine/src/serve.ts#\".onRequest(acp.methods.agent.session.list, async ({ params }): Promise<acp.ListSessionsResponse> => {\""
              - lane: panel
                at: rail
                beat:
                  title: "หน้าเริ่มต้นขึ้นแชตล่าสุด"
                  text: >-
                    แผงเลือกแชตของโปรเจกต์นี้ที่มี turn แล้ว ใหม่สุด 3 แชต มาแสดงใต้หัวข้อ Continue ไดโนเสาร์ Noodle เดินไปมา
                    และช่องพิมพ์รอข้อความแรก
                  from: panel
                  to: you
                  end: "หน้าเริ่มต้นพร้อม"
                  sees: { kind: composer, state: idle }
                do: >-
                  `recentSessions` เลือกแชตของโปรเจกต์นี้ที่มี turn แล้ว ใหม่สุด 3 แชต มาแสดงใต้หัวข้อ Continue
                sees: >-
                  หน้าเริ่มต้น: ไดโนเสาร์ Noodle เดินไปมา คำว่า "geno" ชื่อโปรเจกต์กับ branch และรายการ "Continue"
                  ที่มีชื่อแชตเก่าพร้อมเวลา (ถ้ามี)
                ref: packages/extension/src/chat/recents.ts#recentSessions
                end: { turn: none }
---

engine ไม่ได้อยู่ใน process ของ VS Code มันเป็น process แยก (`gcode serve --socket`) ที่หน้าต่างทุกบานของโฟลเดอร์เดียวกัน
และการตั้งค่าชุดเดียวกันใช้ร่วมกันผ่าน Unix socket ตัวเดียว engine อยู่ต่อแม้หน้าต่างปิดหรือ reload
และจะปิดตัวเองหลังไม่มีหน้าต่างเชื่อมต่อและไม่มีงานค้างครบ 10 วินาที turn ที่กำลังทำงานจึงไม่หยุดเมื่อ reload

สิ่งที่ควรสังเกต

- **ตอนไหน engine ถูกเรียกขึ้นมา** ถ้าหน้าต่างจำแชตไว้ Geno ต่อ engine ตั้งแต่ตอนเปิดหน้าต่าง
  ถ้าไม่ได้จำไว้ Geno ต่อ engine ตอนเปิดแผง แถบสถานะ PR ใต้ช่องพิมพ์ขอข้อมูลจาก engine ตั้งแต่ `ready`
  และหน้าเริ่มต้นขอรายการแชตตามมา
- **การต่อ engine ตรวจคีย์ก่อนเสมอ** ถ้าคีย์ยังไม่ได้ตั้ง `engineSettings` จะแสดง toast แล้วการต่อจะล้มเหลว
  หน้าต่างที่ยังไม่มีคีย์จึงเห็น toast ตั้งแต่เปิดแผง ก่อนผู้ใช้จะส่งอะไร ดู [ส่งข้อความแรกโดยยังไม่มี API key](/scenarios/start/first-run-no-key/)
- **ไม่มี session ใหม่เกิดขึ้นตอนเปิดแผง** แชตใหม่ (`session/new`) เกิดเมื่อผู้ใช้ส่งข้อความแรกหรือกด New Chat
  ดู [Session ใหม่โหลดคำสั่งโปรเจกต์ memory และ skill](/scenarios/start/new-session-context/)

อ่านต่อที่ [Session ใหม่โหลดคำสั่งโปรเจกต์ memory และ skill](/scenarios/start/new-session-context/) เพื่อดูว่าข้อความแรกสร้าง session อย่างไร
