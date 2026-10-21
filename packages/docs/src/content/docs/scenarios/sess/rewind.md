---
title: ย้อนไฟล์และ/หรือบทสนทนา
description: ผู้ใช้เปิดเมนูบนข้อความหนึ่งแล้วเลือกย้อนไฟล์ ย้อนบทสนทนา ทั้งสองอย่าง หรือ fork เป็นแชตใหม่ engine คืนไฟล์จาก checkpoint ก่อนข้อความนั้น ตัดบทสนทนาด้วย event cut และคืนข้อความกลับไปที่ช่องพิมพ์
scenario:
  surface: vscode
  given:
    - แชตมีหลาย turn และไม่มี turn ทำงานอยู่
    - turn ที่สองแก้ `src/date.ts` และ `src/date.test.ts` ก่อนหน้านั้น engine เก็บ checkpoint ของ workspace ไว้แล้ว
  trigger: >-
    ผู้ใช้ชี้ที่บับเบิลข้อความของ turn ที่สอง แล้วคลิกปุ่ม "Rewind, fork or mark a chapter"
  covers: [sess.rewind, sess.fork]
  related: [ed.review-auto-undo, sess.open-history, sess.new-chat]
  steps:
    - id: menu
      beat:
        title: คุณเปิดเมนูบนข้อความของ turn ที่สอง
        text: >-
          เมนูขึ้นเฉพาะตอนที่ไม่มี turn ทำงาน และเฉพาะแชตที่ loop ของ Geno เองรัน ไม่ใช่ agent ภายนอก Restore files คืนไฟล์ให้เหมือนก่อนข้อความนี้ Restore conversation ตัดบทสนทนา
          ตั้งแต่ข้อความนี้ Fork from here สร้างแชตใหม่ที่ลอกบทสนทนามาถึงข้อความนี้รวมคำตอบของมัน ส่วน Restore both ทำสองอย่างแรก
          โดยยืนยันแบบ Restore files แล้วคืนไฟล์ก่อนตัดบทสนทนา ทางด้านล่างแยกเฉพาะ Restore files กับ Restore conversation
        from: you
        to: panel
        sees: เมนู Restore files, Restore conversation, Restore both และ Fork from here
        ask: คุณเลือกอะไร
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
                beat:
                  title: แชตถามว่าจะเขียนทับไฟล์ไหน
                  text: การย้อนไฟล์เขียนทับงานบนดิสก์จึงต้องยืนยันก่อน VS Code ถาม engine ก่อนว่าจะเขียนทับไฟล์ไหน
                  from: panel
                  to: engine
                at: chat
                do: >-
                  การย้อนไฟล์ต้องยืนยันก่อน `RewindHost` ส่งคำขอ `REWIND_PREVIEW_METHOD` ถาม engine ว่าจะเขียนทับไฟล์ไหน
                ref: packages/extension/src/chat/rewind-host.ts#RewindHost
                emits: [REWIND_PREVIEW_METHOD]
              - lane: server
                beat:
                  title: Geno เทียบกับ checkpoint
                  text: >-
                    checkpoint คือภาพถ่ายไฟล์ใน workspace ที่ Geno ถ่ายก่อนเรียก model ทุกครั้ง และเก็บใน git repo ซ่อนนอกโฟลเดอร์ของคุณ
                    Geno เทียบ workspace ตอนนี้กับ checkpoint ก่อนการเรียก model ครั้งแรกของ turn นั้น และหาการแก้ที่เกิดหลัง checkpoint
                    ล่าสุด ซึ่งไม่มี checkpoint ไหนเก็บไว้ จึงจะหายถ้าย้อน
                  from: engine
                  to: engine
                at: sessions
                do: >-
                  `rewindPreview` เทียบ workspace กับ checkpoint ก่อนการเรียก model ครั้งแรกของ turn นั้นใน repository เงาของ checkpoint
                  และหาไฟล์ที่เปลี่ยนหลัง checkpoint ล่าสุด ซึ่งไม่มี checkpoint ไหนเก็บไว้
                ref: packages/engine/src/rewind.ts#rewindPreview
              - lane: panel
                beat:
                  title: คุณเห็นกล่องยืนยัน
                  text: กล่องบอกจำนวนและชื่อไฟล์ ถ้ามีการแก้ที่จะหาย กล่องเตือนและแป้นพิมพ์เริ่มที่ Cancel
                  from: panel
                  to: you
                  sees: '"Restore 2 files to before this message: src/date.ts, src/date.test.ts." ปุ่ม [Cancel] [Restore files]'
                at: rail
                do: >-
                  ใต้ข้อความขึ้นกล่องยืนยันที่บอกจำนวนและชื่อไฟล์ ถ้ามีการแก้ที่ไม่มีใน checkpoint ใด กล่องเตือนว่าจะหายและให้แป้นพิมพ์เริ่มที่ Cancel
                sees: >-
                  "Restore 2 files to before this message: src/date.ts, src/date.test.ts." ปุ่ม [Cancel] [Restore files]
                ref: packages/extension/src/chat/rewind-model.ts#confirmOf
              - lane: user
                beat:
                  title: คุณกด Restore files
                  text: VS Code ส่งคำขอย้อนไฟล์พร้อมเลขลำดับของข้อความใน log
                  from: you
                  to: panel
                do: ผู้ใช้กด Restore files
              - lane: editor
                at: chat
                do: >-
                  `RewindHost` ส่งคำขอ `REWIND_TURN_METHOD` พร้อมเลขลำดับของข้อความและ `kind: files`
                ref: packages/extension/src/chat/rewind-host.ts#RewindHost
                emits: [REWIND_TURN_METHOD]
              - lane: server
                beat:
                  title: Geno คืนไฟล์จาก checkpoint
                  text: >-
                    Geno ปฏิเสธถ้ามี turn ทำงาน แล้วคืนไฟล์จาก checkpoint ลบไฟล์ที่สร้างทีหลัง และบันทึก event `restored` ลง log
                    VS Code โหลด session ใหม่ เพื่อให้ hunk ในรีวิว (ก้อนบรรทัดที่แก้ซึ่งคุณกด Keep หรือ Undo ได้) ตรงกับไฟล์ตอนนี้
                  from: engine
                  to: machine
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
                beat:
                  title: บรรทัดบอกไฟล์ที่คืน
                  text: บทสนทนายังอยู่ครบ model ยังไม่รู้เรื่องนี้ แต่ request ถัดไปที่ส่งให้ model จะมีประกาศว่าคุณย้อน workspace และให้อ่านไฟล์ใหม่ก่อนแก้
                  from: panel
                  to: you
                  sees: 'บรรทัด "Restored 2 files: src/date.ts, src/date.test.ts." ใต้ข้อความ'
                  end: ไฟล์ย้อนแล้ว
                at: rail
                do: >-
                  บทสนทนายังอยู่ครบ ใต้ข้อความขึ้นบรรทัดบอกไฟล์ที่คืน คำขอถัดไปของ model จะมีประกาศว่าผู้ใช้ย้อน workspace
                  และให้อ่านไฟล์ใหม่ก่อนแก้
                sees: >-
                  บรรทัด "Restored 2 files: src/date.ts, src/date.test.ts." ใต้ข้อความ
                ref: packages/extension/src/chat/rewind-model.ts#restoredText
                end: { turn: none }
          - id: conversation
            label: Restore conversation
            steps:
              - lane: editor
                beat:
                  title: แชตขอย้อนบทสนทนาทันที
                  text: การย้อนบทสนทนาไม่ต้องยืนยัน เพราะ log ไม่ลบอะไรทิ้ง VS Code ส่งคำขอไปที่ engine ทันที
                  from: panel
                  to: engine
                at: chat
                do: >-
                  การย้อนบทสนทนาไม่ต้องยืนยัน `RewindHost` ส่งคำขอ `REWIND_TURN_METHOD` พร้อม `kind: conversation` ทันที
                ref: packages/extension/src/chat/rewind-host.ts#RewindHost
                emits: [REWIND_TURN_METHOD]
              - lane: server
                beat:
                  title: Geno หยุดงานของ turn ที่ถูกตัด
                  text: >-
                    Geno ปฏิเสธถ้ามี turn ทำงาน แล้วหยุดคำสั่งเบื้องหลังและการปลุก (สิ่งที่จะเริ่ม turn ใหม่เองภายหลัง)
                    ที่ turn ที่ถูกตัดเริ่มไว้ เพราะไม่มี turn ให้รายงานแล้ว
                  from: engine
                  to: engine
                at: sessions
                do: >-
                  engine ปฏิเสธถ้า session มี turn ทำงาน แล้วหยุดงานเบื้องหลังและการปลุกที่ turn ที่ถูกตัดเริ่มไว้ เพราะไม่มี turn ให้รายงานแล้ว
                ref: "packages/engine/src/serve.ts#\"if (turns.get(sessionId) !== undefined) throw acp.RequestError.invalidRequest({ sessionId }, 'stop the running turn before rewinding the session');\""
              - lane: server
                beat:
                  title: Geno บันทึกจุดตัดลง log
                  text: >-
                    Geno บันทึก event `cut` ที่ข้อความนั้นต่อท้าย log ไม่ลบบรรทัดไหน ทุกส่วนที่อ่าน log รวมถึงการสร้าง request ให้ model
                    ข้ามตั้งแต่ข้อความนั้นไป Geno คืนข้อความที่คุณพิมพ์ไว้ในข้อความนั้นให้ VS Code
                  from: engine
                  to: engine
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
                beat:
                  title: ข้อความเดิมกลับไปที่ช่องพิมพ์
                  text: turn ตั้งแต่ข้อความนั้นหายจากแผง ข้อความเดิมอยู่ในช่องพิมพ์ให้แก้แล้วส่งใหม่ ถ้าเป็นคำสั่ง `/` จะกลับมาเป็น `/ชื่อ อาร์กิวเมนต์` ไม่ใช่ข้อความที่ขยายแล้ว
                  from: panel
                  to: you
                  sees: บทสนทนาเหลือแค่ turn แรก และช่องพิมพ์มีข้อความของ turn ที่สอง
                  end: แก้แล้วส่งใหม่
                at: composer
                do: >-
                  turn ตั้งแต่ข้อความนั้นหายจากแผง และข้อความเดิมกลับไปที่ช่องพิมพ์ให้แก้แล้วส่งใหม่
                  คำสั่งแบบ slash กลับมาเป็น `/ชื่อ อาร์กิวเมนต์` ไม่ใช่ข้อความที่ขยายแล้ว
                sees: บทสนทนาเหลือแค่ turn แรก และช่องพิมพ์มีข้อความของ turn ที่สอง
                ref: "packages/extension/src/chat/webview.ts#\"if (message.type === 'rewind-prompt') return edit(message.text, undefined);\""
                end: { turn: none }
          - id: fork
            label: Fork from here
            steps:
              - lane: editor
                beat:
                  title: แชตขอ fork จากข้อความนี้
                  text: ใต้ข้อความขึ้น "Forking…" VS Code ขอ engine fork session นี้ที่เลขลำดับของข้อความ
                  from: panel
                  to: engine
                at: chat
                do: >-
                  `RewindHost` แสดง "Forking…" ใต้ข้อความ แล้วส่งคำขอ ACP `session/fork` พร้อมเลขลำดับของข้อความใน `_meta` ใต้ `gcode/forkAt`
                ref: packages/extension/src/chat/rewind-host.ts#RewindHost
                emits: [session/fork, gcode/forkAt]
              - lane: server
                beat:
                  title: Geno เขียน log ใหม่
                  text: >-
                    Geno ปฏิเสธถ้ามี turn รัน ถ้าแชตรันด้วย agent ภายนอกแทน loop ของ Geno หรือถ้าเป็น subagent (session ลูกที่ model สร้างให้ทำงานย่อย)
                    ไม่อย่างนั้นมันเขียน log ใหม่ที่ชี้กลับมาที่แชตเดิม แล้วลอกบทสนทนาจนจบคำตอบของข้อความนั้น แชตเดิมไม่ถูกแตะ
                  from: engine
                  to: engine
                at: sessions
                do: >-
                  engine ปฏิเสธถ้ามี turn รันอยู่ หรือถ้าเป็น session ของ agent ภายนอกหรือของ subagent
                  `forkSession` เขียน log ใหม่: `session-start` ที่มี `fork` ชี้กลับมาที่แชตเดิม แล้วบทสนทนาตามที่เห็นหลัง cut ทั้งหมด
                  จนจบ turn ของข้อความนั้น (รวมคำตอบของมัน) การรอและการปลุกที่ค้างไม่ถูกคัดลอก โฟลเดอร์ของ session (ไฟล์แนบ ผลที่ยาว) ถูกคัดลอกไปด้วย
                ref: packages/core/src/rewind.ts#forkEvents
                emits: [session-start, fork]
              - lane: server
                at: sessions
                do: >-
                  engine ลงทะเบียนโหมดและ MCP ของ session ใหม่ แล้วตอบด้วย session id ใหม่ แชตเดิมไม่ถูกแตะ
                ref: packages/engine/src/rewind.ts#forkSession
              - lane: editor
                beat:
                  title: แผงเปิดแชตใหม่
                  text: engine เล่น log ของแชตใหม่ซ้ำ บทสนทนาจบที่คำตอบของข้อความที่เลือก History บอกที่มาของมัน
                  from: panel
                  to: you
                  sees: แชตใหม่ที่จบที่คำตอบของข้อความนั้น และบรรทัด "Forked from <ชื่อแชตเดิม>" ใน History
                  end: แชตใหม่แยกออกมา
                at: chat
                do: >-
                  ส่วนขยายเปิด session ใหม่ในแผงแทนแชตเดิม engine เล่นซ้ำ log ของมันให้แผง
                ref: packages/extension/src/chat/rewind-host.ts#RewindHost
              - lane: panel
                at: rail
                do: >-
                  แผงแสดงแชตใหม่ที่มีบทสนทนาจนถึงคำตอบของข้อความที่เลือก ใน History และแผง Tasks แชตใหม่มีบรรทัดบอกที่มา
                sees: แชตใหม่ที่จบที่คำตอบของข้อความนั้น และบรรทัด "Forked from <ชื่อแชตเดิม>" ใน History
                ref: packages/extension/src/chat/history.ts#historyPanel
                end: { turn: none }
