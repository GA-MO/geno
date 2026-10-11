---
title: ย้อนไฟล์และ/หรือบทสนทนา
description: ผู้ใช้เปิดเมนูบนข้อความหนึ่งแล้วเลือกย้อนไฟล์ ย้อนบทสนทนา หรือทั้งสองอย่าง engine คืนไฟล์จาก checkpoint ก่อนข้อความนั้น ตัดบทสนทนาด้วย event cut และคืนข้อความกลับไปที่ช่องพิมพ์
tableOfContents: false
sidebar:
  order: 5
scenario:
  surface: vscode
  given:
    - แชตมีหลาย turn และไม่มี turn ทำงานอยู่
    - turn ที่สองแก้ `src/date.ts` และ `src/date.test.ts` ก่อนหน้านั้น engine เก็บ checkpoint ของ workspace ไว้แล้ว
  trigger: >-
    ผู้ใช้ชี้ที่บับเบิลข้อความของ turn ที่สอง แล้วคลิกปุ่ม "Rewind, fork or mark a chapter"
  covers: [sess.rewind]
  related: [ed.review-auto-undo, sess.open-history, sess.new-chat]
  steps:
    - id: menu
      lane: panel
      at: rail
      do: >-
        เมนูมีเฉพาะข้อความที่ engine บอกเลขลำดับไว้แล้ว และเฉพาะตอนที่ไม่มี turn ทำงาน แต่ละรายการมีคำอธิบายสั้นๆ
      sees: >-
        เมนู Restore files ("Put the files back as they were before this message"), Restore conversation
        ("Go back to before this message, and edit it"), Restore both, และ Fork from here
      ref: packages/extension/src/chat/rewind-model.ts#REWIND_ITEMS
      phase: idle

    - id: choose
      lane: user
      do: >-
        ผู้ใช้เลือกรายการหนึ่ง (Restore both ทำทั้งสองทางด้านล่าง ยืนยันแบบ Restore files แล้วคืนไฟล์ก่อนตัดบทสนทนา)
      fork:
        ask: ผู้ใช้เลือกอะไร
        options:
          - id: files
            label: Restore files
            steps:
              - lane: editor
                at: chat
                do: >-
                  การย้อนไฟล์ต้องยืนยันก่อน `RewindHost` ส่งคำขอ `REWIND_PREVIEW_METHOD` ถาม engine ว่าจะเขียนทับไฟล์ไหน
                ref: packages/extension/src/chat/rewind-host.ts#RewindHost
                emits: [REWIND_PREVIEW_METHOD]
              - lane: server
                at: sessions
                do: >-
                  `rewindPreview` เทียบ workspace กับ checkpoint ก่อนการเรียกโมเดลครั้งแรกของ turn นั้นใน repository เงาของ checkpoint
                  และหาไฟล์ที่เปลี่ยนหลัง checkpoint ล่าสุด ซึ่งไม่มี checkpoint ไหนเก็บไว้
                ref: packages/engine/src/rewind.ts#rewindPreview
              - lane: panel
                at: rail
                do: >-
                  ใต้ข้อความขึ้นกล่องยืนยันที่บอกจำนวนและชื่อไฟล์ ถ้ามีการแก้ที่ไม่มีใน checkpoint ใด กล่องเตือนว่าจะหายและให้แป้นพิมพ์เริ่มที่ Cancel
                sees: >-
                  "Restore 2 files to before this message: src/date.ts, src/date.test.ts." ปุ่ม [Cancel] [Restore files]
                ref: packages/extension/src/chat/rewind-model.ts#confirmOf
              - lane: user
                do: ผู้ใช้กด Restore files
              - lane: editor
                at: chat
                do: >-
                  `RewindHost` ส่งคำขอ `REWIND_TURN_METHOD` พร้อมเลขลำดับของข้อความและ `kind: files`
                ref: packages/extension/src/chat/rewind-host.ts#RewindHost
                emits: [REWIND_TURN_METHOD]
              - lane: server
                at: sessions
                do: >-
                  engine ปฏิเสธถ้า session มี turn ทำงาน ("stop the running turn before rewinding the session")
                  แล้ว `rewindSession` คืนไฟล์จาก checkpoint ของ turn นั้น ลบไฟล์ที่สร้างทีหลัง และบันทึก event `restored`
                ref: packages/engine/src/rewind.ts#rewindSession
                emits: [restored]
              - lane: editor
                at: chat
                do: >-
                  ส่วนขยายโหลด session ใหม่ด้วย `session/load` เพื่อให้บทสนทนาและ hunk ของรีวิวตรงกับที่ engine เห็นตอนนี้
                ref: "packages/extension/src/chat/chat.ts#\"reload: () => this.reshow(),\""
              - lane: panel
                at: rail
                do: >-
                  บทสนทนายังอยู่ครบ ใต้ข้อความขึ้นบรรทัดบอกไฟล์ที่คืน คำขอถัดไปของโมเดลจะมีประกาศว่าผู้ใช้ย้อน workspace
                  และให้อ่านไฟล์ใหม่ก่อนแก้
                sees: >-
                  บรรทัด "Restored 2 files: src/date.ts, src/date.test.ts." ใต้ข้อความ
                ref: packages/extension/src/chat/rewind-model.ts#restoredText
                end: { turn: none }
          - id: conversation
            label: Restore conversation
            steps:
              - lane: editor
                at: chat
                do: >-
                  การย้อนบทสนทนาไม่ต้องยืนยัน `RewindHost` ส่งคำขอ `REWIND_TURN_METHOD` พร้อม `kind: conversation` ทันที
                ref: packages/extension/src/chat/rewind-host.ts#RewindHost
                emits: [REWIND_TURN_METHOD]
              - lane: server
                at: sessions
                do: >-
                  engine ปฏิเสธถ้า session มี turn ทำงาน แล้วหยุดงานเบื้องหลังและการปลุกที่ turn ที่ถูกตัดเริ่มไว้ เพราะไม่มี turn ให้รายงานแล้ว
                ref: "packages/engine/src/serve.ts#\"if (turns.get(sessionId) !== undefined) throw acp.RequestError.invalidRequest({ sessionId }, 'stop the running turn before rewinding the session');\""
              - lane: server
                at: sessions
                do: >-
                  `rewindSession` บันทึก event `cut` ที่เลขลำดับของข้อความ log ไม่ลบอะไรทิ้ง ผู้อ่าน log เห็นมุมมองที่ตัดแล้ว
                  และคืนข้อความที่ผู้ใช้พิมพ์ไว้ในข้อความนั้น
                ref: packages/engine/src/rewind.ts#rewindSession
                emits: [cut]
              - lane: editor
                at: chat
                do: >-
                  ส่วนขยายโหลด session ใหม่ แล้วส่ง `rewind-prompt` พร้อมข้อความเดิมให้แผง
                ref: "packages/extension/src/chat/chat.ts#\"reload: () => this.reshow(),\""
              - lane: panel
                at: composer
                do: >-
                  turn ตั้งแต่ข้อความนั้นหายจากแผง และข้อความเดิมกลับไปที่ช่องพิมพ์ให้แก้แล้วส่งใหม่
                  คำสั่งแบบ slash กลับมาเป็น `/ชื่อ อาร์กิวเมนต์` ไม่ใช่ข้อความที่ขยายแล้ว
                sees: บทสนทนาเหลือแค่ turn แรก และช่องพิมพ์มีข้อความของ turn ที่สอง
                ref: "packages/extension/src/chat/webview.ts#\"if (message.type === 'rewind-prompt') return edit(message.text, undefined);\""
                end: { turn: none }
