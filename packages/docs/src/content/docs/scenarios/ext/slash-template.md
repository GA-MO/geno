---
title: คำสั่ง / ที่กลายเป็น prompt
description: ผู้ใช้พิมพ์ /ชื่อ ตามด้วยอาร์กิวเมนต์ engine แปลงเป็นข้อความจากไฟล์คำสั่ง หรือแนบ SKILL.md ไปกับข้อความ แล้ว turn เดินตามปกติ
scenario:
  surface: vscode
  given:
    - workspace มีไฟล์ `.claude/commands/fix-issue.md` เนื้อหา "Read issue #$1 with gh, find the cause, and fix it."
    - ติดตั้ง plugin pstack ไว้ จึงมีสกิล `pstack:how` ให้เลือกในรายการ `/`
    - session นี้ไม่มี turn ทำงานอยู่
  trigger: >-
    ผู้ใช้พิมพ์ `/fix-issue 42` หรือ `/pstack:how loop ทำงานอย่างไร` แล้วกด Enter
  covers: [ext.slash-template, ext.skill-typed]
  related: [ext.slash-builtin-engine, ext.slash-builtin-editor, ext.skill-by-model, turn.text-answer]
  steps:
    - use: ext-slash-sent
      beat:
        title: คุณพิมพ์ `/fix-issue 42`
        text: แชตขึ้นข้อความที่ขึ้นต้นด้วยชิปชื่อคำสั่ง แล้วส่งเป็น prompt ไปที่ engine
        from: you
        to: panel
        sees:
          kind: message
          from: you
          text: /fix-issue 42

    - id: kind
      beat:
        title: Geno หาคำสั่งด้วยชื่อ
        text: คำสั่งที่ไม่ใช่คำสั่งในตัวกลายเป็นข้อความของ turn เสมอ วิธีแปลงขึ้นกับว่ามันมาจากไหน
        from: engine
        to: engine
        ask: มาจากไหน
      lane: server
      at: turns
      do: >-
        `expandInvocation` หาคำสั่งด้วยชื่อ คำสั่งที่ไม่ใช่ builtin กลายเป็น `message` เสมอ
      ref: packages/core/src/commands.ts#expandInvocation
      fork:
        ask: คำสั่งนี้มาจากไหน
        options:
          - id: template
            label: ไฟล์คำสั่ง (prompt template)
            then: prompt-logged
            steps:
              - lane: server
                beat:
                  title: Geno แทน `$1` ด้วย 42
                  text: '`/fix-issue` มาจากไฟล์ใน `commands/` ข้อความของ turn จึงเป็น "Read issue #42 with gh, find the cause, and fix it."'
                  from: engine
                  to: engine
                at: turns
                do: >-
                  `/fix-issue` มาจากไฟล์ใน `commands/` `expandTemplate` แทน `$1` ด้วย `42` ข้อความของ turn จึงเป็น
                  "Read issue #42 with gh, find the cause, and fix it." ถ้าแม่แบบไม่มีตัวแทนเลย อาร์กิวเมนต์จะต่อท้ายเป็น `ARGUMENTS: ...`
                ref: packages/core/src/commands.ts#expandTemplate
                emits: [ARGUMENTS]

          - id: skill
            label: สกิล
            then: prompt-logged
            steps:
              - lane: server
                beat:
                  title: Geno แนบ SKILL.md เป็น context
                  text: ถ้าคุณพิมพ์ `/pstack:how` ซึ่งเป็น skill ข้อความของ turn คือสิ่งที่คุณพิมพ์ และ SKILL.md ไปเป็น context item
                  from: engine
                  to: engine
                at: turns
                do: >-
                  `/pstack:how` เป็นสกิล ข้อความของ turn ยังเป็นสิ่งที่ผู้ใช้พิมพ์ทั้งบรรทัด และเนื้อหา `SKILL.md` ไปเป็น context item
                  ชนิด `skill` ค่า `context: fork` ในสกิลไม่มีผลในทางนี้ สกิลไม่ถูกแยกไปรันเป็น subagent
                ref: "packages/core/src/commands.ts#\"skill: ({ name, path, text: skill, description }, text, args) => ({\""
                emits: [skill]

    - id: prompt-logged
      beat:
        title: Geno บันทึก prompt ที่แปลงแล้ว
        text: Geno บันทึกข้อความ ชื่อคำสั่งกับอาร์กิวเมนต์และคำอธิบายของคำสั่ง และ context ของ skill ถ้ามี ก่อนเปิดรอบ
        from: engine
        to: engine
      lane: server
      at: turns
      do: >-
        ภายใน lock ของ session `logPrompt` บันทึก event `user` เองก่อนเปิดรอบ: ข้อความที่แปลงแล้ว ชื่อคำสั่ง อาร์กิวเมนต์และคำอธิบายของคำสั่ง
        และ context item ของสกิล (ถ้ามี) แล้ว `runTurn` เรียก `runAgent` ด้วย prompt ว่าง ให้ loop ใช้ prompt ที่อยู่ใน log
      ref: packages/engine/src/serve.ts#logPrompt
      emits: [user]

    - id: build
      beat:
        title: Turn เดินตามปกติ
        text: tool และ system prompt เหมือน turn อื่นทุกอย่าง hook UserPromptSubmit ได้อ่านข้อความที่แปลงแล้วก่อน model แล้ว Geno ส่งให้ model
        from: engine
        to: model
      lane: loop
      at: agent
      do: >-
        `runAgent` ประกอบรอบนี้ตามปกติ ชุด tool และ system prompt เหมือน turn อื่นทุกอย่าง
      ref: packages/engine/src/agent.ts#runAgent

    - id: submit-hooks
      lane: policy
      at: hooks
      do: >-
        `drive` เห็นว่า log จบด้วย prompt ที่ผู้ใช้พิมพ์ จึงให้ UserPromptSubmit hook อ่านข้อความที่แปลงแล้วก่อน model
        เมื่อไม่มี hook ก็ผ่านไป
      ref: packages/engine/src/drive.ts#submitted
      emits: [UserPromptSubmit]

    - use: model-call

    - id: answer
      beat:
        title: Model ทำตามข้อความที่แปลงแล้ว
        text: model เห็นข้อความหลังแปลง ไม่ใช่ `/fix-issue 42` ดิบๆ แล้วทำงานตามนั้น
        from: model
        to: engine
      lane: model
      do: >-
        model เห็นข้อความที่แปลงแล้ว สำหรับสกิล เนื้อหา `SKILL.md` อยู่ใน `<context_item kind="skill" name="pstack:how" ...>`
        ต่อจากข้อความของผู้ใช้ แล้วทำงานตามนั้น ในตัวอย่างนี้ตอบเป็นข้อความโดยไม่เรียก tool จบด้วย `stop_reason: end_turn`
      ref: packages/core/src/context.ts#ITEM_RENDER
      emits: [end_turn]

    - use: answer-streams
      beat:
        title: คำตอบค่อยๆ ขึ้นในแชต
        text: Geno ส่งแต่ละส่วนที่ model เขียนผ่าน VS Code ไปถึงแผงแชตทันที คุณจึงอ่านได้ก่อน model เขียนเสร็จ
        from: engine
        to: panel
    - use: turn-ends
      beat:
        title: Turn จบ
        text: ปุ่ม Send กลับมา และท้ายคำตอบมีแถวสรุป model token และค่าใช้จ่าย
        from: engine
        to: panel
        sees:
          kind: composer
          state: idle
        end: Turn จบ
