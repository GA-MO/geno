---
title: Keep หรือ Undo ทีละ hunk
description: ในโหมด review แบบ review ทุก hunk ที่ Geno แก้รอการตัดสิน ผู้ใช้กด Keep หรือ Undo จาก CodeLens ในไฟล์หรือจากการ์ดในแผง และ engine บันทึกการตัดสินไว้ใน log
tableOfContents: false
sidebar:
  order: 2
scenario:
  surface: vscode
  given:
    - "`gcode.review.mode` เป็น `review`"
    - turn ล่าสุดแก้ `src/date.ts` สองที่ และจบแบบ done
  trigger: >-
    ผู้ใช้เปิด `src/date.ts` หรือดูการ์ดการเปลี่ยนแปลงท้าย turn เพื่อตัดสินแต่ละ hunk
  covers: [ed.review-hunks]
  related: [ed.review-auto-undo, edit.applied-as-diff, sess.rewind]
  steps:
    - id: tracked
      beat:
        title: VS Code จด hunk ทั้งสองว่ารอตัดสิน
        text: ในโหมด review แบบ review ตอนที่การแก้ลง buffer ส่วนขยายจดตำแหน่งของแต่ละ hunk ตำแหน่งเลื่อนตามเมื่อคุณพิมพ์ในไฟล์
        from: panel
        to: panel
      lane: editor
      at: review
      do: >-
        ตอนที่การแก้ลงใน buffer `ReviewController.track` จด hunk ทั้งสองเป็น `pending` พร้อมตำแหน่งของข้อความใหม่ในเอกสาร
        ตำแหน่งนี้เลื่อนตามเมื่อผู้ใช้พิมพ์ในไฟล์ (ในโหมด auto เมธอดนี้ไม่จดอะไร)
      ref: packages/extension/src/review/controller.ts#ReviewController.track
      phase: idle

    - id: lenses
      beat:
        title: Keep กับ Undo ขึ้นทั้งในไฟล์และในแชต
        text: CodeLens ขึ้นเหนือแต่ละ hunk ในไฟล์ และการ์ดท้าย turn มีปุ่มของแต่ละ hunk กับปุ่มสำหรับทุก hunk
        from: panel
        to: you
        sees: เหนือแต่ละ hunk ใน `src/date.ts` มีลิงก์ "Keep | Undo" และการ์ด "1 file changed" ที่มีปุ่ม [Undo] [Keep] ต่อ hunk
      lane: editor
      at: review
      do: >-
        `ReviewLenses` วาง CodeLens สองตัวเหนือ hunk ที่รออยู่แต่ละ hunk ในตัว editor
      sees: เหนือแต่ละ hunk ใน `src/date.ts` มีลิงก์ "Keep | Undo" และบรรทัดที่แก้มีสีไฮไลต์
      ref: packages/extension/src/review/editor.ts#ReviewLenses

    - id: card
      lane: panel
      at: rail
      alongside: true
      do: >-
        การ์ดการเปลี่ยนแปลงท้าย turn แสดงแต่ละ hunk พร้อมปุ่มของมัน และหัวการ์ดมีปุ่มสำหรับทุก hunk ที่รออยู่
      sees: >-
        การ์ด "1 file changed" แต่ละ hunk มีปุ่ม [Undo] [Keep] และหัวการ์ดมี [Undo all] [Keep all]
      ref: packages/extension/src/chat/render.ts#CONTROLS

    - id: decide
      beat:
        title: คุณตัดสิน hunk แรก
        text: จาก CodeLens หรือจากการ์ดก็ได้ ทั้งสองทางไปที่คำสั่งเดียวกัน
        from: you
        to: panel
        ask: คุณกดอะไร
      lane: user
      do: ผู้ใช้ตัดสิน hunk แรก จาก CodeLens หรือจากการ์ดก็ได้ ทั้งสองทางไปที่คำสั่งเดียวกัน
      fork:
        ask: ผู้ใช้กดอะไร
        options:
          - id: keep
            label: Keep
            then: log
            steps:
              - lane: editor
                beat:
                  title: hunk ถูกเก็บ
                  text: สถานะของ hunk เปลี่ยนเป็น kept ข้อความในไฟล์ไม่เปลี่ยน
                  from: panel
                  to: panel
                at: review
                do: >-
                  ปุ่มในการ์ดส่ง `keep` ให้ extension host ซึ่งรันคำสั่ง `gcode.review.keep` แบบเดียวกับ CodeLens
                  `keep` เปลี่ยนสถานะ hunk เป็น `kept` ข้อความในไฟล์ไม่เปลี่ยน
                ref: packages/extension/src/review/controller.ts#ReviewController.keep
                emits: [kept]
          - id: undo
            label: Undo
            then: log
            steps:
              - lane: editor
                beat:
                  title: VS Code ใส่ข้อความเดิมกลับ
                  text: ส่วนขยายแทนช่วงของ hunk ด้วยข้อความเดิม และบันทึกไฟล์ถ้า buffer ไม่มีการแก้ค้างก่อนหน้า
                  from: panel
                  to: panel
                at: review
                do: >-
                  คำสั่ง `gcode.review.undo` ให้ `undo` ใส่ข้อความเดิมกลับแทนช่วงของ hunk ด้วย `WorkspaceEdit` หนึ่งครั้งต่อเอกสาร
                  และบันทึกไฟล์ถ้า buffer ไม่มีการแก้ค้างก่อนหน้า ถ้า VS Code ไม่ยอมแก้ hunk กลับเป็น `pending`
                ref: packages/extension/src/review/controller.ts#ReviewController.undo
                emits: [undone]

    - id: log
      beat:
        title: Geno บันทึกการตัดสินลง log
        text: engine บันทึกการตัดสินลง log ของ session แล้วตอบสถานะของทุก hunk แชตแสดงป้ายแทนปุ่ม CodeLens ของ hunk นั้นหายไป hunk ที่สองยังรออยู่
        from: engine
        to: panel
        sees: hunk แรกขึ้นป้าย "Kept" หรือ "Undone" ส่วน hunk ที่สองยังมีปุ่ม [Undo] [Keep]
        end: hunk ที่สองยังรอ
      lane: editor
      at: review
      do: >-
        `decided` แจ้งการเปลี่ยนแปลงทันที แล้วส่งคำขอ `REVIEW_METHOD` ที่มีการตัดสินไปให้ engine
      ref: packages/extension/src/review/controller.ts#ReviewController.decided
      emits: [REVIEW_METHOD]

    - id: append
      lane: server
      at: sessions
      do: >-
        engine บันทึกการตัดสินลง log ของ session ภายใน lock ของ session แล้วตอบสถานะของทุก hunk จาก log
      ref: packages/engine/src/serve.ts#appendDecisions
      emits: [review]

    - id: synced
      lane: editor
      at: chat
      alongside: true
      do: >-
        `onDidChange` ของการรีวิวทำให้ `Chat.reviewed` ส่ง action `review` ที่บอกสถานะของแต่ละ hunk ให้แผง
      ref: packages/extension/src/chat/chat.ts#Chat.reviewed
      emits: [review]

    - id: shown
      lane: panel
      at: rail
      alongside: true
      do: >-
        hunk ที่ตัดสินแล้วเหลือป้ายสถานะแทนปุ่ม CodeLens ของมันหายจาก editor hunk ที่สองยังรออยู่
      sees: hunk แรกขึ้นป้าย "Kept" หรือ "Undone" ส่วน hunk ที่สองยังมีปุ่ม [Undo] [Keep]
      ref: "packages/extension/src/chat/render.ts#\"function decision(status: Exclude<DiffHunk['status'], 'pending'>): HTMLElement {\""
      end: { turn: none }
