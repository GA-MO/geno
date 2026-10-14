---
title: "Model โหลด tool ที่เลื่อนไว้ด้วย tool_search"
description: tool นอกชุดหลักส่งให้ model แค่ชื่อ model ควรเรียก tool_search ก่อนใช้ ถ้าเรียกเลยด้วย input ที่ตรง schema Geno โหลดให้แล้วรันเลย ถ้า input ไม่ตรงจะไม่รัน และตอบด้วยนิยามของ tool
scenario:
  surface: vscode
  given:
    - turn กำลังทำงาน และรอบนี้เลื่อน tool นอกชุดหลักไว้ (หรือมี MCP server เปิดอยู่) จึงมี `tool_search` ในรายการ tool
    - "`monitor` เป็น tool ที่เลื่อนไว้ model เห็นแค่ชื่อและคำอธิบายสั้นในคำอธิบายของ `tool_search` และยังไม่เคยโหลดใน session นี้"
  trigger: >-
    model ต้องการรอบรรทัด "listening" จากงานเบื้องหลัง `bg-1` ด้วย `monitor`
  covers: [tool.deferred-tool-load]
  related: [tool.bash-background, ext.mcp-tool-call, turn.with-tools]
  steps:
    - id: first
      lane: model
      beat:
        title: "Model อยากใช้ monitor"
        text: >-
          `monitor` เป็น tool ที่เลื่อนไว้ model เห็นแค่ชื่อและคำอธิบายสั้นในคำอธิบายของ `tool_search` ยังไม่รู้ input
          ของมัน ลองเลือกว่า model เรียกอะไรก่อน
        from: model
        to: engine
        ask: "เรียกอะไรก่อน"
      do: >-
        model ตัดสินใจว่าจะใช้ `monitor` และส่งบล็อก `tool_use` ออกมา จบด้วย `stop_reason: tool_use`
      ref: "packages/engine/src/gateway.ts#\"stopReason: message.stop_reason,\""
      emits: [tool_use]
      phase: calling-model
      fork:
        ask: model เรียกอะไรก่อน
        options:
          - id: direct
            label: เรียก monitor เลย
            then: decide
            steps:
              - lane: loop
                at: drive
                beat:
                  title: "Model เรียก monitor ทั้งที่ยังไม่โหลด"
                  text: >-
                    Geno บันทึกคำขอ แล้วแชตขึ้นขั้นของ `monitor` พร้อมจุดหมุน
                  from: model
                  to: engine
                do: >-
                  `drive` บันทึก event `assistant` ที่มีบล็อก `tool_use` ของ `monitor`
                ref: "packages/engine/src/drive.ts#\"await record({ kind: 'assistant', seq: nextSeq(events), at, ...result.turn\""
                emits: [assistant]
              - use: tool-call-opens
              - lane: tool
                at: executor
                beat:
                  title: "Geno โหลดให้แล้วรัน"
                  text: >-
                    Geno อ่านบันทึกแล้วไม่พบว่าเคยโหลด `monitor` แต่ input ตรง schema จึงโหลดให้แล้วรันเลย ผลขึ้นต้นด้วยนิยามเต็มของ
                    `monitor` แบบที่ `tool_search` แสดง ตามด้วยผลของ call ถ้า input ไม่ตรง schema Geno ไม่รัน
                    และตอบเป็น error ที่มีนิยามเต็มกับสิ่งที่ผิด
                  from: engine
                  to: model
                  sees: { kind: step, label: monitor, status: running }
                do: >-
                  executor ของ `monitor` ถูกห่อด้วย `gate` ซึ่งอ่าน log ด้วย `loadedTools` แล้วไม่พบว่าเคยโหลด
                  จึงตรวจ input ด้วย schema ของ executor ถ้าผ่าน `gate` รัน `monitor` ผ่านการขออนุญาตเดิม
                  ใส่นิยามไว้หน้าผลด้วย `autoLoadedText` และติด `loaded: ["monitor"]` ไปกับ `tool-result` เหมือนผลของ `tool_search`
                  ถ้าไม่ผ่าน `gate` โยน `ToolError` จาก `unloadedInputError` และ `monitor` ไม่ได้ทำงาน
                ref: packages/core/src/deferred-tools.ts#autoLoadedText
                emits: [loaded]
              - use: tool-result-returns
          - id: search-first
            label: โหลดด้วย tool_search ก่อน
            then: search

    - id: search
      lane: model
      beat:
        title: "Model เรียก tool_search เพื่อโหลด"
        text: >-
          model เรียก `tool_search` ด้วยชื่อ tool ที่ต้องการ หรือด้วยคำบรรยายสิ่งที่ต้องการ run จริงด้านล่างโหลด
          `web_fetch` แบบเดียวกัน
        from: model
        to: engine
        sees:
          kind: payload
          source: docs/results/real-usecases/runs/A05-deferred-web-fetch/1/session.jsonl#seq=4
          select: content
          highlight:
            - "[2].input"
          collapse:
            - "[0].thinking"
      do: >-
        model เรียก `tool_search` ด้วย `select: ["monitor"]` (หรือ `query` ที่บรรยายสิ่งที่ต้องการ)
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
      beat:
        title: "Geno คืนนิยามเต็มของ tool"
        text: >-
          Geno หา tool ในรายการที่เลื่อนไว้ แล้วคืนนิยามเต็ม ทั้งชื่อ คำอธิบาย และ schema ของ input พร้อมจดว่าโหลดแล้ว
          ถ้าไม่พบอะไรเลย ผลเป็น error
        from: engine
        to: model
        sees:
          kind: payload
          source: docs/results/real-usecases/runs/A05-deferred-web-fetch/1/requests.jsonl#seq=7
          select: messages[-1].content[0]
          collapse:
            - content
      do: >-
        `searchTools` หา `monitor` ใน tool ที่เลื่อนไว้ แล้วคืนนิยามเต็มของมันเป็นข้อความ JSON (ชื่อ คำอธิบาย และ `input_schema`)
        พร้อมรายการ `loaded` ที่ติดไปกับ `tool-result` ถ้าไม่พบอะไรเลย ผลเป็น error
      ref: packages/core/src/deferred-tools.ts#searchTools
      emits: [loaded]

    - use: tool-result-returns

    - id: decide
      lane: loop
      at: step
      beat:
        title: "Geno จำว่าโหลดแล้วทั้ง session"
        text: >-
          การโหลดอยู่ในบันทึกของ session จึงมีผลตลอด session รวมถึงหลัง reload Geno เรียก model ต่อ
        from: engine
        to: model
      do: >-
        `loopStep` ตัดสิน `call-model` จากนี้ `loadedTools` อ่านพบ `monitor` ใน `tool-result` ที่สถานะ `ok`
        ตลอดทั้ง session รวมถึงหลัง reload เพราะข้อมูลอยู่ใน log
      ref: packages/core/src/deferred-tools.ts#loadedTools
      emits: [call-model]

    - use: model-call

    - id: call
      lane: model
      beat:
        title: "Model เรียก monitor ตาม schema"
        text: >-
          คราวนี้ Geno ปล่อยผ่าน และแปลงค่าที่ model เขียนเป็นข้อความ เช่น "2" หรือ "False" ให้เป็นชนิดตาม schema
          ก่อนส่งต่อ run จริงด้านล่างเรียก `web_fetch` ที่เพิ่งโหลด
        from: model
        to: engine
        end: "tool พร้อมใช้"
        sees:
          kind: payload
          source: docs/results/real-usecases/runs/A05-deferred-web-fetch/1/session.jsonl#seq=7
          select: content
          collapse:
            - "[0].thinking"
      do: >-
        model เรียก `monitor` ด้วย input ตาม schema ที่เพิ่งได้อ่าน คราวนี้ `gate` ปล่อยผ่าน
        และแปลงค่าที่ model เขียนเป็นข้อความ เช่น `"2"` หรือ `"False"` ให้เป็นชนิดตาม schema ก่อนส่งต่อ
      ref: "packages/engine/src/tools/tool-search.ts#\"const typed = (raw: unknown) => coerceToSchema(definition.input_schema, raw);\""
      emits: [tool_use]
      end: { turn: continues, reason: run-tools }