---

คำสั่งทั้งสองแบบไม่มีทางเฉพาะของตัวเองหลังจาก engine แปลงเสร็จ ทุกอย่างหลัง `logPrompt` คือ
[ถามแล้วได้คำตอบเป็นข้อความ](/scenarios/turn/text-answer/) หรือ turn ที่มี tool ตามปกติ

| | prompt template | สกิล |
| --- | --- | --- |
| ไฟล์ | `commands/<name>.md` | `skills/<name>/SKILL.md` |
| ข้อความของ turn | แม่แบบที่แทนอาร์กิวเมนต์แล้ว | สิ่งที่ผู้ใช้พิมพ์ |
| ไปกับ prompt | ไม่มีอะไรเพิ่ม | `SKILL.md` เป็น context item |
| `context: fork` | ไม่มี | ไม่มีผลเมื่อผู้ใช้พิมพ์เอง |

สิ่งที่ควรสังเกต

- **engine อ่านโฟลเดอร์ตอนส่ง** `commands.expand` โหลดคำสั่งใหม่ทุกครั้ง ไฟล์ที่แก้ล่าสุดจึงมีผลทันที
  ส่วนรายการใน `/` ของแผงอัปเดตผ่าน `available_commands_update` เมื่อโฟลเดอร์เปลี่ยน
- **แม่แบบที่แปลงแล้วว่างถูกปฏิเสธ** `runTurn` ตอบ "/name expands to no text" และไม่เปิด turn
- **ชิปในบับเบิลมาจาก log** event `user` เก็บชื่อคำสั่งไว้ การเปิด session ซ้ำจึงยังแสดงชิปของคำสั่ง ไม่ใช่ข้อความที่แปลงแล้ว
- **ชื่อแชตมาจากข้อความหลังคำสั่ง** แชตที่เริ่มด้วย `/pstack:how loop ทำงานอย่างไร` ได้ชื่อ "loop ทำงานอย่างไร"
  ถ้าไม่มีข้อความต่อท้าย ชื่อคือคำอธิบายของคำสั่งในรายการ `/` ไม่ใช่ชื่อคำสั่งหรือข้อความที่แปลงแล้ว
- **เลือกจากรายการแล้วยังไม่ส่ง** กด Enter บนสกิลหรือ prompt template ในรายการ `/` แค่ใส่ `/ชื่อ ` ลงช่องพิมพ์ให้พิมพ์รายละเอียดต่อ
- **คำสั่งที่ไม่รู้จักไปเป็นข้อความธรรมดา** `/อะไรก็ได้` ที่ไม่ตรงกับคำสั่งใด ถูกส่งให้ model ตามที่พิมพ์
