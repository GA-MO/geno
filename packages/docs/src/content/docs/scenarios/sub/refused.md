---
title: "subagent ที่เริ่มไม่ได้"
description: ใน run แบบ non-interactive ลูกที่แก้ไฟล์ได้ถูกปฏิเสธ และเมื่องบของลูกในรอบนี้หมด ลูกตัวใหม่ก็ถูกปฏิเสธ model ได้ error แล้วทำต่อเอง
scenario:
  surface: cli
  given:
    - "ผู้ใช้รัน `gcode agent --non-interactive --max-cost 0.05 \"...\"` ไม่มี `--allow-worker`"
    - "ค่า `agentTool` ในการตั้งค่าของผู้ใช้มี `non-interactive` model จึงเรียก `agent` เองได้"
    - ก่อนหน้านี้ใน run เดียวกัน model เริ่ม `explore` ไปแล้วหลายตัว
  trigger: >-
    model ขอเรียก `agent` อีกครั้ง
  covers: [sub.budget-or-writer-refused]
  related: [cli.non-interactive, sub.blocking-report, cli.agent-run]
  steps:
    - id: wants
      beat:
        title: Model ขอเรียก agent อีกครั้ง
        text: >-
          ใน run แบบ non-interactive ของ `gcode agent` model ขอส่งงานให้ subagent ลูกตัวก่อนหน้าใน run นี้ใช้งบไปแล้ว
          tool `agent` ยังอยู่ในรายการของ model แม้ run นี้จะเริ่ม worker ไม่ได้ (แท็บแรก) model ส่ง `tool_use` ที่ขอ
          `agent: "worker"` พร้อม `task` (แท็บสอง)
        from: model
        to: engine
        sees:
          - kind: payload
            source: packages/docs/src/data/recorded/refused-writer.jsonl#line=2
            select: tools[9]
            highlight: [description]
          - kind: payload
            source: packages/docs/src/data/recorded/refused-writer.jsonl#line=4
            select: messages[1].content
            highlight: ['[1].input']
      lane: model
      do: >-
        model ขอเรียก `agent` พร้อม task จบคำตอบด้วย `stop_reason: tool_use`
      ref: packages/core/src/subagent.ts#agentToolDefinition
      emits: [tool_use]
      phase: calling-model

    - id: decide
      beat:
        title: เทอร์มินัลพิมพ์ชื่อขั้น
        text: Geno ตัดสินว่าจะรัน tool call นี้ เทอร์มินัลพิมพ์บรรทัดของขั้นที่เริ่ม
        from: panel
        to: you
        sees: "> agent worker: In src/version.ts, make parseVersion throw …"
      lane: loop
      at: step
      do: >-
        `drive` บันทึก event `assistant` แล้ว `loopStep` ตัดสินว่า `run-tools`
      ref: packages/core/src/loop.ts#loopStep
      emits: [run-tools]
      phase: running-tools

    - id: printed
      lane: panel
      at: terminal
      alongside: true
      do: >-
        call ที่เริ่มพิมพ์บรรทัด `> ` ตามด้วยชื่อขั้น
      sees: "> agent worker: In src/version.ts, make parseVersion throw …"
      ref: packages/engine/src/drive.ts#terminalSurface

    - id: launch
      beat:
        title: Geno ตรวจว่าเริ่ม subagent ได้ไหม
        text: ก่อนเปิดอะไร Geno ตรวจสองอย่าง subagent แก้ไฟล์ได้ไหม และงบของลูกใน run นี้เหลือไหม
        from: engine
        to: engine
        ask: Model ขอตัวไหน
      lane: loop
      at: tools
      do: >-
        executor ของ `agent` เรียก `launch` ก่อนเปิดอะไร `launch` ตรวจว่าลูกตัวนี้เริ่มได้ไหม
      ref: packages/engine/src/subagents.ts#subagents
      fork:
        ask: model ขอลูกตัวไหน
        options:
          - id: writer
            label: worker (แก้ไฟล์ได้)
            then: logged
            steps:
              - lane: loop
                beat:
                  title: worker แก้ไฟล์ได้ แต่ไม่มีใครตอบการ์ด
                  text: run นี้ไม่มีคนตอบ permission และไม่ได้ส่ง `--allow-worker` Geno จึงปฏิเสธ worker ทันที
                  from: engine
                  to: model
                at: tools
                do: >-
                  `worker` ไม่ใช่ลูกอ่านอย่างเดียว และ run นี้ไม่มีใครตอบการ์ด (`non-interactive`) โดยไม่มี `--allow-worker`
                  `launch` จึงโยน `ToolError` ทันที: "worker may change files, and a non-interactive run starts only read-only subagents"
                  ไม่มี session ของลูก ไม่มี `child-start`
                ref: "packages/engine/src/subagents.ts#\"may change files, and a non-interactive run starts only read-only subagents\""
                emits: [ToolError]

          - id: budget
            label: explore (อ่านอย่างเดียว)
            then: logged
            steps:
              - lane: loop
                beat:
                  title: explore ผ่าน แต่งบหมดแล้ว
                  text: ลูกแต่ละตัวจองงบทั้งก้อนตอนเริ่ม และคืนส่วนที่ไม่ได้ใช้ตอนจบ งบ `--max-cost` ที่เหลือเป็นศูนย์ Geno จึงไม่เปิด session ของลูก
                  from: engine
                  to: model
                at: tools
                do: >-
                  `explore` ผ่านด่านแรก `runChild` คำนวณเพดานด้วย `childCaps` จากงบ `--max-cost` ลบด้วยที่ลูกก่อนหน้าจองไว้
                  ลูกแต่ละตัวจองเพดานทั้งก้อนตอนเริ่มและคืนส่วนที่ไม่ได้ใช้ตอนจบ งบที่เหลือเป็นศูนย์ `childCaps` จึงไม่ให้เพดาน
                ref: packages/core/src/subagent.ts#childCaps
              - lane: loop
                at: tools
                do: >-
                  `runChild` โยน `ToolError`: "the subagents of this run have spent their $0.05 together; finish without another one"
                  ไม่มี session ของลูก
                ref: "packages/engine/src/subagents.ts#\"the subagents of this run have spent their $\""
                emits: [ToolError]

    - id: logged
      beat:
        title: Geno ส่ง error ให้ model อ่าน
        text: >-
          ผลของ call เป็น `tool_result` ที่มี `is_error: true` และบอกเหตุผล ไม่มี `<subagent_report>` เพราะไม่มีลูก
          เทอร์มินัลไม่พิมพ์ผลนี้ (การ์ดคือทาง worker)
        from: engine
        to: model
        sees:
          kind: payload
          source: packages/docs/src/data/recorded/refused-writer.jsonl#line=4
          select: messages[2].content[0]
          highlight: [content, is_error]
      lane: loop
      at: tools
      do: >-
        `runTools` บันทึก `tool-result` สถานะ `error` ข้อความ error คือสิ่งที่ model จะอ่าน
        เทอร์มินัลไม่พิมพ์ผลของ call
      ref: "packages/engine/src/drive.ts#\"for (const result of outcome.results) if (result !== undefined) await record(result);\""
      emits: [tool-result, error]

    - use: model-call

    - id: goes-on
      beat:
        title: Model ทำงานนั้นเอง
        text: >-
          model อ่าน error แล้วทำงานเอง หรือบอกในคำตอบว่าต้องการอะไรจากคุณ เช่นให้รันใหม่ด้วย `--allow-worker`
          ในการบันทึกนี้ model อ่าน `src/version.ts` แล้ว `edit` เอง
        from: model
        to: engine
        sees:
          kind: payload
          source: packages/docs/src/data/recorded/refused-writer.jsonl#line=8
          select: messages[5].content
          highlight: ['[1].input']
        end: Model ทำต่อเอง
      lane: model
      do: >-
        model อ่าน error แล้วทำงานนั้นเอง หรือบอกในคำตอบว่าต้องการอะไรจากผู้ใช้ เช่นให้รันใหม่ด้วย `--allow-worker`
      ref: "packages/engine/src/gateway.ts#\"stopReason: message.stop_reason,\""
      emits: [tool_use]
      end: { turn: continues, reason: call-model }
