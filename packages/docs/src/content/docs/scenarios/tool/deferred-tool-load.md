---
title: โหลดเครื่องมือที่เลื่อนไว้ด้วย tool_search
description: เครื่องมือนอกชุดหลักส่งให้โมเดลแค่ชื่อ โมเดลต้องเรียก tool_search ก่อนใช้ ถ้าเรียกเลยจะถูกปฏิเสธพร้อมคำบอกให้โหลดก่อน
tableOfContents: false
sidebar:
  order: 6
scenario:
  surface: vscode
  given:
    - turn กำลังทำงาน และรอบนี้เลื่อนเครื่องมือนอกชุดหลักไว้ (หรือมี MCP server เปิดอยู่) จึงมี `tool_search` ในรายการเครื่องมือ
    - "`monitor` เป็นเครื่องมือที่เลื่อนไว้ โมเดลเห็นแค่ชื่อและคำอธิบายสั้นในคำอธิบายของ `tool_search` และยังไม่เคยโหลดใน session นี้"
  trigger: >-
    โมเดลต้องการรอบรรทัด "listening" จากงานเบื้องหลัง `bg-1` ด้วย `monitor`
  covers: [tool.deferred-tool-load]
  related: [tool.bash-background, ext.mcp-tool-call, turn.with-tools]
  steps:
    - id: first
      lane: model
      do: >-
        โมเดลตัดสินใจว่าจะใช้ `monitor` และส่งบล็อก `tool_use` ออกมา จบด้วย `stop_reason: tool_use`
      ref: "packages/engine/src/gateway.ts#\"stopReason: message.stop_reason,\""
      emits: [tool_use]
      phase: calling-model
      fork:
        ask: โมเดลเรียกอะไรก่อน
        options:
          - id: direct
            label: เรียก monitor เลย
            then: search
            steps:
              - lane: loop
                at: drive
                do: >-
                  `drive` บันทึก event `assistant` ที่มีบล็อก `tool_use` ของ `monitor`
                ref: "packages/engine/src/drive.ts#\"await record({ kind: 'assistant', seq: nextSeq(events), at, ...result.turn\""
                emits: [assistant]
              - use: tool-call-opens
              - lane: tool
                at: executor
                runs: 0
                do: >-
                  executor ของ `monitor` ถูกห่อด้วย `gate` ซึ่งอ่าน log ด้วย `loadedTools` แล้วไม่พบว่าเคยโหลด
                  จึงโยน `ToolError` จาก `unloadedCallError` ("monitor is a deferred tool and is not loaded yet. Call tool_search with select: [\"monitor\"] first, ...")
                  `monitor` ไม่ได้ทำงาน
                ref: packages/core/src/deferred-tools.ts#unloadedCallError
                emits: [ToolError]
              - use: tool-result-returns
              - lane: loop
                at: step
                do: >-
                  `loopStep` เห็น `tool-result` ล่าสุดจึงตัดสิน `call-model` โมเดลได้อ่านว่าต้องโหลดก่อน
                ref: packages/core/src/loop.ts#loopStep
                emits: [call-model]
                phase: calling-model
          - id: search-first
            label: โหลดด้วย tool_search ก่อน
            then: search

    - id: search
      lane: model
      do: >-
        โมเดลเรียก `tool_search` ด้วย `select: ["monitor"]` (หรือ `query` ที่บรรยายสิ่งที่ต้องการ)
      ref: "packages/engine/src/gateway.ts#\"stopReason: message.stop_reason,\""
      emits: [tool_use]
      phase: calling-model

    - id: search-logged
      lane: loop
      at: drive
      do: >-
        `drive` บันทึก event `assistant` ที่มีบล็อก `tool_use` ของ `tool_search`
      ref: "packages/engine/src/drive.ts#\"await record({ kind: 'assistant', seq: nextSeq(events), at, ...result.turn\""
      emits: [assistant]

    - use: tool-call-opens

    - id: load
      lane: tool
      at: executor
      do: >-
        `searchTools` หา `monitor` ในเครื่องมือที่เลื่อนไว้ แล้วคืนนิยามเต็มของมันเป็นข้อความ JSON (ชื่อ คำอธิบาย และ `input_schema`)
        พร้อมรายการ `loaded` ที่ติดไปกับ `tool-result` ถ้าไม่พบอะไรเลย ผลเป็น error
      ref: packages/core/src/deferred-tools.ts#searchTools
      emits: [loaded]

    - use: tool-result-returns

    - id: decide
      lane: loop
      at: step
      do: >-
        `loopStep` ตัดสิน `call-model` จากนี้ `loadedTools` อ่านพบ `monitor` ใน `tool-result` ที่สถานะ `ok`
        ตลอดทั้ง session รวมถึงหลัง reload เพราะข้อมูลอยู่ใน log
      ref: packages/core/src/deferred-tools.ts#loadedTools
      emits: [call-model]

    - use: model-call

    - id: call
      lane: model
      do: >-
        โมเดลเรียก `monitor` ด้วย input ตาม schema ที่เพิ่งได้อ่าน คราวนี้ `gate` ปล่อยผ่าน
        และแปลงค่าที่โมเดลเขียนเป็นข้อความ เช่น `"2"` หรือ `"False"` ให้เป็นชนิดตาม schema ก่อนส่งต่อ
      ref: "packages/engine/src/tools/tool-search.ts#\"const typed = (raw: unknown) => coerceToSchema(roster.deferred.get(name)!.definition.input_schema, raw);\""
      emits: [tool_use]
      end: { turn: continues, reason: run-tools }
---

การเลื่อนเครื่องมือทำให้ส่วนต้นของคำขอสั้นลงและคงที่ คำขอส่งเฉพาะเครื่องมือชุดหลัก
(`agent`, `ask_user`, `bash`, `check`, `edit`, `glob`, `grep`, `list`, `read`, `skill`, `todo`) กับ `tool_search`
เครื่องมืออื่นอยู่ในคำอธิบายของ `tool_search` แค่ชื่อและคำใบ้หนึ่งบรรทัด

| เครื่องมือ | ถูกเลื่อนเมื่อไร |
| --- | --- |
| เครื่องมือของ Geno นอกชุดหลัก | เมื่อการเลื่อนประหยัดได้อย่างน้อย 300 token |
| เครื่องมือ MCP | เสมอ |

สิ่งที่ควรสังเกต

- **log เป็นตัวตัดสินว่าโหลดแล้ว** ไม่มีสถานะในหน่วยความจำ session ที่เปิดใหม่หรือ engine ที่เริ่มใหม่เรียกเครื่องมือที่เคยโหลดได้เลย
- **คำขอยังเหมือนเดิมทุกไบต์** การโหลดไม่ได้เพิ่มเครื่องมือเข้า `tools` ของคำขอ นิยามอยู่ใน `tool_result` ของ `tool_search`
  prompt cache จึงไม่หลุด
- **call ที่ผู้ใช้สั่งไม่ต้องโหลด** call ที่ฝั่งผู้ใช้ออกให้ เช่นของ `/workflow` ผ่าน `gate` ได้โดยไม่มี `tool_search`
