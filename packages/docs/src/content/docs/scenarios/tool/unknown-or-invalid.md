---
title: "Model เรียก tool ที่ไม่มีจริง หรือส่ง input ผิด"
description: model เรียก tool ที่ไม่มีใน Geno หรือส่ง input ที่ไม่ตรง schema executor ไม่รันอะไร แต่ตอบเป็นผล error ที่บอกวิธีเรียกที่ถูก แล้ว turn ทำงานต่อ
scenario:
  surface: vscode
  given:
    - turn กำลังทำงานในแผงแชตของ VS Code
    - ไม่มี hook ที่ตั้งไว้
  trigger: >-
    model จบคำตอบด้วย `stop_reason: tool_use` แต่บล็อก `tool_use` เรียกชื่อที่ไม่มี หรือมี input ผิดรูป
  covers: [tool.unknown-or-invalid]
  related: [tool.deferred-tool-load, mstop.max-tokens-cut-tool, turn.with-tools]
  steps:
    - id: asks
      lane: model
      beat:
        title: "Model เรียก tool ตามความเคยชิน"
        text: >-
          ชื่อหรือ input ของ tool call นี้มาจากความเคยชินกับ harness อื่น ไม่ใช่จากรายการ tool ของ Geno
        from: model
        to: engine
      do: >-
        model ขอเรียก tool ชื่อหรือ input ของมันมาจากความเคยชินกับ harness อื่น ไม่ใช่จากรายการ tool ของ Geno
      ref: "packages/engine/src/gateway.ts#\"stopReason: message.stop_reason,\""
      emits: [tool_use]
      phase: calling-model

    - use: tool-call-opens
      beat:
        title: "แชตขึ้นขั้นของ call"
        text: >-
          Geno จัดคิว call แล้วแชตขึ้นขั้นใหม่พร้อมจุดหมุน
        from: engine
        to: panel

    - id: lookup
      lane: tool
      at: executor
      beat:
        title: "Geno หา tool แล้วตรวจ input ก่อนทำอะไร"
        text: >-
          Geno หา tool ตามชื่อ แล้วตรวจ input กับ schema ของมันก่อนรัน ลองเลือกว่า call นี้ผิดตรงไหน
        from: engine
        to: engine
        ask: "ผิดตรงไหน"
      runs: 0
      do: >-
        `runExecutor` หา executor ตามชื่อ แล้วให้ executor ตรวจ input ด้วย zod schema ของมันก่อนทำอะไร
      ref: packages/engine/src/tools/index.ts#runExecutor
      fork:
        ask: call ผิดตรงไหน
        options:
          - id: unknown
            label: ชื่อ tool ไม่มีจริง
            then: result
            steps:
              - lane: tool
                at: executor
                beat:
                  title: "ไม่มี tool ชื่อ write_file"
                  text: >-
                    Geno รู้ว่าเป็นชื่อ tool เขียนไฟล์ของ harness อื่น จึงตอบว่าให้ใช้ `edit` กับ `create: true` แทน
                    ตามด้วยรายชื่อ tool ทั้งหมด ชื่อขั้นในแชตเป็นชื่อกับ JSON ของ input
                  from: engine
                  to: model
                  sees: { kind: step, label: 'write_file {"path":"src/date.ts","content":"..."}', status: failed }
                do: >-
                  ไม่มี executor ชื่อ `write_file` `unknownTool` เห็นว่าเป็นชื่อ tool เขียนไฟล์ของ harness อื่น
                  จึงตอบว่าให้ใช้ `edit` กับ `create: true` แทน ตามด้วยรายชื่อ tool ทั้งหมด ชื่อขั้นในแผงเป็นชื่อกับ JSON ของ input
                sees: ขั้น `write_file {"path":"src/date.ts","content":"..."}` ขึ้นเครื่องหมายล้มเหลว
                ref: packages/engine/src/tools/index.ts#unknownTool
                emits: [unknown tool]
          - id: invalid
            label: input ไม่ตรง schema
            then: result
            steps:
              - lane: tool
                at: executor
                beat:
                  title: "input ของ bash ไม่ตรง schema"
                  text: >-
                    `bash` ได้ `cmd` แทน `command` schema ไม่รับฟิลด์ที่ไม่รู้จัก ผลบอกฟิลด์ที่ขาดและฟิลด์ที่ไม่รู้จัก
                  from: engine
                  to: model
                  sees: { kind: step, label: 'bash {"cmd":"ls"}', status: failed }
                do: >-
                  `bash` ได้ `{"cmd": "ls"}` แทน `command` schema ของมันเป็น `strictObject` จึงไม่ผ่าน executor โยน `ToolError`
                  "invalid input: ..." ตามด้วยข้อความของ zod ที่บอกฟิลด์ที่ขาดและฟิลด์ที่ไม่รู้จัก
                  ชื่อขั้นอ่าน input ไม่ได้ จึงเป็นชื่อ tool กับ JSON ของ input
                sees: ขั้น `bash {"cmd":"ls"}` ขึ้นเครื่องหมายล้มเหลว
                ref: "packages/engine/src/tools/context.ts#\"if (!parsed.success) throw new ToolError(`invalid input: ${z.prettifyError(parsed.error)}`);\""
                emits: [invalid input]

    - id: result
      lane: tool
      at: executor
      beat:
        title: "ไม่มีอะไรรัน ผลเป็น error ที่บอกทางแก้"
        text: >-
          ทั้งสองทางไม่รันอะไร ไม่ผ่านกฎสิทธิ์ และไม่มีการ์ด Geno บันทึกผลเป็น error แล้วส่งไปที่แชต
        from: engine
        to: panel
      do: >-
        ทั้งสองทางได้ผลสถานะ `error` พร้อมข้อความนั้น ไม่มีอะไรรัน ไม่ผ่านนโยบาย และไม่มีการ์ด
      ref: packages/engine/src/tools/index.ts#runTool

    - use: tool-result-returns

    - id: next
      lane: loop
      at: step
      beat:
        title: "Model อ่านวิธีที่ถูกแล้วเรียกใหม่"
        text: >-
          turn ไม่หยุด Geno เรียก model ต่อ model ได้ผลที่บอกว่าเป็น error พร้อมวิธีเรียกที่ถูก
        from: engine
        to: model
        end: "model เรียกใหม่"
      do: >-
        `loopStep` เห็น `tool-result` ล่าสุดจึงตัดสิน `call-model` model ได้ `tool_result` ที่มี `is_error: true` และข้อความบอกวิธีที่ถูก
      ref: packages/core/src/loop.ts#loopStep
      emits: [call-model, is_error]
      phase: calling-model
      end: { turn: continues, reason: call-model }
