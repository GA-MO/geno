---
title: "ดูการเปลี่ยนแปลงของ turn แล้ว Undo"
description: ในโหมด review แบบ auto การแก้ของ Geno ถูกบันทึกทันที ท้าย turn มีแถวเดียวพร้อม Undo ซึ่งคืนทุกไฟล์เป็นแบบก่อน turn
tableOfContents: false
sidebar:
  order: 1
scenario:
  surface: vscode
  given:
    - "`gcode.review.mode` เป็น `auto` (ค่าเริ่มต้น)"
    - turn ล่าสุดของแชตกำลังทำงาน และ model เพิ่งขอแก้ `src/date.ts` ที่อ่านไว้แล้ว
  trigger: >-
    model แก้ไฟล์ แล้ว turn จบแบบ done
  covers: [ed.review-auto-undo]
  related: [edit.applied-as-diff, edit.create-file, ed.review-hunks, sess.rewind]
  steps:
    - id: edit
      beat:
        title: Model แก้ `src/date.ts`
        text: ก่อน turn นี้เรียก model ครั้งแรก Geno เก็บ checkpoint ของ workspace ไว้แล้ว Undo จะใช้ checkpoint นี้
        from: model
        to: engine
      lane: tool
      at: executor
      do: >-
        `edit` คำนวณข้อความหลังแก้ของ `src/date.ts` ก่อน turn นี้เรียก model ครั้งแรก engine บันทึก checkpoint
        (commit ใน shadow git ของ workspace) ไว้แล้ว
      ref: packages/engine/src/tools/agent.ts#editExecutor
      phase: running-tools

    - use: edit-write-lands
      beat:
        title: VS Code บันทึกการแก้ลงดิสก์ทันที
        text: ในโหมด review แบบ auto ไม่มี hunk ที่รอ Keep ใน editor จึงไม่มี CodeLens หรือแถบสีของการแก้
        from: engine
        to: panel
        sees:
          kind: step
          label: Edited date.ts
          status: done
          note: +3 −1

    - id: not-tracked
      lane: editor
      at: review
      do: >-
        `ReviewController.track` ดูโหมดแล้วไม่เก็บอะไร ในโหมด `auto` การแก้ถูกบันทึกลงดิสก์ทันทีและไม่มี hunk ที่รอ Keep
        ใน editor จึงไม่มี CodeLens หรือแถบสีของการแก้
      ref: packages/extension/src/review/controller.ts#ReviewController.track

    - id: turn-end
      beat:
        title: Turn จบ
        text: model ตอบจบ แชตปิด turn แบบ done
        from: engine
        to: panel
      lane: editor
      at: chat
      do: >-
        turn ทำงานต่อจน model ตอบจบ `prompt()` ส่ง action `turn-end` สถานะ `done`
      ref: "packages/extension/src/chat/chat.ts#\"this.dispatch({ type: 'turn-end', at: Date.now(), status, usage: usageOf(response)\""
      emits: [turn-end]
      phase: idle

    - id: row
      beat:
        title: ท้าย turn มีแถวพร้อม Undo
        text: แชตรวมการแก้ทั้งหมดของ turn เป็นรายการไฟล์ และจำ checkpoint ก่อนการแก้ครั้งแรก
        from: panel
        to: you
        sees: แถว "1 file changed · Undo" ใต้คำตอบ เหนือแถวสรุป model token และค่าใช้จ่าย
      lane: panel
      at: rail
      do: >-
        `turnChangesOf` รวมการแก้ทั้งหมดของ turn เป็นรายการไฟล์ และจำ checkpoint ก่อนการแก้ครั้งแรกของ turn
        แผงวาดแถวการเปลี่ยนแปลงท้าย turn พร้อมปุ่ม Undo
      sees: >-
        แถว "1 file changed · Undo" ใต้คำตอบ เหนือแถวสรุป model token และค่าใช้จ่าย
      ref: packages/extension/src/chat/render.ts#turnChangesRow

    - id: choice
      beat:
        title: คุณดู diff แล้วตัดสินใจ
        text: คลิกชื่อไฟล์เพื่อเปิด diff ระหว่างก่อน turn กับตอนนี้
        from: panel
        to: you
        ask: เก็บหรือ Undo
      lane: user
      do: ผู้ใช้ดูการแก้ (คลิกชื่อไฟล์บนการ์ดเพื่อเปิด diff ก่อน turn กับตอนนี้) แล้วตัดสินใจ
      fork:
        ask: ผู้ใช้เก็บการแก้หรือกด Undo
        options:
          - id: keep
            label: เก็บไว้ (ไม่ทำอะไร)
            steps:
              - lane: panel
                beat:
                  title: คุณเก็บไว้
                  text: ไม่มีปุ่ม Keep เพราะการแก้อยู่บนดิสก์แล้ว แถวยังมี Undo ให้กดภายหลัง ตราบที่ไม่มี turn ทำงาน
                  from: you
                  to: panel
                  end: เก็บการแก้
                at: rail
                do: >-
                  ในโหมด `auto` ไม่มีปุ่ม Keep การแก้อยู่บนดิสก์แล้ว แถวยังมี Undo ให้กดได้ภายหลัง
                  ตราบใดที่ไม่มี turn ทำงานอยู่
                ref: packages/extension/src/review/summary.ts#turnChangesOf
                end: { turn: none }
          - id: undo
            label: กด Undo
            steps:
              - lane: panel
                beat:
                  title: คุณกด Undo
                  text: แชตส่ง checkpoint ของ turn และบอกว่า turn หลังจากนี้แก้ไฟล์ไว้ด้วยไหม
                  from: you
                  to: panel
                at: rail
                do: >-
                  ปุ่ม Undo โพสต์ `undo-turn` พร้อม checkpoint ของ turn และบอกว่า turn หลังจากนี้แก้ไฟล์ไว้ด้วยหรือไม่
                ref: "packages/extension/src/chat/render.ts#\"onclick: () => ui.post({ type: 'undo-turn', checkpoint: changes.checkpoint, later })\""
                emits: [undo-turn]
              - lane: editor
                beat:
                  title: VS Code ถามยืนยันเมื่อจำเป็น
                  text: ถ้า turn หลังจากนี้แก้ไฟล์ไว้ด้วย การคืน checkpoint จะลบการแก้เหล่านั้น VS Code จึงถามก่อน turn นี้เป็น turn ล่าสุด จึงไม่ถาม
                  from: panel
                  to: engine
                at: vscode-ui
                do: >-
                  คำสั่ง `gcode.review.undoTurn` ถามยืนยันด้วย modal เฉพาะเมื่อ turn หลังจากนี้แก้ไฟล์ไว้ด้วย
                  เพราะการคืน checkpoint จะลบการแก้ของ turn เหล่านั้นไปด้วย turn นี้เป็น turn ล่าสุด จึงไม่ถาม
                ref: packages/extension/src/review/commands.ts#undoTurn
              - lane: editor
                at: review
                do: >-
                  `ReviewController.undoTurn` ส่งคำขอ ACP `_gcode/rewind` พร้อม id ของการแก้ครั้งแรกของ turn
                ref: packages/extension/src/review/controller.ts#ReviewController.undoTurn
              - lane: server
                beat:
                  title: Geno คืน workspace จาก checkpoint
                  text: Geno ปฏิเสธถ้ามี turn ทำงาน ไม่อย่างนั้นคืนไฟล์ที่เปลี่ยนตั้งแต่ checkpoint และลบไฟล์ที่เกิดทีหลัง แล้วนับทุก hunk หลัง checkpoint ว่า undone
                  from: engine
                  to: machine
                at: sessions
                do: >-
                  engine ปฏิเสธถ้ามี turn ทำงานอยู่ หา checkpoint แรกของ turn ที่ทำการแก้นั้น แล้วคืน workspace ทั้งก้อน:
                  ไฟล์ที่เปลี่ยนตั้งแต่ checkpoint ถูก checkout กลับ ไฟล์ที่เกิดหลัง checkpoint ถูกลบ แล้วบันทึก event `restored`
                ref: "packages/engine/src/serve.ts#\".onRequest(REWIND_METHOD, rewindRequest, async ({ params }): Promise<RewindResponse> => {\""
                emits: [restored]
              - lane: editor
                at: review
                do: >-
                  ส่งคำขอ ACP `_gcode/review` ที่ไม่มีการตัดสินใหม่ เพื่อขอสถานะ hunk ทั้ง session `reviewState` นับทุก hunk
                  ที่บันทึกหลัง checkpoint นั้นเป็น `undone` แล้ว `chat.reviewed` ส่ง action `review` ให้แผง
                ref: "packages/engine/src/serve.ts#\".onRequest(REVIEW_METHOD, reviewRequest, async ({ params }): Promise<ReviewResponse> => {\""
                emits: [review]
              - lane: panel
                beat:
                  title: แถวขึ้นว่า Undone
                  text: VS Code โหลดไฟล์ที่เปลี่ยนบนดิสก์ใหม่
                  from: panel
                  to: you
                  sees: แถว "1 file changed · Undone" และแต่ละ hunk ในการ์ดขึ้นป้าย "Undone"
                  end: ไฟล์กลับเป็นก่อน turn
                at: rail
                do: >-
                  hunk ของ turn ขึ้นป้าย Undone และแถวท้าย turn เปลี่ยน Undo เป็นคำว่า Undone VS Code โหลดไฟล์ที่เปลี่ยนบนดิสก์ใหม่
                sees: แถว "1 file changed · Undone" และแต่ละ hunk ในการ์ดขึ้นป้าย "Undone"
                ref: packages/extension/src/chat/render.ts#turnChangesRow
                end: { turn: none }
