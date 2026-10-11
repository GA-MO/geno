---
title: ตัวอักษรที่มองไม่เห็นในไฟล์
description: ไฟล์ใน workspace มีตัวอักษรความกว้างศูนย์ read แสดงมันเป็น [U+200B] ให้โมเดลเห็น และ edit คืนมันกลับก่อนจับคู่ ส่วนข้อความจากเว็บหรือ MCP ถูกตัดตัวอักษรเหล่านี้ทิ้ง
tableOfContents: false
sidebar:
  order: 2
scenario:
  surface: vscode
  given:
    - '`src/greet.ts` มีบรรทัด `const greeting = "hello world";` ที่มี U+200B (zero-width space) ซ่อนอยู่ระหว่าง hello กับ world'
    - turn กำลังทำงาน ผู้ใช้ขอให้แก้ข้อความทักทาย
  trigger: >-
    โมเดลขออ่านข้อความที่มีตัวอักษรซ่อนอยู่
  covers: [sec.hidden-unicode]
  related: [sec.spoofed-geno-note, edit.applied-as-diff, edit.old-str-mismatch, tool.web-fetch]
  steps:
    - id: asks
      lane: model
      do: >-
        โมเดลขอเรียกเครื่องมืออ่าน และจบคำตอบด้วย `stop_reason: tool_use`
      ref: "packages/engine/src/gateway.ts#\"stopReason: message.stop_reason,\""
      emits: [tool_use]
      phase: calling-model

    - use: tool-call-opens

    - id: text
      lane: tool
      at: executor
      do: >-
        เครื่องมืออ่านเสร็จ แล้ว `runTool` ส่งข้อความผ่าน `toolText` ซึ่งดูตาราง `HIDDEN_IN` ว่าเครื่องมือนี้แสดงหรือตัดตัวอักษรซ่อน
        ตัวอักษรที่นับคือ zero-width, ตัวควบคุมทิศทาง (bidi), BOM และ Unicode tag ซึ่งใช้ซ่อนคำสั่งได้
      ref: packages/core/src/hidden.ts#toolText
      fork:
        ask: ข้อความมาจากไหน
        options:
          - id: workspace
            label: ไฟล์ใน workspace (read)
            steps:
              - lane: tool
                at: executor
                do: >-
                  `read` อยู่ในกลุ่ม `show` เพราะการแก้ต้องจับคู่ไบต์จริงของไฟล์ `showHidden` แทนตัวอักษรซ่อนด้วยรหัสที่มองเห็นได้
                ref: packages/core/src/hidden.ts#showHidden
                emits: ["[U+200B]"]
              - use: tool-result-returns
              - use: model-call
              - lane: model
                do: >-
                  โมเดลเห็น `const greeting = "hello[U+200B] world";` จึงรู้ว่ามีอะไรซ่อนอยู่ มันขอ `edit` โดยคัดลอก `[U+200B]`
                  ลงใน `old_str` ตามที่เห็น และเขียน `new_str` เป็นข้อความใหม่ที่ไม่มีตัวซ่อน
                ref: "packages/engine/src/gateway.ts#\"stopReason: message.stop_reason,\""
                emits: [tool_use]
              - lane: tool
                at: executor
                do: >-
                  `edit` เรียก `restoreHidden` กับทุกฟิลด์ข้อความยกเว้น `path` `[U+200B]` กลับเป็นตัวอักษรจริงก่อนจับคู่
                  `old_str` จึงตรงกับไบต์ในไฟล์ (รหัสของตัวอักษรที่ไม่ใช่ตัวซ่อนคงไว้ตามที่เขียน)
                ref: "packages/engine/src/tools/agent.ts#\"const raw = Object.fromEntries(Object.entries(input).map(([key, value]) => [key, typeof value === 'string' && key !== 'path' ? restoreHidden(value) : value]));\""
                phase: running-tools
                goto: edit.applied-as-diff
          - id: elsewhere
            label: นอก workspace (web_fetch, MCP, subagent, terminal)
            steps:
              - lane: tool
                at: executor
                do: >-
                  เครื่องมือที่ไม่อยู่ในตาราง หรืออยู่ในกลุ่ม `strip` ได้ `stripHidden` ตัวอักษรซ่อนถูกลบทิ้งโดยไม่บอก
                  คำสั่งที่ซ่อนด้วย Unicode tag ในหน้าเว็บจึงไม่ไปถึงโมเดล
                ref: packages/core/src/hidden.ts#stripHidden
              - use: tool-result-returns
              - lane: loop
                at: step
                do: >-
                  `loopStep` ตัดสิน `call-model` โมเดลได้ข้อความที่ไม่มีตัวซ่อน
                ref: packages/core/src/loop.ts#loopStep
                emits: [call-model]
                phase: calling-model
                end: { turn: continues, reason: call-model }
---

ตัวอักษรที่มองไม่เห็นมีสองปัญหา: มันซ่อนคำสั่งไว้ในข้อความที่คนอ่านไม่เห็น และมันทำให้การแก้ไฟล์จับคู่ไม่ได้
Geno แก้ทั้งสองด้วยตารางเดียว (`HIDDEN_IN`) ที่บอกว่าเครื่องมือไหนแสดงและเครื่องมือไหนตัด

| ข้อความ | ทำอะไร | เหตุผล |
| --- | --- | --- |
| ไฟล์และ output ของคำสั่งใน workspace (`read`, `grep`, `bash`, ...) | แสดงเป็น `[U+200B]` | การแก้ต้องตรงไบต์ และผู้ใช้ควรรู้ |
| เว็บ, MCP, สกิล, เอเจนต์ลูก, เทอร์มินัล, todo | ตัดทิ้ง | ข้อความจากที่อื่นไม่มีอะไรให้แก้ |

สิ่งที่ควรสังเกต

- **`edit` คืนเฉพาะรหัสของตัวอักษรซ่อน** `[U+0041]` ที่เขียนในไฟล์จริงยังเป็นข้อความ `[U+0041]` เพราะ `A` ไม่ใช่ตัวซ่อน
  แต่ถ้าไฟล์มีข้อความ `[U+200B]` เป็นตัวอักษรธรรมดา `edit` จะแปลงมันเป็นตัวอักษรจริงและจับคู่ไม่ได้
- **path ไม่ถูกคืน** `restoreHidden` ข้ามฟิลด์ `path` ชื่อไฟล์ที่มีตัวซ่อนจึงต้องอ้างแบบอื่น
