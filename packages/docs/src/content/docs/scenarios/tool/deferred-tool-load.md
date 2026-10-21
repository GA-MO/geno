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
          `monitor` เป็น tool ที่เลื่อนไว้ คือ tool ที่ Geno ไม่ส่ง schema ของ input ไปใน `tools` ของคำขอ เพื่อให้คำขอสั้น
          model เห็นแค่ชื่อและคำอธิบายสั้นในคำอธิบายของ `tool_search` ยังไม่รู้ input ของมัน ลองเลือกว่า model เรียกอะไรก่อน
          การ์ดข้างล่างเป็นคำตอบจริงจากการรันหนึ่งที่ model โหลด `monitor` ด้วย `tool_search` ก่อน
          ดู `input` ของ `tool_search` ที่ไฮไลต์ไว้ `select` คือรายชื่อ tool ที่ขอโหลด
        from: model
        to: engine
        sees:
          kind: payload
          source: docs/results/real-usecases/runs/A12-background-server/fix-a2/session.jsonl#seq=3
          select: content
          collapse: ['[0].thinking']
          highlight: ['[3].input']
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
            steps:
              - lane: loop
                at: drive
                beat:
                  title: "Model เรียก monitor ทั้งที่ยังไม่โหลด"
                  text: >-
                    Geno บันทึกคำขอ แล้วแชตขึ้นขั้นของ `monitor` พร้อมจุดหมุน การ์ดข้างล่างมาจากการบันทึกที่รัน Geno จริงกับ model
                    จำลองที่ตอบตามบทที่เขียนไว้ก่อน ในการบันทึกนั้น model เริ่ม `node server.js` เป็น `bg-1` แล้วเรียก `monitor` สองครั้งโดยไม่โหลด
                    ครั้งแรก input ผิด ครั้งที่สองถูก การ์ดคือ call ครั้งแรกตามที่ Geno ใส่กลับในคำขอถัดไป ดู `input` ที่ไฮไลต์
                    model เดาชื่อ field เป็น `job` ซึ่งไม่มีใน schema
                  from: model
                  to: engine
                  sees:
                    kind: payload
                    source: packages/docs/src/data/recorded/tool-deferred-tool-load.jsonl#line=7
                    select: messages[-2]
                    highlight: ['content[1].input']
                do: >-
                  `drive` บันทึก event `assistant` ที่มีบล็อก `tool_use` ของ `monitor`
                ref: "packages/engine/src/drive.ts#\"await record({ kind: 'assistant', seq: nextSeq(events), at, ...result.turn\""
                emits: [assistant]
              - use: tool-call-opens
              - lane: tool
                at: executor
                beat:
                  title: "Geno ตรวจ input แล้วรันให้ถ้าตรง schema"
                  text: >-
                    Geno อ่าน session log แล้วไม่พบว่าเคยโหลด `monitor` จึงตรวจ input กับ schema ถ้าตรง Geno รันให้เลย ถ้า call สำเร็จ
                    Geno นับว่าโหลดแล้ว ผลขึ้นต้นด้วยประโยคว่า model เรียก `monitor` ก่อนโหลด ตามด้วยนิยามเต็มแบบที่ `tool_search` แสดง แล้วจึงเป็นผลของ call
                    ถ้า input ไม่ตรง schema Geno ไม่รัน และตอบเป็น error ที่มีนิยามเต็มกับสิ่งที่ผิด ผลนี้ถึง model ตอนเรียกครั้งถัดไป
                  from: engine
                  to: engine
                  sees: { kind: step, label: monitor, status: running }
                  ask: "call ตรงนั้นจบอย่างไร"
                do: >-
                  executor ของ `monitor` ถูกห่อด้วย `gate` ซึ่งอ่าน log ด้วย `loadedTools` แล้วไม่พบว่าเคยโหลด
                  จึงตรวจ input ด้วย schema ของ executor ถ้าผ่าน `gate` รัน `monitor` ผ่านการขออนุญาตเดิม
                  ถ้ารันสำเร็จ ใส่ประโยคเปิดกับนิยามไว้หน้าผลด้วย `autoLoadedText` และติด `loaded: ["monitor"]` ไปกับ `tool-result` เหมือนผลของ `tool_search`
                  ถ้า `monitor` โยน `ToolError` ผลเป็น error ที่มีนิยามแต่ไม่มี `loaded` ถ้าถูกปฏิเสธ (`ToolRejected` หรือ `ToolDenied` ซึ่งไม่เกิดในทัวร์นี้ เพราะ `monitor` บน `background_job_id` ไม่ขออนุญาต)
                  error ส่งต่อโดยไม่มีนิยาม ถ้า input ไม่ผ่าน `gate` โยน `ToolError` จาก `unloadedInputError` และ `monitor` ไม่ได้ทำงาน
                ref: packages/core/src/deferred-tools.ts#autoLoadedText
                emits: [loaded]
                fork:
                  ask: call ตรงนั้นจบอย่างไร
                  options:
                    - id: direct-ok
                      label: input ตรง schema และรันสำเร็จ
                      steps:
                        - use: tool-result-returns
                          beat:
                            title: "monitor เริ่มเฝ้า ผลกลับมาที่แชต"
                            text: >-
                              Geno บันทึกผลแล้วส่งไปที่แชต ผลขึ้นต้นด้วยประโยคเปิดและนิยามเต็มของ `monitor` ตามด้วยผลของ call ว่าเฝ้า `bg-1` อยู่
                            from: engine
                            to: panel
                            sees: { kind: step, label: monitor, status: done }
                        - lane: loop
                          at: step
                          beat:
                            title: "โหลดแล้ว และ monitor เฝ้าอยู่แล้ว"
                            text: >-
                              ผลนี้จดใน session log ว่าโหลด `monitor` แล้ว จึงมีผลตลอด session รวมถึงหลัง reload หน้าต่าง VS Code
                              call ถัดไปของ `monitor` ผ่านได้เลย Geno เรียก model อีกรอบพร้อมผลนี้ ผลบอกว่า `monitor` เริ่มเฝ้า `bg-1` แล้ว
                              และให้ model จบ turn เพราะ Geno จะปลุกเมื่อเจอบรรทัดที่ตรง model จึงไม่ต้องเรียก `monitor` ซ้ำ
                              การ์ดข้างล่างคือผลของ call ครั้งที่สองในการบันทึก ซึ่งส่ง `background_job_id` ตาม schema ดู `content` ที่ไฮไลต์
                              ขึ้นต้นด้วย "You called monitor before loading it" ตามด้วยนิยาม (แท็บแรก) แล้วท้ายสุดคือ "The call's result:" กับผลของ `monitor` (แท็บสอง)
                            from: engine
                            to: model
                            end: "โหลดแล้ว monitor เฝ้าอยู่"
                            sees:
                              - kind: payload
                                source: packages/docs/src/data/recorded/tool-deferred-tool-load.jsonl#line=9
                                select: messages[-1]
                                highlight: ['content[0].content']
                                quote: You called monitor before loading it
                              - kind: payload
                                source: packages/docs/src/data/recorded/tool-deferred-tool-load.jsonl#line=9
                                select: messages[-1]
                                highlight: ['content[0].content']
                                quote: "The call's result:"
                          do: >-
                            `loopStep` ตัดสิน `call-model` จากนี้ `loadedTools` อ่านพบ `monitor` ใน `tool-result` ที่สถานะ `ok`
                            ผลของ `monitor` ลงท้ายด้วย "End your turn now: Geno wakes you with the line when one matches"
                          ref: packages/core/src/deferred-tools.ts#loadedTools
                          emits: [call-model]
                          end: { turn: continues, reason: call-model }
                    - id: direct-bad
                      label: input ไม่ตรง schema หรือ monitor ล้มเหลว
                      steps:
                        - use: tool-result-returns
                          beat:
                            title: "ผลเป็น error ที่มีนิยาม"
                            text: >-
                              Geno บันทึกผลแล้วส่งไปที่แชต ผลเป็น error ที่มีนิยามเต็มของ `monitor` กับสิ่งที่ผิด
                            from: engine
                            to: panel
                            sees: { kind: step, label: monitor, status: failed }
                        - lane: loop
                          at: step
                          beat:
                            title: "Model ได้ error พร้อมนิยาม"
                            text: >-
                              ยังไม่นับว่าโหลด เพราะ call ไม่สำเร็จ แต่ error มีนิยามเต็มของ `monitor` แล้ว Geno เรียก model อีกรอบ
                              ถ้า input ผิด error บอกสิ่งที่ผิดและให้เรียก `monitor` ใหม่ด้วย input ตาม schema
                              ถ้า call ใหม่นั้นสำเร็จ Geno นับว่าโหลดแล้วแบบทางที่สำเร็จ
                              การ์ดข้างล่างคือผลของ call ครั้งแรกในการบันทึก ดู `content` ที่ไฮไลต์ บอกว่า `monitor` ไม่ได้รัน
                              เพราะ `Unrecognized key: "job"` ตามด้วยนิยามเต็ม และ `is_error` เป็น `true`
                            from: engine
                            to: model
                            end: "model ได้ schema แล้วเรียกใหม่"
                            sees:
                              kind: payload
                              source: packages/docs/src/data/recorded/tool-deferred-tool-load.jsonl#line=7
                              select: messages[-1]
                              highlight: ['content[0].content', 'content[0].is_error']
                          do: >-
                            `loopStep` ตัดสิน `call-model` `loadedTools` ยังไม่พบ `monitor` เพราะผลเป็น error ไม่มี `loaded`
                            ข้อความของ `unloadedInputError` ลงท้ายด้วย "Call monitor again with input that matches the input_schema."
                          ref: packages/core/src/deferred-tools.ts#unloadedInputError
                          emits: [call-model]
                          end: { turn: continues, reason: call-model }
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
          Geno หา tool ในรายการที่เลื่อนไว้ แล้วคืนนิยามเต็ม ทั้งชื่อ คำอธิบาย และ schema ของ input พร้อมจดในผลว่าโหลดแล้ว
          ถ้าไม่พบอะไรเลย ผลเป็น error ผลนี้ถึง model ตอนเรียกครั้งถัดไป การ์ดข้างล่างเป็นผลจริงของการโหลด `web_fetch`
          คลิกเปิด `content` ที่พับไว้ จะเห็น "Loaded this tool" ตามด้วยนิยามเป็น JSON
        from: engine
        to: engine
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
          ผลของ `tool_search` มีนิยามเต็มของ tool และจดไว้ว่าโหลดแล้ว แบบเดียวกับการเรียก `monitor` ตรงๆ ที่สำเร็จ
          การโหลดอยู่ใน session log จึงมีผลตลอด session รวมถึงหลัง reload หน้าต่าง VS Code Geno ส่งบทสนทนาทั้งหมดไปให้ model
          อีกครั้งในคำขอใหม่ ท้ายคำขอคือ call ล่าสุดของ model กับผลที่มีนิยามเต็ม รายการ `tools` ในคำขอไม่เปลี่ยน
          นิยามอยู่ใน `tool_result` แทน การ์ดข้างล่างเป็นทาง `tool_search` จากการรันเดียวกับการ์ดของ `web_fetch`
          ดูบล็อก `tool_use` ของ `tool_search` และ `tool_result` ที่ตอบมันซึ่งไฮไลต์ไว้
        from: engine
        to: model
        sees:
          kind: payload
          source: docs/results/real-usecases/runs/A05-deferred-web-fetch/1/requests.jsonl#seq=7
          select: messages
          collapse: ['[0]']
          highlight: ['[1].content[2]', '[2].content[0]']
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
          model ตอบหลังได้คำขอนี้เท่านั้น ตอนนี้ model อ่าน schema แล้ว call ถัดไปของ tool นี้จึงส่ง input ตาม schema
          ถ้า log จดว่าโหลดแล้ว Geno ปล่อยผ่านเลย และแปลงค่าที่ model เขียนเป็นข้อความ เช่น "2" หรือ "False"
          ให้เป็นชนิดตาม schema ก่อนส่งต่อ การ์ดข้างล่างเป็น run จริงที่เรียก `web_fetch` ที่เพิ่งโหลด
          ดู `input` ที่มี `url` และ `question` ตาม schema
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