---

โหมด review แบบ `auto` ไม่ได้ให้ตรวจทีละ hunk มันบันทึกการแก้ทันที แล้วให้ปุ่มเดียวต่อ turn ที่ย้อนทั้ง turn
ปุ่มนั้นไม่ได้ย้อนการแก้ทีละ hunk แต่คืน workspace เป็น checkpoint ที่ engine เก็บไว้ก่อนการเรียก model ครั้งแรกของ turn

| โหมด | ระหว่าง turn | ท้าย turn |
| --- | --- | --- |
| `auto` (ค่าเริ่มต้น) | การแก้ถูกบันทึกทันที | แถว "N files changed · Undo" |
| `review` | ทุก hunk รอ Keep หรือ Undo ใน editor และในแผง | การ์ดการเปลี่ยนแปลงพร้อม Keep all / Undo all |

สิ่งที่ควรสังเกต

- **Undo คืนทั้ง workspace ไม่ใช่เฉพาะไฟล์ของ Geno** `restore` checkout ทุกไฟล์ที่ต่างจาก checkpoint และลบไฟล์ที่เกิดหลัง checkpoint
  ถ้าผู้ใช้แก้ไฟล์เองหลัง turn เริ่ม การแก้นั้นก็หายไปด้วย modal ยืนยันขึ้นเฉพาะเมื่อ turn หลังจากนี้ของ Geno แก้ไฟล์
  ไม่ได้ขึ้นเพราะการแก้ของผู้ใช้ (คำสั่ง Undo All Changes of the Session ต่างออกไป มันเตือนเรื่องการแก้ของผู้ใช้เสมอ)
- **Undo ใช้ไม่ได้ขณะ turn ทำงาน** engine ตอบว่า "stop the running turn before undoing the session" และ VS Code แสดงเป็น toast เตือน
- **ไฟล์ที่ turn สร้างถูกลบ** ไฟล์ที่ไม่มีใน checkpoint ถือว่าเกิดหลัง checkpoint ดู [สร้างไฟล์ใหม่](/scenarios/edit/create-file/)
- **บทสนทนาไม่ถูกย้อน** Undo คืนเฉพาะไฟล์ ข้อความถัดไปที่ส่งมีโน้ตจาก event `restored` บอก model ว่าไฟล์ไหนถูกคืน
  และให้อ่านไฟล์ใหม่ก่อนแก้ การย้อนบทสนทนาด้วยคือ Rewind บนข้อความ
