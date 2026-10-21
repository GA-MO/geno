---
title: สลับออกจากแชตที่ยังทำงาน
description: ผู้ใช้เปิดแชตใหม่ระหว่างที่ turn ของแชตเดิมทำงาน turn นั้นทำงานต่อเบื้องหลังในแผง Tasks และเรียกผู้ใช้กลับเมื่อจบหรือเมื่อต้องการคำตอบ
scenario:
  surface: vscode
  given:
    - turn ของแชต "Fix date parsing" กำลังทำงานในโหมด Ask
    - หน้าต่าง VS Code มีโฟกัส
  trigger: >-
    ผู้ใช้คลิกปุ่ม New Chat (+) บนหัวของแผง หรือเปิดแชตอื่นจาก History
  covers: [sess.leave-running]
  related: [sess.reload-while-running, sess.new-chat, sess.open-history, perm.ask-allow]
  steps:
    - id: new
      beat:
        title: คุณเปิดแชตใหม่ระหว่าง turn ทำงาน
        text: turn ของแชต "Fix date parsing" ยังไม่จบ คุณกด New Chat หรือเปิดแชตอื่นจาก History
        from: you
        to: panel
      lane: user
      do: ผู้ใช้เปิดแชตใหม่ระหว่างที่ turn ยังไม่จบ
      phase: calling-model

    - id: leave
      beat:
        title: แชตปล่อย turn เดิมไว้
        text: >-
          ถ้ามีการ์ดที่รอคุณตอบ เช่นการ์ด permission ที่ถามว่าให้รันคำสั่งไหม VS Code ตอบ engine ว่าการ์ดนั้นไม่ได้แสดงแล้ว
          ไม่ใช่ปฏิเสธ engine จึงจะถามใหม่ทีหลัง จากนั้น VS Code ขอ engine เลิกส่งอัปเดตของแชตนี้มาที่หน้าต่างนี้ แต่ turn ทำงานต่อ
        from: panel
        to: engine
      lane: editor
      at: chat
      do: >-
        `moveTo` เห็นว่าแชตที่กำลังจะออกมี turn ทำงาน `leaveRunning` ปล่อย turn นั้นจากแผง
        การ์ดที่เปิดค้างถูกตอบว่าไม่ได้แสดงแล้ว (engine จะถามใหม่) จากนั้น `moveTo` ส่งคำขอ `DETACH_METHOD` ก่อนเปิดแชตถัดไป
      ref: packages/extension/src/chat/chat.ts#Chat.leaveRunning
      emits: [DETACH_METHOD]

    - id: detach
      lane: server
      at: sessions
      do: >-
        engine เอาหน้าต่างนี้ออกจากผู้ดู session นั้น turn ทำงานต่อ อัปเดตสดไม่ถูกส่งมาที่หน้าต่างนี้อีก
        session เดิมไม่ถูกปิด เพราะ `session/close` จะหยุด turn ที่ทำงานอยู่ และปิด MCP server ที่ turn ยังใช้
      ref: "packages/engine/src/serve.ts#\".onRequest(DETACH_METHOD, sessionRequest, async ({ params }) => {\""

    - id: fresh
      beat:
        title: แผงแสดงแชตถัดไป
        text: >-
          ถ้าคุณกด New Chat engine สร้าง session ใหม่ แผงว่างและปุ่ม Send กลับมา ถ้าคุณเปิดแชตอื่นจาก History
          engine โหลดแชตนั้นแล้วแผงแสดงบทสนทนาของมันแทน ทั้งสองทาง แผง Tasks (รายการ turn ของทุกแชตที่ทำงาน รอคุณ หรือจบแล้ว)
          ยังแสดงแชตเดิมว่าทำงานอยู่
        from: engine
        to: panel
        sees: หน้าเริ่มต้นของแชตใหม่ (หรือบทสนทนาของแชตที่เปิดจาก History) และในแผง Tasks แถว "Fix date parsing" ยังทำงานอยู่
      lane: editor
      at: chat
      do: >-
        `fresh` ส่งคำขอ ACP `session/new` สำหรับแชตใหม่ แล้วให้แผงแสดง session ใหม่
        (ถ้าเปิดจาก History `moveTo` เรียก `load` ซึ่งส่ง `session/load` แทน แล้วแผงแสดงบทสนทนาของแชตนั้น)
      ref: packages/extension/src/chat/chat.ts#Chat.fresh

    - id: empty
      lane: panel
      at: rail
      alongside: true
      do: >-
        แผงได้ `reset` เป็นบทสนทนาว่าง ปุ่ม Send กลับมาเพราะแชตนี้ไม่มี turn ทำงาน
      sees: >-
        หน้าเริ่มต้นของแชตใหม่ ปุ่ม Send และในแผง Tasks แถว "Fix date parsing" ยังทำงานอยู่
      ref: packages/extension/src/chat/webview.ts#render

    - id: away
      beat:
        title: turn เดิมทำงานต่อเบื้องหลัง
        text: >-
          agent loop ของแชตเดิม (วงที่เรียก model รัน tool แล้ววนต่อ) ทำงานต่อโดยไม่รู้ว่าไม่มีใครดูอยู่
          session log ยังบันทึกทุกอย่าง ต่อจากนี้ขึ้นกับว่า turn ไปถึงอะไรก่อน
        from: engine
        to: engine
        ask: ไปถึงอะไรก่อน
      lane: loop
      at: drive
      do: >-
        loop ของแชตเดิมทำงานต่อเหมือนไม่มีอะไรเปลี่ยน มันไม่รู้ว่าไม่มีใครดูอยู่ log ยังบันทึกทุก event
      ref: packages/engine/src/drive.ts#drive
      fork:
        ask: turn ที่ทำงานเบื้องหลังไปถึงอะไรก่อน
        options:
          - id: asks
            label: ต้องขออนุญาตผู้ใช้
            steps:
              - lane: policy
                beat:
                  title: turn ต้องขอ permission
                  text: model ขอรันคำสั่งที่ไม่อยู่ในรายการปลอดภัย โหมด Ask จึงต้องถามคุณก่อนรัน
                  from: engine
                  to: engine
                at: settle
                do: >-
                  คำสั่งถัดไปไม่อยู่ใน safe list `settle` จึงขอให้ผู้ใช้ตัดสินผ่าน `approval.approve`
                ref: packages/engine/src/tools/agent.ts#settle
                phase: waiting-user
              - lane: server
                beat:
                  title: Geno รอจนมีคนดู
                  text: ไม่มีหน้าต่างไหนแสดง session นี้ จึงไม่มีที่ให้วาดการ์ด Geno รอจนกว่าจะมีหน้าต่างเปิดแชตนี้ แถวในแผง Tasks เปลี่ยนเป็นรอคุณ
                  from: engine
                  to: panel
                  sees:
                    kind: task
                    title: Fix date parsing
                    status: needs-input
                at: approvals
                do: >-
                  `Viewers.ask` ไม่พบ editor ที่แสดง session นี้ จึงรอจนกว่าจะมี งานใน Tasks เปลี่ยนเป็น `needs-input`
                ref: packages/engine/src/viewers.ts#Viewers.ask
                emits: [needs-input]
              - lane: editor
                beat:
                  title: VS Code แจ้งเตือน
                  text: VS Code ขึ้นการแจ้งเตือนที่มีปุ่ม Open ถ้าหน้าต่างไม่มีโฟกัสบน macOS ก็แจ้งผ่าน OS ด้วย
                  from: panel
                  to: you
                  sees:
                    kind: toast
                    text: "Geno needs your permission: Fix date parsing"
                    actions:
                      - Open
                at: vscode-ui
                do: >-
                  `TaskHost.updated` เห็นงานต้องการผู้ใช้ `tell` ขึ้นการแจ้งเตือนของ VS Code ที่มีปุ่ม Open
                  และถ้าหน้าต่างไม่มีโฟกัสบน macOS ก็แจ้งเตือนของ OS ด้วย
                sees: >-
                  การแจ้งเตือน "Geno needs your permission: Fix date parsing" พร้อมปุ่ม [Open]
                ref: packages/extension/src/chat/tasks-host.ts#TaskHost.tell
              - lane: user
                beat:
                  title: คุณกด Open
                  text: แชตเดิมเปิดขึ้น engine ส่งสิ่งที่ turn ทำไปแล้วให้แผงวาดใหม่ แผงรับดูแล turn ต่อ แล้ว Geno ส่งคำถาม permission มาที่หน้าต่างนี้อีกครั้ง
                  from: you
                  to: panel
                do: ผู้ใช้คลิก Open
              - lane: editor
                at: chat
                do: >-
                  `TaskHost.open` เปิดแชตเดิม ซึ่งออกจากแชตใหม่และส่ง `session/load` ของแชตเดิม
                  engine เล่นซ้ำ turn ที่กำลังทำงาน แผงรับช่วง turn และ `Viewers.ask` ส่งคำขอ `session/request_permission` มาที่หน้าต่างนี้
                ref: packages/extension/src/chat/tasks-host.ts#TaskHost.open
                emits: [requestPermission]
              - lane: panel
                beat:
                  title: แชตเดิมกลับมาพร้อมการ์ด
                  text: บทสนทนาเดิมขึ้นพร้อมการ์ดที่รออยู่ จากตรงนี้เหมือนการ์ดของโหมด Ask
                  from: panel
                  to: you
                  sees: บทสนทนา "Fix date parsing" หัวข้อ "waiting for you" และการ์ดขออนุญาต
                  end: ตอบการ์ดตามปกติ
                at: card
                do: แผงแสดงบทสนทนาเดิมพร้อมการ์ดที่รออยู่
                sees: บทสนทนา "Fix date parsing" หัวข้อ "waiting for you" และการ์ดขออนุญาต
                ref: packages/extension/src/chat/render.ts#permissionCard
                goto: perm.ask-allow
          - id: finishes
            label: จบเอง
            steps:
              - lane: server
                beat:
                  title: turn จบเอง
                  text: แถวในแผง Tasks เปลี่ยนเป็นเสร็จ แชตที่แสดงอยู่ไม่ใช่แชตนั้น จึงไม่วาดอะไรเพิ่ม
                  from: engine
                  to: panel
                at: tasks
                do: >-
                  turn จบแบบ done งานใน Tasks เปลี่ยนเป็น done และส่ง `TASK_UPDATE_METHOD` ให้ทุกหน้าต่าง
                  คำตอบของ `session/prompt` ไปถึงหน้าต่างนี้ แต่แผงปล่อย turn นั้นไปแล้ว จึงไม่วาดอะไรในแชตที่แสดงอยู่
                ref: "packages/engine/src/serve.ts#\"if (peer.tasks) void connection.client.notify(TASK_UPDATE_METHOD, update).catch(() => {});\""
                emits: [TASK_UPDATE_METHOD]
                phase: ending
              - lane: editor
                beat:
                  title: VS Code บอกว่างานเสร็จ
                  text: แชตนั้นไม่ได้แสดงอยู่ VS Code จึงแจ้งเตือน การจบไม่แจ้งผ่าน OS
                  from: panel
                  to: you
                  sees:
                    kind: toast
                    text: "Geno finished: Fix date parsing"
                    actions:
                      - Open
                  end: เปิดดูเมื่อพร้อม
                at: vscode-ui
                do: >-
                  `TaskHost.updated` เห็นงานเปลี่ยนจากกำลังทำงานเป็นพร้อมให้ดู แชตนั้นไม่ได้แสดงอยู่ `tell` จึงขึ้นการแจ้งเตือนของ VS Code
                  การจบไม่แจ้งเตือนของ OS
                sees: >-
                  การแจ้งเตือน "Geno finished: Fix date parsing" พร้อมปุ่ม [Open] และแถวในแผง Tasks เปลี่ยนเป็นเสร็จ
                ref: packages/extension/src/chat/notices.ts#ATTENTION_NOTICES
                end: { turn: done, reason: end_turn }