การเลื่อน tool ทำให้ส่วนต้นของคำขอสั้นลงและคงที่ เมื่อมี tool ที่ถูกเลื่อน คำขอส่งเฉพาะ tool ชุดหลัก
(`agent`, `ask_user`, `bash`, `check`, `edit`, `glob`, `grep`, `list`, `read`, `skill`, `todo`) กับ `tool_search`
tool อื่นของ Geno อยู่ในคำอธิบายของ `tool_search` แค่ชื่อและคำใบ้หนึ่งบรรทัด
ส่วน tool ของ MCP ไม่อยู่ในรายการนั้น Geno บอกชื่อในบทสนทนาเมื่อ server เชื่อมต่อ และโหลดผ่าน `tool_search` แบบเดียวกัน

| tool | ถูกเลื่อนเมื่อไร |
| --- | --- |
| tool ของ Geno นอกชุดหลัก | เมื่อการเลื่อนประหยัดได้อย่างน้อย 300 token |
| tool MCP | เสมอ |

สิ่งที่ควรสังเกต

- **log เป็นตัวตัดสินว่าโหลดแล้ว** ไม่มีสถานะในหน่วยความจำ session ที่เปิดใหม่หรือ engine ที่เริ่มใหม่เรียก tool ที่เคยโหลดได้เลย
- **คำขอยังเหมือนเดิมทุกไบต์** การโหลดไม่ได้เพิ่ม tool เข้า `tools` ของคำขอ นิยามอยู่ใน `tool_result` ของ `tool_search`
  [prompt cache](/start/glossary/) จึงไม่หลุด
- **call ที่ผู้ใช้สั่งไม่ต้องโหลด** call ที่ฝั่งผู้ใช้ออกให้ เช่นของ `/workflow` ผ่าน `gate` ได้โดยไม่มี `tool_search`

call ที่ผิดแบบอื่น ดู [Model เรียก tool ที่ไม่มีจริง หรือส่ง input ผิด](/scenarios/tool/unknown-or-invalid/)
