---
title: "Model ขอจดจำ"
description: โมเดลเสนอโน้ตให้จำข้ามแชตด้วย remember Geno ถามผู้ใช้ทุกครั้งไม่ว่าโหมดไหน ถ้าผู้ใช้ตกลง โน้ตถูกบันทึกและโมเดลได้รู้ก่อนเรียกครั้งถัดไป
tableOfContents: false
sidebar:
  order: 6
scenario:
  surface: vscode
  given:
    - เปิด Geno ในโหมด Auto มี turn ทำงานอยู่
    - ผู้ใช้เพิ่งบอกว่า "โปรเจกต์นี้ใช้ pnpm อย่าใช้ npm"
  trigger: >-
    โมเดลเห็นว่าเป็นความชอบที่ควรจำไว้ในแชตต่อๆ ไป
  covers: [ext.memory-write]
  related: [start.new-session-context, ext.mcp-tool-call, perm.auto-classifier-allows]
  steps:
    - id: wants
      beat:
        title: Model เสนอโน้ตให้จำ
        text: คุณเพิ่งบอกว่าโปรเจกต์นี้ใช้ pnpm model เห็นว่าควรจำไว้ในแชตต่อๆ ไป มันเรียก `remember` ด้วยโน้ตและขอบเขต project
        from: model
        to: engine
      lane: model
      do: >-
        โมเดลขอเรียก `remember` ด้วย `text: "ใช้ pnpm ไม่ใช่ npm ในโปรเจกต์นี้"` และ `scope: "project"`
        จบคำตอบด้วย `stop_reason: tool_use`
      ref: "packages/engine/src/gateway.ts#\"stopReason: message.stop_reason,\""
      emits: [tool_use]
      phase: calling-model

    - use: tool-call-opens

    - id: check
      beat:
        title: Geno ตรวจโน้ตแล้วถามคุณเสมอ
        text: โน้ตละไม่เกิน 500 ตัวอักษร รวมทั้งหมดไม่เกิน 4,000 ไม่มีโหมด กฎ หรือ classifier ตอบแทนคุณ แม้ในโหมด Auto
        from: engine
        to: engine
      lane: tool
      at: executor
      do: >-
        executor ของ `remember` ตรวจโน้ตด้วย `memoryProblem` ก่อน (โน้ตละไม่เกิน 500 ตัวอักษร และรวมทั้งหมดไม่เกิน 4,000)
        โน้ตผ่าน จึงถามผู้ใช้ ไม่มีโหมด กฎ หรือ classifier ที่ตอบคำถามนี้แทนผู้ใช้ได้ แม้ในโหมด Auto
      ref: packages/engine/src/tools/user.ts#BUILD.remember

    - id: ask
      beat:
        title: Geno หยุด turn แล้วถามคุณ
        text: Geno ส่งคำขอ permission ที่มีข้อความของโน้ต แชตใช้ข้อความนั้นแทนคำสั่ง
        from: engine
        to: panel
      lane: server
      at: approvals
      do: >-
        `editorUser.remember` ส่งอัปเดตที่ค้างออกไปก่อน แล้วส่งคำขอ ACP `session/request_permission`
        หัวข้อ "Remember this in this project?" ข้อความของโน้ตอยู่ใน `_meta` ใต้ `REMEMBER_META` และตัวเลือกมีแค่สองปุ่ม
      ref: packages/engine/src/serve.ts#editorUser
      emits: [requestPermission, REMEMBER_META]
      phase: waiting-user

    - id: forward
      lane: editor
      at: chat
      do: >-
        `permissionAction` เห็น `REMEMBER_META` จึงใช้ข้อความของโน้ตแทนคำสั่ง แล้ว `askPermission` ส่ง action `permission`
      ref: packages/extension/src/chat/session-updates.ts#permissionAction
      emits: [permission]

    - id: card
      beat:
        title: คุณเห็นการ์ด “Remember this?”
        text: การ์ดแสดงโน้ตตรงตัวและขอบเขตของมัน
        from: panel
        to: you
        sees: { kind: permission, face: memory, scope: project, command: ใช้ pnpm ไม่ใช่ npm ในโปรเจกต์นี้ }
        ask: คุณกดปุ่มไหน
      lane: panel
      at: card
      do: แผงแชตแสดงการ์ดแบบหน่วยความจำ พร้อมข้อความของโน้ตตรงตัวและขอบเขตของมัน
      sees: >-
        "Remember this?" ข้อความ "ใช้ pnpm ไม่ใช่ npm ในโปรเจกต์นี้" และ
        "Geno will follow this note in every later chat in this project. You can change or delete it in /memory." [Remember] [Don't remember]
      ref: packages/extension/src/chat/render.ts#FACES

    - id: choose
      lane: user
      do: ผู้ใช้อ่านโน้ตแล้วตัดสินใจ
      fork:
        ask: ผู้ใช้กดปุ่มไหน
        options:
          - id: remember
            label: Remember
            steps:
              - lane: tool
                beat:
                  title: Geno บันทึกโน้ต
                  text: โน้ตไปอยู่ในไฟล์หน่วยความจำของโปรเจกต์นี้ ผลของ call บอก model ว่าบันทึกแล้ว
                  from: engine
                  to: engine
                at: executor
                do: >-
                  `memory.add` เขียนโน้ตลงไฟล์หน่วยความจำของโปรเจกต์นี้ในโฟลเดอร์ของ Geno ผลของ call คือ
                  "Saved to project memory. It applies from now on."
                ref: packages/engine/src/memory.ts#memoryStore
                phase: running-tools
              - use: tool-result-returns
              - lane: loop
                beat:
                  title: Geno บอก model ก่อนเรียกครั้งถัดไป
                  text: Geno ไม่แก้ข้อความแรกของ session cache จึงไม่หลุด แต่ใส่ข้อความแจ้งว่าคุณอนุมัติโน้ตใหม่ model ใช้ pnpm ต่อจากนี้ และแชตใหม่ในโปรเจกต์นี้ได้โน้ตด้วย
                  from: engine
                  to: model
                  end: Model ใช้ pnpm ต่อจากนี้
                at: drive
                do: >-
                  ที่จุดปลอดภัยก่อนเรียกโมเดล `deliver()` บันทึก event `notice` ที่มีการเปลี่ยนแปลงของหน่วยความจำ
                  ข้อความแรกของ session ที่ตรึงไว้ไม่ถูกแก้ cache ของ prompt จึงไม่หลุด
                ref: packages/core/src/memory.ts#memoryDelta
                emits: [notice]
                phase: calling-model
              - lane: model
                do: >-
                  คำขอถัดไปมีข้อความ "The user approved new notes for you to remember. Follow them where they apply..."
                  พร้อมโน้ตใหม่ โมเดลใช้ pnpm ต่อจากนี้ และแชตใหม่ในโปรเจกต์นี้ได้โน้ตตั้งแต่ข้อความแรก
                ref: packages/core/src/memory.ts#renderMemoryDelta
                end: { turn: continues }

          - id: decline
            label: Don't remember
            steps:
              - lane: tool
                beat:
                  title: ไม่มีอะไรถูกบันทึก
                  text: ผลของ call บอกว่าคุณไม่ตกลง และอย่าเสนอซ้ำเว้นแต่คุณขอ ผลนี้ไม่จบ turn
                  from: engine
                  to: model
                at: executor
                do: >-
                  ไม่มีอะไรถูกบันทึก ผลของ call คือ "The user declined. Nothing was saved; do not propose it again unless they ask."
                  สถานะของผลเป็น ok ไม่ใช่การปฏิเสธที่จบ turn
                ref: packages/engine/src/tools/user.ts#BUILD.remember
                phase: running-tools
              - use: tool-result-returns
              - lane: loop
                beat:
                  title: Model ทำงานต่อ
                  text: Geno เรียก model อีกครั้ง model ทำงานต่อโดยไม่เสนอโน้ตเดิมซ้ำ
                  from: model
                  to: engine
                  end: Model ทำต่อ
                at: step
                do: >-
                  `loopStep` ตัดสิน `call-model` โมเดลทำงานต่อโดยไม่เสนอโน้ตเดิมซ้ำ
                ref: packages/core/src/loop.ts#loopStep
                emits: [call-model]
                phase: calling-model
                end: { turn: continues, reason: call-model }
---

หน่วยความจำคือโน้ตสั้นๆ ที่ไปกับข้อความแรกของทุกแชตใหม่ จึงมีผลกว้างกว่าการอนุญาตคำสั่งครั้งเดียว
Geno จึงให้ผู้ใช้เห็นข้อความตรงตัวและตัดสินเองทุกครั้ง

สิ่งที่ควรสังเกต

- **ไม่มีทางลัด** การ์ดนี้ไม่มี "Always allow" และไม่ผ่าน classifier ของ Auto ใน run แบบ non-interactive เครื่องมือนี้ไม่มีให้โมเดลเลย
- **ไม่ใช่ deny แบบจบ turn** "Don't remember" ให้ผลเป็นข้อความธรรมดา turn ทำต่อ ต่างจาก Deny บนการ์ดคำสั่ง
- **ลบหรือแก้ได้ภายหลัง** `/memory` เปิดรายการโน้ต เมื่อผู้ใช้ลบโน้ต การเรียกครั้งถัดไปได้ข้อความว่า
  "These notes were deleted from memory or replaced; stop following them"
- **ขอบเขตสองแบบ** `project` เก็บแยกตามโฟลเดอร์ของ workspace ส่วน `global` ใช้กับทุกโปรเจกต์