---

แชตในแผงเป็นแค่หน้าต่างที่มองเข้าไปใน session ของ engine (process แยกที่เดิน turn ดู [ส่วนประกอบของ Geno](/foundations/parts-of-geno/)) การเปลี่ยนแชตจึงไม่หยุดอะไร
turn ที่ทำงานอยู่ย้ายไปอยู่ในแผง Tasks และเรียกผู้ใช้กลับเมื่อต้องการ

| เมื่อ | VS Code ทำอะไร |
| --- | --- |
| turn ต้องการคำตอบ | แจ้งเตือน "needs your permission" หรือ "needs your answer" และแจ้ง OS ถ้าหน้าต่างไม่มีโฟกัส (เฉพาะ macOS) |
| turn ล้มเหลว | แจ้งเตือน "failed" และแจ้ง OS ถ้าหน้าต่างไม่มีโฟกัส (เฉพาะ macOS) |
| turn จบ | แจ้งเตือน "finished" ใน VS Code เท่านั้น |

สิ่งที่ควรสังเกต

- **session เดิมไม่ถูกปิด** `moveTo` ส่ง `session/close` ให้แชตที่ออกเฉพาะเมื่อไม่มี turn ทำงาน เพราะ `session/close` หยุด turn ของ session นั้นด้วย แชตที่ทำงานอยู่จึงทำงานต่อและยังมี [MCP server](/start/glossary/) (โปรแกรมภายนอกที่เสนอ tool ให้ session)
- **การ์ดไม่หาย** การ์ดที่เปิดอยู่ตอนออกถูกตอบว่าไม่ได้แสดง ไม่ใช่ปฏิเสธ engine ถามใหม่เมื่อมีหน้าต่างเปิดแชตนั้นอีกครั้ง
- **ไม่ต้องกลับไปที่หน้าต่างเดิม** หน้าต่างอื่นของโฟลเดอร์เดียวกันที่เปิดแชตนั้นก็รับช่วง turn และตอบการ์ดได้