---

ทั้งสองทางเป็น `ToolError` ธรรมดา: call ได้ผลเป็น error turn ไม่จบ และ model ตัดสินใจเองว่าจะทำอะไรต่อ

| ด่าน | ตรวจที่ | ข้อความ |
| --- | --- | --- |
| ลูกที่แก้ไฟล์ใน run ที่ไม่มีใครตอบ | `launch` ก่อนทุกอย่าง | `<name> may change files, and a non-interactive run starts only read-only subagents` |
| งบของลูกหมด | `runChild` ก่อนเปิด session | `the subagents of this run have spent their $<งบ> together; finish without another one` |

สิ่งที่ควรสังเกต

- **"spent" นับเงินที่จองด้วย** ลูกที่ยังรันอยู่จองเพดานของตัวเองไว้ทั้งก้อน ลูกตัวใหม่จึงถูกปฏิเสธได้ทั้งที่ยังไม่มีใครใช้เงินถึง
- **งบเขียนตามค่าที่ตั้ง** ข้อความใช้ตัวเลขของ `--max-cost` ตรงๆ ค่าเริ่มต้น 0.40 จึงขึ้นเป็น `$0.4`
- **ทางเลี่ยงที่ไม่ได้ตั้งใจไม่มี** สกิลแบบ `context: fork` ที่ model เรียกก็เริ่ม `worker` ผ่าน `launch` เดียวกัน จึงถูกปฏิเสธแบบเดียวกัน
- **ใน VS Code** ด่านแรกไม่เกิด เพราะมีคนตอบการ์ดได้เสมอ ด่านงบเกิดได้เหมือนกัน
