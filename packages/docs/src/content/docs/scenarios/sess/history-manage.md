---
title: เปลี่ยนชื่อ ลบ และค้นหาแชต
description: ในรายการ History ผู้ใช้เปลี่ยนชื่อแชต ย้ายแชตไปถังขยะ หรือค้นข้อความในทุกแชต engine เขียน log ค้นใน index แล้วรายการอัปเดต
tableOfContents: false
sidebar:
  order: 7
scenario:
  surface: vscode
  given:
    - workspace มีแชตเก่าหลายแชต ไม่มี turn ทำงานในแชตที่ผู้ใช้จะจัดการ
  trigger: >-
    ผู้ใช้เปิด History จากปุ่มบนแผงแชต (หรือพิมพ์ `/history`)
  covers: [sess.history-manage]
  related: [sess.open-history, sess.new-chat, sess.rewind]
  steps:
    - id: list
      lane: panel
      at: rail
      do: >-
        รายการ History มาแทนบทสนทนา: ช่องค้นหา ปุ่มสลับ This project กับ All projects และแถวของแต่ละแชตพร้อมปุ่ม Rename และ Delete
        แชตที่ fork มามีบรรทัดบอกที่มา
      sees: ช่องค้นหา ปุ่ม [This project] [All projects] และแถวแชตที่มีชื่อ เวลา จำนวน turn และค่าใช้จ่าย
      ref: packages/extension/src/chat/history.ts#historyPanel
      phase: idle

    - id: act
      lane: user
      do: ผู้ใช้เลือกสิ่งที่จะทำ
      fork:
        ask: ผู้ใช้ทำอะไร
        options:
          - id: rename
            label: เปลี่ยนชื่อ
            steps:
              - lane: panel
                at: rail
                do: >-
                  กดปุ่ม Rename แล้วแถวกลายเป็นช่องแก้ชื่อ ผู้ใช้พิมพ์ "Leap-year fix" แล้วกด Enter แผงโพสต์ `rename-session`
                ref: packages/extension/src/chat/history.ts#historyPanel
                emits: [rename-session]
              - lane: editor
                at: chat
                do: >-
                  `renameChat` ส่งคำขอ `_gcode/renameSession`
                ref: packages/extension/src/chat/chat.ts#Chat.renameChat
                emits: [_gcode/renameSession]
              - lane: server
                at: sessions
                do: >-
                  `renameSession` ตัดชื่อให้เป็นบรรทัดเดียว (ชื่อว่างถูกปฏิเสธ) แล้วต่อท้าย log ด้วย event `title` ไม่แก้บรรทัดเดิม
                  งานในแผง Tasks ได้ชื่อใหม่ และหน้าต่างที่แสดงแชตนั้นได้ `session_info_update`
                ref: packages/engine/src/history.ts#renameSession
                emits: [title, session_info_update]
              - lane: panel
                at: rail
                do: รายการโหลดใหม่ แถวขึ้นชื่อใหม่
                sees: แถว "Leap-year fix"
                ref: packages/extension/src/chat/history.ts#historyPanel
                end: { turn: none }

          - id: delete
            label: ย้ายไปถังขยะ
            steps:
              - lane: panel
                at: rail
                do: >-
                  กดปุ่ม Delete แล้วแถวกลายเป็นการยืนยัน แป้นพิมพ์เริ่มที่ Cancel ผู้ใช้กด Move to trash แผงโพสต์ `delete-session`
                sees: >-
                  "Move <ชื่อแชต> to the trash?" ปุ่ม [Cancel] [Move to trash]
                ref: packages/extension/src/chat/history.ts#historyPanel
                emits: [delete-session]
              - lane: editor
                at: chat
                do: >-
                  `deleteChat` ส่งคำขอ ACP `session/delete` ถ้าเป็นแชตที่แสดงอยู่ แผงพักไว้ก่อนแล้วเริ่มแชตใหม่หลังลบ
                ref: packages/extension/src/chat/chat.ts#Chat.deleteChat
              - lane: server
                at: sessions
                do: >-
                  engine ปฏิเสธถ้าแชตนั้นมี turn รันอยู่ ("stop the running turn before deleting its session")
                  ไม่อย่างนั้นลืมการรอและการปลุกทั้งหมดของ session หยุดคำสั่งเบื้องหลังของมัน แล้ว `trashSession` ย้าย log
                  และโฟลเดอร์ไฟล์แนบไปที่ถังขยะของ Geno ไม่ได้ลบทิ้ง
                ref: packages/engine/src/history.ts#trashSession
              - lane: panel
                at: rail
                do: รายการโหลดใหม่ แถวนั้นหายไป
                sees: รายการที่ไม่มีแชตนั้นแล้ว
                ref: packages/extension/src/chat/history.ts#historyPanel
                end: { turn: none }

          - id: search
            label: ค้นหา
            steps:
              - lane: panel
                at: rail
                do: >-
                  ผู้ใช้พิมพ์ "leap year" ในช่องค้นหา ชื่อแชตกรองทันที และเมื่อหยุดพิมพ์ 120 ms แผงโพสต์ `search-sessions` เพื่อค้นเนื้อหา
                ref: packages/extension/src/chat/history.ts#historyPanel
                emits: [search-sessions]
              - lane: editor
                at: chat
                do: >-
                  `searchSessions` ส่งคำขอ `_gcode/searchSessions` พร้อมโฟลเดอร์ (ถ้าเลือก This project)
                ref: packages/extension/src/chat/chat.ts#Chat.searchSessions
                emits: [_gcode/searchSessions]
              - lane: server
                at: sessions
                do: >-
                  `SessionIndex.search` อ่านใหม่เฉพาะ log ที่ขนาดหรือเวลาแก้เปลี่ยน แล้วค้นทุกคำในข้อความของแชตที่อยู่ในขอบเขต
                  ได้ไม่เกิน 50 แชต แต่ละแชตมีข้อความตัวอย่างยาวไม่เกิน 120 ตัวอักษร turn แรกที่ตรง และจำนวน turn ที่ตรง
                ref: packages/engine/src/session-index.ts#SessionIndex.search
              - lane: panel
                at: rail
                do: >-
                  แถวที่ค้นเจอแสดงข้อความตัวอย่าง คลิกแถวเปิดแชตนั้นที่ turn ที่ตรง
                sees: แถวแชตพร้อมข้อความตัวอย่างที่มีคำว่า "leap year"
                ref: packages/extension/src/chat/history.ts#historyPanel
                end: { turn: none }
---

History อ่าน log ของ session ทุกตัวที่ engine เก็บไว้ ไม่มีฐานข้อมูลแยก
การเปลี่ยนชื่อจึงเป็น event ใหม่ใน log และการลบเป็นการย้ายไฟล์ไปถังขยะ

สิ่งที่ควรสังเกต

- **ลบแล้วกู้ได้จากดิสก์** ถังขยะอยู่ในโฟลเดอร์ข้อมูลของ Geno แผงแชตไม่มีปุ่มกู้คืน
- **ลบแชตที่ยังทำงานไม่ได้** engine ปฏิเสธจนกว่าผู้ใช้จะหยุด turn
- **ค้นได้ข้ามโปรเจกต์** All projects ค้นทุก session ใน store แต่แชตของโปรเจกต์อื่นเปิดในหน้าต่างของโปรเจกต์นั้น
