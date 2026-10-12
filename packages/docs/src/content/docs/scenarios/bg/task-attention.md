---
title: งานเบื้องหลังต้องการความสนใจ
description: งานที่ผู้ใช้ไม่ได้ดูอยู่ขออนุญาต เสร็จ หรือล้ม Geno แจ้งผ่าน VS Code และการแจ้งเตือนของ macOS แล้วพาไปยังจุดที่ต้องดู
tableOfContents: false
sidebar:
  order: 3
scenario:
  surface: vscode
  given:
    - ผู้ใช้สั่งงานยาวใน session "migrate tests" แล้วเปลี่ยนแผงแชตไปอีก session งานเดิมยังรันต่อใน engine
    - ผู้ใช้สลับไปทำงานในเบราว์เซอร์ หน้าต่าง VS Code ไม่ได้โฟกัส และค่า `gcode.tasks.osNotifications` เปิดอยู่ (ค่าเริ่มต้น)
  trigger: >-
    งานของ session "migrate tests" เปลี่ยนสถานะ
  covers: [bg.task-attention]
  related: [bg.child-wakes-parent, perm.ask-allow, err.offline-wait, sess.leave-running]
  steps:
    - id: change
      beat:
        title: งานของ “migrate tests” เปลี่ยนสถานะ
        text: คุณเปลี่ยนแชตไปอีก session และสลับไปเบราว์เซอร์ engine บันทึกสถานะใหม่ของงาน ตัดสินว่าควรแจ้งไหม แล้วส่งให้ทุกหน้าต่าง
        to: panel
        ask: งานเปลี่ยนเป็นอะไร
      lane: server
      at: tasks
      do: >-
        `Tasks.put` บันทึกสถานะใหม่ของงาน คำนวณว่าการเปลี่ยนนี้ควรแจ้งไหม (`taskNotice`) แล้วส่ง notification
        `_gcode/taskUpdate` ให้ทุกหน้าต่างที่เชื่อมอยู่ ถ้าตอนนั้นไม่มีหน้าต่างเลย การแจ้งถูกเก็บไว้ส่งเมื่อหน้าต่างเชื่อมมา
      ref: packages/engine/src/tasks.ts#Tasks.put
      emits: [_gcode/taskUpdate]
      fork:
        ask: งานเปลี่ยนเป็นอะไร
        options:
          - id: permission
            label: ต้องขออนุญาต
            steps:
              - lane: editor
                beat:
                  title: งานต้องขอ permission
                  text: งานย้ายเข้ากลุ่ม Needs you ตัวเลขบนไอคอนเพิ่มขึ้น หน้าต่างไม่ได้โฟกัส Geno จึงแจ้งทั้งใน VS Code และผ่าน macOS
                at: chat
                do: >-
                  `TaskHost.updated` จัดงานใหม่ งานย้ายเข้า Needs you ด้วยเหตุ `permission` `attentionNotice` ได้
                  การแจ้งระดับ warning ที่ส่งถึงระบบปฏิบัติการได้ และตัวเลขบนไอคอนของ view เพิ่มขึ้น
                ref: packages/extension/src/chat/tasks-host.ts#TaskHost.updated
                emits: [needs-input]
                phase: waiting-user
              - lane: editor
                at: chat
                do: >-
                  `channelsOf` เห็นว่าหน้าต่างไม่ได้โฟกัส จึงใช้ทั้ง toast ของ VS Code และการแจ้งเตือนของ macOS
                ref: packages/extension/src/chat/notices.ts#channelsOf
              - lane: external
                beat:
                  title: macOS แจ้งเตือน
                  text: ชื่องานไปเป็นข้อความของการแจ้งเตือนเท่านั้น จึงรันเป็น script ไม่ได้
                  from: machine
                  sees: 'การแจ้งเตือนของ macOS หัวข้อ "Geno" ข้อความ "Geno needs your permission: migrate tests"'
                do: >-
                  `osascript` แสดงการแจ้งเตือนของ macOS ข้อความส่งเป็นอาร์กิวเมนต์ ไม่ใช่ตัวสคริปต์ ชื่องานจึงรันเป็น AppleScript ไม่ได้
                sees: >-
                  การแจ้งเตือนของ macOS หัวข้อ "Geno" ข้อความ "Geno needs your permission: migrate tests"
                ref: packages/extension/src/chat/notices.ts#osNotification
              - lane: user
                beat:
                  title: คุณกด Open บน toast
                  text: คุณกลับมาที่ VS Code และกด Open
                  sees:
                    kind: toast
                    text: "Geno needs your permission: migrate tests"
                    actions:
                      - Open
                do: >-
                  ผู้ใช้กลับมาที่ VS Code และกด Open บน toast "Geno needs your permission: migrate tests"
              - lane: panel
                beat:
                  title: แชตพาไปที่การ์ดที่รออยู่
                  text: แชตเปิด session นั้นแล้วเลื่อนไปที่การ์ดที่รอคำตอบของคุณ
                  end: คุณตอบการ์ด
                at: card
                do: >-
                  `TaskHost.open` เปิด session นั้นในแผงแชตแล้วเลื่อนไปที่การ์ดที่รออยู่ (`revealOf` ได้ `card`)
                sees: แผงแชตแสดง session "migrate tests" และการ์ดขออนุญาตที่รอคำตอบ
                ref: packages/extension/src/chat/lanes-model.ts#revealOf
                end: { turn: continues }

          - id: finished
            label: เสร็จ
            steps:
              - lane: editor
                beat:
                  title: งานเสร็จ
                  text: งานย้ายเข้ากลุ่ม Ready การแจ้งเป็นระดับ info ไม่ส่งถึง macOS งานที่ยังมีงานเบื้องหลังรอปลุก ยังไม่นับว่าเสร็จ
                at: chat
                do: >-
                  งานจบแบบ done และย้ายเข้า Ready `attentionNotice` ได้การแจ้งระดับ info ที่ไม่ส่งถึงระบบปฏิบัติการ
                  งานที่จบแต่ยังมีงานเบื้องหลังจะปลุก session อยู่ ยังไม่นับว่าเสร็จ
                ref: packages/extension/src/chat/notices.ts#attentionNotice
                emits: [done]
                phase: idle
              - lane: editor
                beat:
                  title: VS Code ขึ้น toast
                  text: มีแค่ toast ของ VS Code ไม่มีการแจ้งเตือนของ macOS
                  sees:
                    kind: toast
                    text: "Geno finished: migrate tests"
                    actions:
                      - Open
                at: chat
                do: >-
                  `tell` แสดง toast ของ VS Code อย่างเดียว ไม่มีการแจ้งเตือนของ macOS
                sees: >-
                  toast "Geno finished: migrate tests" [Open]
                ref: packages/extension/src/chat/tasks-host.ts#TaskHost.tell
              - lane: user
                beat:
                  title: คุณกด Open
                  text: แชตเปิด session นั้นที่ท้ายบทสนทนา และนับว่าคุณดูแล้ว
                  from: you
                  end: คุณอ่านคำตอบ
                do: ผู้ใช้กลับมาที่ VS Code เห็น toast แล้วกด Open
              - lane: panel
                at: rail
                do: >-
                  `TaskHost.open` เปิด session นั้นที่ท้ายบทสนทนา และนับว่าผู้ใช้ดูแล้ว
                sees: คำตอบสุดท้ายของ session "migrate tests"
                ref: packages/extension/src/chat/lanes-model.ts#revealOf
                end: { turn: done }

          - id: failed
            label: ล้มเหลว
            steps:
              - lane: editor
                beat:
                  title: งานล้มเหลว
                  text: งานย้ายเข้ากลุ่ม Needs you การแจ้งเป็นระดับ error และส่งถึง macOS ได้
                at: chat
                do: >-
                  งานจบแบบ failed และย้ายเข้า Needs you ด้วยเหตุ `failed` การแจ้งเป็นระดับ error และส่งถึงระบบปฏิบัติการได้
                ref: packages/extension/src/chat/notices.ts#ATTENTION_NOTICES
                emits: [failed]
                phase: idle
              - lane: external
                beat:
                  title: macOS และ VS Code แจ้งว่างานล้ม
                  text: การแจ้งเตือนของ macOS ขึ้น พร้อม toast สีแดงใน VS Code
                  from: machine
                  sees:
                    kind: toast
                    text: "Geno failed: migrate tests"
                    actions:
                      - Open
                do: macOS แสดงการแจ้งเตือน
                sees: >-
                  การแจ้งเตือนของ macOS "Geno failed: migrate tests" และ toast สีแดงใน VS Code พร้อมปุ่ม Open
                ref: packages/extension/src/chat/notices.ts#osNotification
              - lane: user
                beat:
                  title: คุณกด Open
                  text: แชตเปิด session นั้นที่ท้ายบทสนทนา ซึ่งมีแถบ error ของ turn ที่ล้ม
                  from: you
                  end: คุณดู error
                do: ผู้ใช้กด Open บน toast
              - lane: panel
                at: rail
                do: >-
                  `TaskHost.open` เปิด session นั้นที่ท้ายบทสนทนา ซึ่งมีแถบ error ของ turn ที่ล้ม
                sees: แถบ error ท้าย turn และหัวข้อ "failed after ..."
                ref: packages/extension/src/chat/lanes-model.ts#revealOf
                end: { turn: failed }