---

โหมด review ให้ผู้ใช้ตัดสินทีละ hunk แทนการยอมรับทั้ง turn การแก้ของ Geno ลงในไฟล์แล้วตั้งแต่ตอนที่ model แก้
Keep จึงไม่เขียนอะไร มันแค่บันทึกว่าผู้ใช้เห็นด้วย ส่วน Undo เขียนข้อความเดิมกลับลงไป

| | auto (ค่าตั้งต้น) | review |
| --- | --- | --- |
| hunk ที่รอการตัดสิน | ไม่มี | ทุก hunk |
| CodeLens ในไฟล์ | ไม่มี | Keep และ Undo |
| ย้อนกลับ | Undo ทั้ง turn จาก checkpoint | Undo ทีละ hunk ทีละไฟล์ หรือทั้ง session |

สิ่งที่ควรสังเกต

- **การตัดสินอยู่ใน log** หลัง reload หรือเปิดแชตใหม่ `restore` ขอสถานะจาก engine แล้วหาข้อความของ hunk ที่รออยู่ในไฟล์อีกครั้ง
  hunk ที่หาไม่พบแล้วถูกแสดงเป็น kept และมีบันทึกใน output channel
- **Undo ทีละ hunk ไม่ใช้ checkpoint** มันแทนข้อความในช่วงของ hunk ตรงๆ จึงไม่แตะการแก้อื่นของผู้ใช้ในไฟล์เดียวกัน
  ต่างจาก Undo all ของ session ซึ่งย้อนทั้ง workspace ไปที่ checkpoint แรก
- **การเปลี่ยนโหมด review มีผลกับการแก้ครั้งต่อไป** hunk ที่จดไว้แล้วยังอยู่ และการแก้ที่ลงตอนโหมด auto ไม่ถูกจดย้อนหลัง
