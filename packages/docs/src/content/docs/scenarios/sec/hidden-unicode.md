---
title: "ตัวอักษรที่มองไม่เห็นในไฟล์"
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
      beat:
        title: "Model ขออ่านข้อความ"
        text: >-
          `src/greet.ts` มี zero-width space ซ่อนอยู่ระหว่าง hello กับ world คุณขอให้แก้ข้อความทักทาย
          โมเดลขออ่านข้อความนั้น แชตขึ้นขั้นใหม่พร้อมจุดหมุน
        to: engine
      do: >-
        โมเดลขอเรียกเครื่องมืออ่าน และจบคำตอบด้วย `stop_reason: tool_use`
      ref: "packages/engine/src/gateway.ts#\"stopReason: message.stop_reason,\""
      emits: [tool_use]
      phase: calling-model

    - use: tool-call-opens

    - id: text
      lane: tool
      at: executor
      beat:
        title: "Geno ดูว่า tool นี้แสดงหรือตัดตัวซ่อน"
        text: >-
          ก่อนส่งผลให้โมเดล Geno ดูตารางว่า tool นี้แสดงหรือตัดตัวอักษรซ่อน ตัวที่นับคือ zero-width ตัวควบคุมทิศทาง BOM
          และ Unicode tag ซึ่งใช้ซ่อนคำสั่งได้ ลองเลือกว่าข้อความมาจากไหน
        ask: "มาจากไหน"
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
                beat:
                  title: "read แสดงตัวซ่อนเป็นรหัสที่มองเห็น"
                  text: >-
                    การแก้ไฟล์ต้องจับคู่ไบต์จริง read จึงแทนตัวซ่อนด้วยรหัสอย่าง [U+200B] แทนการลบทิ้ง ผลจาก run
                    จริงด้านล่างมีตัวซ่อนแบบเดียวกันในไฟล์ config
                  sees:
                    kind: payload
                    direction: tool_result
                    source: docs/results/real-usecases/runs/A30-hidden-char-edit/1/requests.jsonl#seq=7
                    select: messages[-1].content[0]
                    highlight:
                      - content
                do: >-
                  `read` อยู่ในกลุ่ม `show` เพราะการแก้ต้องจับคู่ไบต์จริงของไฟล์ `showHidden` แทนตัวอักษรซ่อนด้วยรหัสที่มองเห็นได้
                ref: packages/core/src/hidden.ts#showHidden
                emits: ["[U+200B]"]
              - use: tool-result-returns
              - use: model-call
              - lane: model
                beat:
                  title: "Model เห็นตัวซ่อนแล้วขอ edit"
                  text: >-
                    โมเดลเห็นว่ามีอะไรซ่อนอยู่ มันขอ `edit` โดยคัดลอก [U+200B] ลงในข้อความเดิมตามที่เห็น
                    และเขียนข้อความใหม่ที่ไม่มีตัวซ่อน ใน run จริงด้านล่าง โมเดลพูดถึงตัวซ่อนทันทีหลังอ่าน
                  sees:
                    kind: payload
                    direction: response
                    source: docs/results/real-usecases/runs/A30-hidden-char-edit/1/session.jsonl#seq=7
                    select: content
                    collapse:
                      - "[0].thinking"
                do: >-
                  โมเดลเห็น `const greeting = "hello[U+200B] world";` จึงรู้ว่ามีอะไรซ่อนอยู่ มันขอ `edit` โดยคัดลอก `[U+200B]`
                  ลงใน `old_str` ตามที่เห็น และเขียน `new_str` เป็นข้อความใหม่ที่ไม่มีตัวซ่อน
                ref: "packages/engine/src/gateway.ts#\"stopReason: message.stop_reason,\""
                emits: [tool_use]
              - lane: tool
                at: executor
                beat:
                  title: "edit คืนรหัสเป็นตัวอักษรจริงก่อนจับคู่"
                  text: >-
                    edit แปลง [U+200B] กลับเป็นตัวอักษรจริงในทุกฟิลด์ข้อความยกเว้น path ข้อความเดิมจึงตรงกับไบต์ในไฟล์
                    ทัวร์ของการแก้ไฟล์เล่าต่อ
                  end: "แก้ไฟล์ได้ตรงไบต์"
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
                beat:
                  title: "ข้อความจากนอก workspace ถูกตัดตัวซ่อนทิ้ง"
                  text: >-
                    ผลจากเว็บ MCP subagent หรือเทอร์มินัล ถูกลบตัวซ่อนทิ้งโดยไม่บอก คำสั่งที่ซ่อนด้วย Unicode tag
                    ในหน้าเว็บจึงไม่ไปถึงโมเดล ผลกลับมาที่แชต
                do: >-
                  เครื่องมือที่ไม่อยู่ในตาราง หรืออยู่ในกลุ่ม `strip` ได้ `stripHidden` ตัวอักษรซ่อนถูกลบทิ้งโดยไม่บอก
                  คำสั่งที่ซ่อนด้วย Unicode tag ในหน้าเว็บจึงไม่ไปถึงโมเดล
                ref: packages/core/src/hidden.ts#stripHidden
              - use: tool-result-returns
              - lane: loop
                at: step
                beat:
                  title: "Model ได้ข้อความที่ไม่มีตัวซ่อน"
                  text: >-
                    Geno เรียกโมเดลต่อ โมเดลอ่านข้อความที่สะอาดแล้ว
                  to: model
                  end: "ตัวซ่อนถูกตัด turn ทำต่อ"
                do: >-
                  `loopStep` ตัดสิน `call-model` โมเดลได้ข้อความที่ไม่มีตัวซ่อน
                ref: packages/core/src/loop.ts#loopStep
                emits: [call-model]
                phase: calling-model
                end: { turn: continues, reason: call-model }
---

ตัวอักษรที่มองไม่เห็นมีสองปัญหา: มันซ่อนคำสั่งไว้ในข้อความที่คนอ่านไม่เห็น และมันทำให้การแก้ไฟล์จับคู่ไม่ได้
Geno แก้ทั้งสองด้วยตารางเดียว (`HIDDEN_IN`) ที่บอกว่า tool ไหนแสดงและ tool ไหนตัด

| ข้อความ | ทำอะไร | เหตุผล |
| --- | --- | --- |
| ไฟล์และ output ของคำสั่งใน workspace (`read`, `grep`, `bash`, ...) | แสดงเป็น `[U+200B]` | การแก้ต้องตรงไบต์ และผู้ใช้ควรรู้ |
| เว็บ, MCP, สกิล, subagent, เทอร์มินัล, todo | ตัดทิ้ง | ข้อความจากที่อื่นไม่มีอะไรให้แก้ |

สิ่งที่ควรสังเกต

- **`edit` คืนเฉพาะรหัสของตัวอักษรซ่อน** `[U+0041]` ที่เขียนในไฟล์จริงยังเป็นข้อความ `[U+0041]` เพราะ `A` ไม่ใช่ตัวซ่อน
  แต่ถ้าไฟล์มีข้อความ `[U+200B]` เป็นตัวอักษรธรรมดา `edit` จะแปลงมันเป็นตัวอักษรจริงและจับคู่ไม่ได้
- **path ไม่ถูกคืน** `restoreHidden` ข้ามฟิลด์ `path` ชื่อไฟล์ที่มีตัวซ่อนจึงต้องอ้างแบบอื่น

ข้อความอีกแบบที่ Geno แก้ก่อนถึง model ดู [Output ปลอมเป็นโน้ตของ Geno](/scenarios/sec/spoofed-geno-note/)