---

ทุกหน้าต่างได้การอัปเดตของทุกงาน แต่แต่ละหน้าต่างตัดสินเองว่าจะแจ้งไหม โดยดูว่าผู้ใช้อยู่ตรงไหน

| ผู้ใช้อยู่ที่ | toast ของ VS Code | การแจ้งเตือนของ macOS |
| --- | --- | --- |
| ดู session นั้นอยู่ในหน้าต่างที่โฟกัส | ไม่แจ้ง | ไม่แจ้ง |
| หน้าต่างโฟกัสแต่ดู session อื่น | แจ้ง | ไม่แจ้ง |
| หน้าต่างไม่ได้โฟกัส | แจ้ง | แจ้ง ถ้าเป็นเรื่องที่ต้องการผู้ใช้หรือล้มเหลว |

สิ่งที่ควรสังเกต

- **การแจ้งเตือนของ macOS มีเฉพาะ macOS** `tell` เรียก `osascript` เมื่อ `process.platform` เป็น `darwin` เท่านั้น
- **งานเสร็จไม่ส่งถึงระบบปฏิบัติการ** มีแค่ Needs you (ขออนุญาต คำถาม ล้ม ถูกจำกัดอัตราจนต้องกด Retry now ลูกถูกตัด การปลุกถูกพัก) ที่ส่งออกนอกหน้าต่าง
- **ทุกหน้าต่างแจ้งเอง** ถ้าเปิด VS Code หลายหน้าต่างที่เชื่อมกับ engine เดียวกัน แต่ละหน้าต่างตัดสินและแจ้งของตัวเอง
- **ตัวเลขบนไอคอน** คือจำนวนงานใน Needs you ไม่ว่าจะแจ้งหรือไม่
