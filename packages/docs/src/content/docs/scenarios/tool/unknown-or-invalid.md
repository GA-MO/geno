---
title: เครื่องมือไม่มีจริงหรือ input ผิด
description: โมเดลเรียกเครื่องมือที่ไม่มีใน Geno หรือส่ง input ที่ไม่ตรง schema executor ไม่รันอะไร แต่ตอบเป็นผล error ที่บอกวิธีเรียกที่ถูก แล้ว turn ทำงานต่อ
tableOfContents: false
sidebar:
  order: 4
scenario:
  surface: vscode
  given:
    - turn กำลังทำงานในแผงแชตของ VS Code
    - ไม่มี hook ที่ตั้งไว้
  trigger: >-
    โมเดลจบคำตอบด้วย `stop_reason: tool_use` แต่บล็อก `tool_use` เรียกชื่อที่ไม่มี หรือมี input ผิดรูป
  covers: [tool.unknown-or-invalid]
  related: [tool.deferred-tool-load, mstop.max-tokens-cut-tool, turn.with-tools]
  steps:
    - id: asks
      lane: model
      do: >-
        โมเดลขอเรียกเครื่องมือ ชื่อหรือ input ของมันมาจากความเคยชินกับ harness อื่น ไม่ใช่จากรายการเครื่องมือของ Geno
      ref: "packages/engine/src/gateway.ts#\"stopReason: message.stop_reason,\""
      emits: [tool_use]
      phase: calling-model

    - use: tool-call-opens

    - id: lookup
      lane: tool
      at: executor
      runs: 0
      do: >-
        `runExecutor` หา executor ตามชื่อ แล้วให้ executor ตรวจ input ด้วย zod schema ของมันก่อนทำอะไร
      ref: packages/engine/src/tools/index.ts#runExecutor
      fork:
        ask: call ผิดตรงไหน
        options:
          - id: unknown
            label: ชื่อเครื่องมือไม่มีจริง
            then: result
            steps:
              - lane: tool
                at: executor
                do: >-
                  ไม่มี executor ชื่อ `write_file` `unknownTool` เห็นว่าเป็นชื่อเครื่องมือเขียนไฟล์ของ harness อื่น
                  จึงตอบว่าให้ใช้ `edit` กับ `create: true` แทน ตามด้วยรายชื่อเครื่องมือทั้งหมด ชื่อขั้นในแผงเป็นชื่อกับ JSON ของ input
                sees: ขั้น `write_file {"path":"src/date.ts","content":"..."}` ขึ้นเครื่องหมายล้มเหลว
                ref: packages/engine/src/tools/index.ts#unknownTool
                emits: [unknown tool]
          - id: invalid
            label: input ไม่ตรง schema
            then: result
            steps:
              - lane: tool
                at: executor
                do: >-
                  `bash` ได้ `{"cmd": "ls"}` แทน `command` schema ของมันเป็น `strictObject` จึงไม่ผ่าน executor โยน `ToolError`
                  "invalid input: ..." ตามด้วยข้อความของ zod ที่บอกฟิลด์ที่ขาดและฟิลด์ที่ไม่รู้จัก
                  ชื่อขั้นอ่าน input ไม่ได้ จึงเป็นชื่อเครื่องมือกับ JSON ของ input
                sees: ขั้น `bash {"cmd":"ls"}` ขึ้นเครื่องหมายล้มเหลว
                ref: "packages/engine/src/tools/context.ts#\"if (!parsed.success) throw new ToolError(`invalid input: ${z.prettifyError(parsed.error)}`);\""
                emits: [invalid input]

    - id: result
      lane: tool
      at: executor
      do: >-
        ทั้งสองทางได้ผลสถานะ `error` พร้อมข้อความนั้น ไม่มีอะไรรัน ไม่ผ่านนโยบาย และไม่มีการ์ด
      ref: packages/engine/src/tools/index.ts#runTool

    - use: tool-result-returns

    - id: next
      lane: loop
      at: step
      do: >-
        `loopStep` เห็น `tool-result` ล่าสุดจึงตัดสิน `call-model` โมเดลได้ `tool_result` ที่มี `is_error: true` และข้อความบอกวิธีที่ถูก
      ref: packages/core/src/loop.ts#loopStep
      emits: [call-model, is_error]
      phase: calling-model
      end: { turn: continues, reason: call-model }
---

ทุกอย่างที่โมเดลเรียกผิดกลับไปเป็นผล `error` ให้โมเดลอ่าน ไม่มีอะไรทำให้ turn ล้ม
Geno ไม่ซ่อมหรือเดา input ให้ โมเดลต้องเรียกใหม่เอง

สิ่งที่ควรสังเกต

- **ชื่อของ harness อื่นได้คำแนะนำ** `create`, `write`, `create_file`, `write_file` และ `Write` ได้ข้อความที่ชี้ไปที่ `edit` กับ `create: true`
  ชื่ออื่นได้แค่รายชื่อเครื่องมือ
- **เครื่องมือที่เลื่อนไว้ไม่ใช่ชื่อที่ไม่มี** เครื่องมือ MCP และเครื่องมือที่ไม่ใช่แกนหลักมีอยู่จริงแต่ถูกปฏิเสธจนกว่าจะโหลดด้วย `tool_search`
  ดู [โหลดเครื่องมือที่เลื่อนไว้ด้วย tool_search](/scenarios/tool/deferred-tool-load/)
- **input ที่ถูกตัดเพราะ `max_tokens` ไม่มาทางนี้** call ที่ถูกตัดได้คำตอบ `cut-off` จาก loop ก่อนถึง executor
  ดู [คำตอบชนเพดาน output](/scenarios/mstop/max-tokens/)