---

Rewind ใช้สองอย่างที่ engine เก็บไว้อยู่แล้ว: checkpoint ของ workspace ที่ถ่ายก่อนการเรียกโมเดลทุกครั้ง
และ log ของ session ที่ไม่เคยลบอะไร การย้อนบทสนทนาจึงเป็นการเพิ่ม event `cut` ไม่ใช่การลบบรรทัด

| เลือก | ไฟล์ | บทสนทนา | ข้อความเดิม |
| --- | --- | --- | --- |
| Restore files | คืนจาก checkpoint | อยู่ครบ | ไม่เปลี่ยน |
| Restore conversation | ไม่แตะ | ตัดตั้งแต่ข้อความนั้น | กลับไปที่ช่องพิมพ์ |
| Restore both | คืนจาก checkpoint | ตัดตั้งแต่ข้อความนั้น | กลับไปที่ช่องพิมพ์ |

สิ่งที่ควรสังเกต

- **checkpoint ของ turn คือก่อนการเรียกโมเดลครั้งแรก** engine ถ่าย checkpoint ก่อนการเรียกโมเดลทุกครั้ง การย้อนไฟล์ใช้อันแรกของ turn
  turn ที่ไม่เคยถึงโมเดล เช่นถูกหยุดก่อน จึงไม่มี checkpoint ให้ย้อน
- **ไฟล์ก่อน บทสนทนาทีหลัง** Restore both บันทึก `restored` ก่อน `cut` ประกาศเรื่องไฟล์จึงถูกตัดไปพร้อมกับ turn ที่มันพูดถึง
- **การแก้ของผู้ใช้หลัง checkpoint ล่าสุดหายได้** กล่องยืนยันบอกไฟล์เหล่านั้นก่อน และให้แป้นพิมพ์เริ่มที่ Cancel