---

ทุกอย่างที่ model เรียกผิดกลับไปเป็นผล `error` ให้ model อ่าน ไม่มีอะไรทำให้ turn ล้ม
Geno ไม่ซ่อมหรือเดา input ให้ model ต้องเรียกใหม่เอง (ยกเว้น tool ที่เลื่อนไว้ ซึ่ง `gate` แปลงค่าที่เขียนเป็นข้อความให้ตรงชนิดตาม schema ก่อนตรวจ)

สิ่งที่ควรสังเกต

- **ชื่อของ harness อื่นได้คำแนะนำ** `create`, `write`, `create_file`, `write_file` และ `Write` ได้ข้อความที่ชี้ไปที่ `edit` กับ `create: true`
  ชื่ออื่นได้แค่รายชื่อ tool
- **tool ที่เลื่อนไว้ไม่ใช่ชื่อที่ไม่มี** tool MCP และ tool ที่ไม่ใช่แกนหลักมีอยู่จริงแต่ถูกปฏิเสธจนกว่าจะโหลดด้วย `tool_search`
  ดู [Model โหลด tool ที่เลื่อนไว้ด้วย tool_search](/scenarios/tool/deferred-tool-load/)
- **input ที่ถูกตัดเพราะ `max_tokens` ไม่มาทางนี้** call ที่ถูกตัดได้คำตอบ `cut-off` จาก loop ก่อนถึง executor
  ดู [คำตอบของ model ชนเพดาน output](/scenarios/mstop/max-tokens/)

tool ที่มีจริงแต่ยังไม่ได้โหลด ดู [Model โหลด tool ที่เลื่อนไว้ด้วย tool_search](/scenarios/tool/deferred-tool-load/)