---

การเลื่อน tool ทำให้ส่วนต้นของคำขอสั้นลงและคงที่ คำขอส่งเฉพาะ tool ชุดหลัก
(`agent`, `ask_user`, `bash`, `check`, `edit`, `glob`, `grep`, `list`, `read`, `skill`, `todo`) กับ `tool_search`
tool อื่นอยู่ในคำอธิบายของ `tool_search` แค่ชื่อและคำใบ้หนึ่งบรรทัด

| tool | ถูกเลื่อนเมื่อไร |
| --- | --- |
| tool ของ Geno นอกชุดหลัก | เมื่อการเลื่อนประหยัดได้อย่างน้อย 300 token |
| tool MCP | เสมอ |

สิ่งที่ควรสังเกต

- **log เป็นตัวตัดสินว่าโหลดแล้ว** ไม่มีสถานะในหน่วยความจำ session ที่เปิดใหม่หรือ engine ที่เริ่มใหม่เรียก tool ที่เคยโหลดได้เลย
- **คำขอยังเหมือนเดิมทุกไบต์** การโหลดไม่ได้เพิ่ม tool เข้า `tools` ของคำขอ นิยามอยู่ใน `tool_result` ของ `tool_search`
  prompt cache จึงไม่หลุด
- **call ที่ผู้ใช้สั่งไม่ต้องโหลด** call ที่ฝั่งผู้ใช้ออกให้ เช่นของ `/workflow` ผ่าน `gate` ได้โดยไม่มี `tool_search`

call ที่ผิดแบบอื่น ดู [Model เรียก tool ที่ไม่มีจริง หรือส่ง input ผิด](/scenarios/tool/unknown-or-invalid/)