---

Rewind ใช้สองอย่างที่ engine เก็บไว้อยู่แล้ว: [checkpoint](/start/glossary/) ของ workspace ที่ถ่ายก่อนการเรียก model ทุกครั้ง
และ [session log](/start/glossary/) ที่ไม่เคยลบอะไร การย้อนบทสนทนาจึงเป็นการเพิ่ม event `cut` ไม่ใช่การลบบรรทัด

| เลือก | ไฟล์ | บทสนทนา | ข้อความเดิม |
| --- | --- | --- | --- |
| Restore files | คืนจาก checkpoint | อยู่ครบ | ไม่เปลี่ยน |
| Restore conversation | ไม่แตะ | ตัดตั้งแต่ข้อความนั้น | กลับไปที่ช่องพิมพ์ |
| Restore both | คืนจาก checkpoint (ไม่มีบรรทัดบอกไฟล์ที่คืน) | ตัดตั้งแต่ข้อความนั้น | กลับไปที่ช่องพิมพ์ |
| Fork from here | ไม่แตะ | แชตใหม่ที่ลอกถึงคำตอบของข้อความนั้น แชตเดิมอยู่ครบ | ไม่เปลี่ยน |

สิ่งที่ควรสังเกต

- **checkpoint ของ turn คือก่อนการเรียก model ครั้งแรก** engine ถ่าย checkpoint ก่อนการเรียก model ทุกครั้ง การย้อนไฟล์ใช้อันแรกของ turn
  turn ที่ไม่เคยถึง model เช่นถูกหยุดก่อน จึงไม่มี checkpoint ให้ย้อน
- **ไฟล์ก่อน บทสนทนาทีหลัง** Restore both บันทึก `restored` ก่อน `cut` ประกาศเรื่องไฟล์จึงถูกตัดไปพร้อมกับ turn ที่มันพูดถึง
  model จึงไม่ได้รับประกาศนี้ ซึ่งไม่จำเป็นเพราะ turn ที่แก้ไฟล์ถูกตัดไปด้วย
- **การแก้ของผู้ใช้หลัง checkpoint ล่าสุดหายได้** กล่องยืนยันบอกไฟล์เหล่านั้นก่อน และให้แป้นพิมพ์เริ่มที่ Cancel
- **Fork ลอกคำตอบด้วย** รายการในเมนูบอกว่า "A new chat with the conversation up to this message" แต่ `forkEvents` ลอกจนจบ turn ของข้อความนั้น
  แชตใหม่จึงมีคำตอบของข้อความที่เลือกด้วย ไม่ได้หยุดก่อนข้อความ
