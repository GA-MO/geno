---
title: เปิดหน้าต่างและเชื่อม engine
description: VS Code เปิดโฟลเดอร์ Geno เชื่อมกับ engine แล้วแผงแชตแสดงแชตเดิมหรือหน้าเริ่มต้น
tableOfContents: false
sidebar:
  order: 1
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
      do: >-
        เมื่อ VS Code เปิดเสร็จ (`onStartupFinished`) `activate` เรียก `registerChat` ซึ่งสร้าง `Chat` กับตัวเชื่อม `Engine`
        ลงทะเบียนแผงแชต `gcode.chat` คำสั่งของ Geno และตัวฟังการเปลี่ยนคีย์กับการตั้งค่า ตอนนี้ยังไม่มีอะไรต่อ engine
      ref: packages/extension/src/extension.ts#registerChat
      phase: idle

    - id: stored
      lane: editor
      at: chat
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
                do: >-
                  เรียก `chat.link()` ทันทีโดยไม่รอให้ผู้ใช้เปิดแผง บทสนทนาและสถานะ review จึงกลับมาพร้อมหน้าต่าง
                ref: packages/extension/src/chat/chat.ts#Chat.link
              - use: start-engine-connects
              - lane: editor
                at: chat
                do: >-
                  `openSession` เห็นว่ายังไม่มีแชตที่แสดงอยู่ จึงโหลดแชตที่จำไว้ด้วยคำขอ ACP `session/load`
                  (ถ้า log หายไปแล้ว จะเริ่มแชตใหม่แทน)
                ref: packages/extension/src/chat/chat.ts#Chat.openSession
              - lane: server
                at: sessions
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
                do: แผงวาดบทสนทนาเดิมทั้งหมด พร้อมท้าย turn ที่บอกโมเดล token และค่าใช้จ่ายของแต่ละ turn
                sees: บทสนทนาครั้งก่อนกลับมาครบ ชื่อแชตอยู่บนหัวแผง และช่องพิมพ์พร้อมให้พิมพ์ต่อ
                ref: packages/extension/src/chat/webview.ts#render
                end: { turn: none }

          - id: none
            label: ไม่ได้จำไว้ (หน้าต่างแรกของโฟลเดอร์นี้)
            steps:
              - lane: user
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
                do: >-
                  `render()` เห็นบทสนทนาว่างจึงวาดหน้าเริ่มต้น แล้วหน้าเริ่มต้นขอรายการแชตของโปรเจกต์นี้ด้วยข้อความ `list-sessions`
                ref: "packages/extension/src/chat/start-page.ts#\"refresh: () => post({ type: 'list-sessions', scope: 'project' }),\""
                emits: [list-sessions]
              - lane: editor
                at: chat
                do: >-
                  `listSessions` ต้องใช้ engine ตอน `ready` แผงสั่งดึงสถานะ PR (`prStatus.refresh(true)`) ไปแล้ว
                  ซึ่งเรียก `Engine.connection()` ก่อน ทั้งสองจึงรอการต่อ engine ครั้งแรกตัวเดียวกัน
                  ยังไม่มี session ใดถูกสร้าง แชตใหม่จะเกิดเมื่อผู้ใช้ส่งข้อความแรก
                ref: packages/extension/src/chat/chat.ts#Chat.listSessions
              - use: start-engine-connects
              - lane: editor
                at: chat
                do: ส่งคำขอ ACP `session/list` พร้อมโฟลเดอร์ของหน้าต่าง
                ref: packages/extension/src/chat/chat.ts#Chat.listSessions
              - lane: server
                at: sessions
                do: >-
                  engine อ่าน log ของทุกแชตใน workspace นี้ แล้วตอบเป็นแถว: ชื่อ จำนวน turn ค่าใช้จ่าย และเวลาที่แก้ล่าสุด
                ref: "packages/engine/src/serve.ts#\".onRequest(acp.methods.agent.session.list, async ({ params }): Promise<acp.ListSessionsResponse> => {\""
              - lane: panel
                at: rail
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
  หน้าต่างที่ยังไม่มีคีย์จึงเห็น toast ตั้งแต่เปิดแผง ก่อนผู้ใช้จะส่งอะไร ดู [ส่งข้อความแรกโดยไม่มี API key](/scenarios/start/first-run-no-key/)
- **ไม่มี session ใหม่เกิดขึ้นตอนเปิดแผง** แชตใหม่ (`session/new`) เกิดเมื่อผู้ใช้ส่งข้อความแรกหรือกด New Chat
  ดู [โหลดคำสั่งโปรเจกต์ หน่วยความจำ และสกิล](/scenarios/start/new-session-context/)
