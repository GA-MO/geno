---
title: Cmd-K แก้โค้ดที่เลือก
description: ผู้ใช้เลือกบรรทัดในไฟล์แล้วกด Cmd-K Cmd-I พิมพ์คำสั่ง engine รัน turn สั้นที่มีแค่เครื่องมือ edit การแก้ลงใน buffer และ turn แสดงในแผงแชตเหมือน turn อื่น
tableOfContents: false
sidebar:
  order: 3
scenario:
  surface: vscode
  given:
    - ผู้ใช้เปิด `src/date.ts` ใน VS Code และเลือกบรรทัด 12 ถึง 18
    - แชตในแผงไม่มี turn ทำงาน
  trigger: >-
    ผู้ใช้กด Cmd-K Cmd-I (Ctrl-K Ctrl-I บน Windows และ Linux) หรือรันคำสั่ง "Geno: Edit Selection (Cmd-K)"
  covers: [ed.inline-edit-cmd-k]
  related: [edit.applied-as-diff, edit.old-str-mismatch, turn.text-answer, ed.review-hunks]
  steps:
    - id: target
      beat:
        title: คุณเลือกบรรทัดแล้วกด Cmd-K Cmd-I
        text: คุณเลือกบรรทัด 12 ถึง 18 ของ `src/date.ts` ส่วนขยายขยายการเลือกเป็นบรรทัดเต็ม แล้วเปิดกล่องให้พิมพ์คำสั่ง
        from: you
        to: panel
        sees: กล่องพิมพ์ของ VS Code "Edit the selection" ข้อความจาง "What should change?"
      lane: editor
      at: vscode-ui
      do: >-
        คำสั่งรับเฉพาะไฟล์บนดิสก์ `selectionTarget` ขยายการเลือกเป็นบรรทัดเต็ม (การเลือกที่จบต้นบรรทัดไม่นับบรรทัดนั้น)
        แล้วเปิดกล่องให้พิมพ์คำสั่ง
      sees: กล่องพิมพ์ของ VS Code "Edit the selection" ข้อความจาง "What should change?"
      ref: packages/extension/src/review/commands.ts#selectionTarget
      phase: idle

    - id: type
      beat:
        title: คุณพิมพ์ “รองรับรูปแบบ ISO week”
        text: คุณกด Enter คำสั่งไปทางเดียวกับข้อความที่พิมพ์ในแผง พร้อมบอกไฟล์และช่วงบรรทัด
        to: panel
      lane: user
      do: ผู้ใช้พิมพ์ "รองรับรูปแบบ ISO week" แล้วกด Enter

    - id: prompt
      beat:
        title: แชตในแผงขึ้น turn ของการแก้
        text: บับเบิลบอกไฟล์และช่วงบรรทัด turn นี้แสดงในแผงเหมือน turn อื่น
        to: engine
        sees:
          kind: message
          from: you
          text: "Edit lines 12-18 of src/date.ts: รองรับรูปแบบ ISO week"
      lane: editor
      at: chat
      do: >-
        `Chat.inlineEdit` ส่งต่อให้ `prompt()` ทางเดียวกับข้อความที่พิมพ์ในแผง พร้อม `INLINE_EDIT_META` ที่บอก path และช่วงบรรทัด
        แผงได้ action `turn-start` แล้วคำขอ ACP `session/prompt` ออกไปที่ engine
      ref: packages/extension/src/chat/chat.ts#Chat.inlineEdit
      emits: [turn-start, INLINE_EDIT_META]

    - id: bubble
      lane: panel
      at: rail
      alongside: true
      do: แชตในแผงได้ turn ใหม่ที่บับเบิลบอกไฟล์และช่วงบรรทัด
      sees: >-
        บับเบิล "Edit lines 12-18 of src/date.ts: รองรับรูปแบบ ISO week" หัวข้อ "working"
      ref: packages/extension/src/chat/webview.ts#render

    - id: accept
      beat:
        title: Geno เตรียม turn ที่มีแค่ tool edit
        text: Geno ปฏิเสธไฟล์นอก workspace อ่านไฟล์และ problem ของไฟล์จาก VS Code แล้วสร้าง prompt ที่มีทั้งไฟล์พร้อมเลขบรรทัด ช่วงที่เลือก และคำสั่งของคุณ แล้วส่งให้ model
        to: model
      lane: server
      at: turns
      do: >-
        `runTurn` ตรวจ `INLINE_EDIT_META` ไม่ขยายคำสั่ง slash ตั้งชื่องานใน Tasks ว่า "Inline edit" แล้วเรียก `runInlineEdit`
        แทน `runAgent`
      ref: "packages/engine/src/serve.ts#\"await runInlineEdit(turnIo, store, opened, target.data, text, { maxCostUsd: limits.maxCostUsd, surface: shown.surface, diagnostics })\""
      phase: starting

    - id: build
      lane: loop
      at: agent
      do: >-
        `runInlineEdit` ปฏิเสธไฟล์นอก workspace อ่านไฟล์ผ่าน editor และ problem ของไฟล์จาก VS Code
        แล้วสร้าง prompt ที่มีทั้งไฟล์พร้อมเลขบรรทัด ช่วงที่เลือก และคำสั่ง รอบนี้มีแค่เครื่องมือ `edit`
        system prompt ของการแก้ checkpoint ก่อนทุกการเรียก และเรียกโมเดลได้ไม่เกิน 4 ครั้ง
      ref: packages/engine/src/inline.ts#runInlineEdit

    - id: record
      lane: loop
      at: drive
      do: >-
        `drive` บันทึก prompt ที่สร้างไว้เป็น event `user` ใน log ของแชตนี้
      ref: "packages/engine/src/drive.ts#\"await record({ kind: 'user', seq: nextSeq(events), at: new Date().toISOString(), content: prompt });\""
      emits: [user]

    - use: model-call

    - id: edit-call
      beat:
        title: Model ขอแก้ช่วงนั้น
        text: model อ่านไฟล์จาก prompt จึงไม่ต้อง read ก่อน มันส่ง `old_str` และ `new_str` แชตขึ้นขั้นของ edit
        to: engine
      lane: model
      do: >-
        โมเดลอ่านไฟล์จาก prompt แล้วขอ `edit` ด้วย `old_str` และ `new_str` จบด้วย `stop_reason: tool_use`
        ฐานของการแก้คือข้อความที่อยู่ใน prompt จึงไม่ต้อง `read` ก่อน
      ref: "packages/engine/src/gateway.ts#\"stopReason: message.stop_reason,\""
      emits: [tool_use]

    - use: tool-call-opens

    - id: apply
      beat:
        title: Geno แทน `old_str` ในไฟล์
        text: Geno เทียบข้อความปัจจุบันกับข้อความที่อยู่ใน prompt แล้วหาข้อความเดิม
        ask: การแก้ลงไหม
      lane: tool
      at: executor
      do: >-
        `edit` เทียบข้อความปัจจุบันกับฐาน แล้วแทน `old_str` ด้วย `new_str`
      ref: packages/engine/src/tools/agent.ts#editExecutor
      fork:
        ask: การแก้ลงหรือไม่
        options:
          - id: lands
            label: ลง
            steps:
              - use: edit-write-lands
                beat:
                  title: VS Code เขียนการแก้ลง buffer
                  text: การแก้เข้า buffer ที่คุณเปิดอยู่ ขั้นของ edit บอกจำนวนบรรทัด Geno ส่งผลให้ model
                  to: panel
                  sees:
                    kind: step
                    label: Edited date.ts
                    status: done
                    note: +9 −2
              - use: tool-result-returns
              - use: model-call
              - lane: model
                beat:
                  title: Model บอกว่าแก้อะไร
                  text: model ตอบสั้นๆ แล้วจบ turn
                  to: panel
                do: >-
                  โมเดลตอบสั้นๆ ว่าแก้อะไรไป แล้วจบด้วย `end_turn`
                ref: "packages/engine/src/drive.ts#\"onText: (delta) => watcher.text(delta),\""
                emits: [end_turn]
              - use: turn-ends
                beat:
                  title: Turn จบ
                  text: ปุ่ม Send กลับมา hunk ของการแก้รอคุณตรวจตามโหมด review
                  sees:
                    kind: composer
                    state: idle
                  end: การแก้อยู่ในไฟล์แล้ว
          - id: fails
            label: ไม่ลง
            steps:
              - lane: tool
                beat:
                  title: การแก้ไม่ลง
                  text: "`old_str` ไม่ตรง หรือคุณแก้ไฟล์ไประหว่างนั้น ไม่มีอะไรถูกเขียน"
                at: executor
                do: >-
                  `old_str` ไม่ตรง หรือผู้ใช้แก้ไฟล์ไประหว่างนั้น `edit` ล้มเหลวด้วย `ToolError` ไม่มีอะไรถูกเขียน
                ref: "packages/engine/src/tools/agent.ts#\"if (proposed.result.kind === 'failed') throw new ToolError(proposed.result.detail);\""
                emits: [ToolError]
              - lane: loop
                beat:
                  title: Model ลองใหม่ได้สามครั้ง
                  text: Geno ให้ model ลองใหม่ ถ้าครบสามครั้งยังไม่ลง การเรียกครั้งสุดท้ายไม่มี tool model จึงเขียนได้แค่ประโยคปิดท้าย
                  to: model
                  end: Turn จบโดยแก้ไม่ลง
                at: step
                do: >-
                  `loopStep` เรียกโมเดลอีกครั้งให้ลองใหม่ ถ้าลองครบสามครั้งแล้วยังไม่ลง การเรียกครั้งที่สี่ซึ่งเป็นครั้งสุดท้ายออกไปพร้อมเครื่องมือปิด
                  โมเดลจึงเขียนได้แค่ประโยคปิดท้ายว่าแก้ไม่ได้เพราะอะไร แล้ว turn จบแบบ done โดยไม่มีการแก้
                ref: packages/core/src/inline-edit.ts#INLINE_EDIT_MAX_TURNS
                emits: [call-model]
                phase: calling-model
                end: { turn: done, reason: end_turn }
---

Cmd-K ไม่ใช่ระบบแยก มันคือ turn หนึ่งของแชตที่แผงแสดงอยู่ ใช้ log ใช้ checkpoint และใช้ทางเขียนไฟล์เดียวกับ `edit` ของเอเจนต์
ต่างกันที่ engine สร้าง prompt เองจากไฟล์และการเลือก และให้โมเดลมีแค่ `edit`

| | turn ปกติ | Cmd-K |
| --- | --- | --- |
| prompt | ข้อความที่ผู้ใช้พิมพ์ | ไฟล์ทั้งไฟล์ ช่วงบรรทัด problem และคำสั่ง |
| เครื่องมือ | ทุกเครื่องมือ | `edit` อย่างเดียว |
| การเรียกโมเดล | ไม่เกิน 40 | ไม่เกิน 4 (แก้ ลองใหม่สองครั้ง และประโยคปิดท้าย) |

สิ่งที่ควรสังเกต

- **การแก้ลงใน buffer** ผู้ใช้กด Cmd-Z ย้อนได้ และในโหมด review การแก้กลายเป็น hunk ที่รอ Keep หรือ Undo
- **ต้องไม่มี turn ทำงาน** Cmd-K ส่งผ่าน `prompt()` ซึ่งปฏิเสธเมื่อแชตมี turn ทำงานอยู่ ("a turn is already running; stop it first")
- **แชตที่ใช้ agent ภายนอกรับ Cmd-K ไม่ได้** engine ปฏิเสธ inline edit ของ session ที่ใช้ backend ภายนอก
