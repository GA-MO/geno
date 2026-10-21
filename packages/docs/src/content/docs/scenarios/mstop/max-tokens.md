---
title: "คำตอบของ model ชนเพดาน output"
description: model เขียนจนถึง max_tokens ถ้าบล็อกที่ถูกตัดเป็นข้อความ turn จบแบบ failed ทันที ถ้าเป็นการเรียก tool Geno บอก model ให้เรียกใหม่ให้เล็กลงหนึ่งครั้ง
scenario:
  surface: vscode
  given:
    - ผู้ใช้ส่งข้อความในแผงแชตของ VS Code และ turn กำลังทำงาน
    - model ตอบยาวเกินเพดาน output ของคำขอ (`max_tokens`) เพดานนี้คือเพดาน output ของ model (131,072 token บน qwen3.8-flash ซึ่งเป็นค่าตั้งต้น)
      หรือต่ำกว่านั้นบน model ที่หน้าต่าง context เล็กเมื่อเทียบกับเพดาน output เช่น `claude-haiku-4-5` เมื่อบทสนทนายาวจนที่ว่างเหลือน้อย
  trigger: >-
    model เขียนคำตอบยาว หรือเรียก `edit` เพื่อสร้างไฟล์ยาว จนผู้ให้บริการตัดคำตอบที่เพดาน output
  covers: [mstop.max-tokens-text, mstop.max-tokens-cut-tool]
  related: [mstop.empty-answer-nudged, mstop.no-reply-continue-retry, mstop.limit-max-turns, ctx.compaction-auto]
  steps:
    - use: model-call
      beat:
        title: "Geno ส่งคำขอพร้อมเพดาน output"
        text: >-
          ทุกคำขอมี `max_tokens` คือเพดานความยาวของคำตอบหนึ่งครั้ง นับเป็น token Geno ตั้งเป็นค่าที่น้อยกว่าระหว่างเพดาน output ของ model
          กับที่ว่างที่เหลือในหน้าต่าง context (จำนวน token สูงสุดที่ model อ่านได้ในคำขอเดียว รวมคำตอบด้วย)
          เพดานจึงลดลงได้เฉพาะบน model ที่หน้าต่างเล็กเมื่อเทียบกับเพดาน output
          บน qwen3.8-flash ซึ่งเป็นค่าตั้งต้น หน้าต่างมี 1,000,000 token และ Geno สรุปบทสนทนาเก่าให้สั้นลงเมื่อ context ถึง 200,000 token
          ที่ว่างจึงเหลือมากกว่าเพดาน 131,072 เสมอ เพดานไม่ลด
          การบันทึกนี้จึงใช้ `claude-haiku-4-5` ซึ่งมีหน้าต่าง 200,000 token และเพดาน output 64,000 token
          การ์ดข้างล่างมาจากการบันทึกที่รัน Geno จริงกับ model จำลองที่ตอบตามบทที่เขียนไว้ก่อน ดู `max_tokens` ที่ไฮไลต์ไว้
          แท็บแรกคือคำขอแรกของ turn ที่ขอให้อธิบาย package.json ได้เพดานเต็ม 64000 แท็บสองคือคำขอถัดมา
          model จำลองตั้ง usage ในคำตอบแรกให้รายงานว่า input ยาวราว 150,000 token (บทสนทนาจริงในการบันทึกสั้นกว่านั้นมาก)
          Geno ประเมินขนาดบทสนทนาจากตัวเลขนี้ ที่ว่างจึงเหลือราว 49,000 เพดานจึงเหลือ 48959
        from: engine
        to: model
        sees:
          - kind: payload
            source: packages/docs/src/data/recorded/max-tokens.jsonl#line=10
            highlight: [max_tokens]
            collapse: [tools, system, messages]
          - kind: payload
            source: packages/docs/src/data/recorded/max-tokens.jsonl#line=12
            highlight: [max_tokens]
            collapse: [tools, system, messages]

    - id: cut
      lane: model
      beat:
        title: "Model เขียนจนชนเพดาน"
        text: >-
          model เขียนคำตอบยาว หรือเรียก tool เพื่อสร้างไฟล์ยาว จนผู้ให้บริการตัดคำตอบที่เพดาน
          field `stop_reason` ท้ายคำตอบ (field ที่บอกว่า model หยุดเพราะอะไร) จึงเป็น `max_tokens` ถ้าบล็อกที่ถูกตัดเป็นข้อความ ส่วนที่เขียนมาแล้วขึ้นในแชต
          แท็บแรกคือข้อความนั้นในแชต แท็บสองและสามมาจากการบันทึกเดียวกับการ์ดก่อน แท็บสองคือท้าย stream ของคำตอบที่เป็นข้อความ ดู `stop_reason` เป็น `max_tokens`
          และ `output_tokens` (จำนวน token ที่ model เขียน) เท่ากับเพดาน 48959 พอดี
          แท็บสามคือคำตอบที่เรียก `edit` เพื่อสร้างไฟล์ ใน turn ก่อนหน้าของการบันทึกเดียวกัน ตอนนั้นบทสนทนายังสั้น คำขอได้เพดานเต็ม 64000
          แต่คำตอบยาวเกินเพดานนั้น input ของ tool มาเป็นชิ้นๆ ใน `partial_json` และชิ้นนี้หยุดกลาง JSON เพราะถูกตัด
        from: model
        to: engine
        sees:
          - { kind: message, from: geno, text: package.json sets up three things. The first is, streaming: true }
          - kind: payload
            source: packages/docs/src/data/recorded/max-tokens.jsonl#line=13
            select: '[-2]'
            highlight: [data.delta.stop_reason, data.usage.output_tokens]
          - kind: payload
            source: packages/docs/src/data/recorded/max-tokens.jsonl#line=5
            select: '[2]'
            highlight: [data.delta.partial_json]
            quote: Case 5
      do: >-
        model เขียนจนถึงเพดาน `max_tokens` ของคำขอ ผู้ให้บริการหยุด stream แล้วจบด้วย `stop_reason: max_tokens`
        (wire แบบ OpenAI ได้ `length` ซึ่ง `STOP_REASONS` แปลงเป็น `max_tokens`)
      ref: "packages/engine/src/gateway.ts#\"stopReason: message.stop_reason,\""
      emits: [max_tokens]

    - use: answer-streams

    - id: decide
      lane: loop
      at: step
      beat:
        title: "Geno ดูว่าอะไรถูกตัด"
        text: >-
          tool call ที่ถูกตัดมี input ไม่ครบ รันไม่ได้ Geno จึงดูว่าบล็อกสุดท้ายของคำตอบเป็นข้อความหรือ tool call
        from: engine
        to: engine
        ask: "อะไรถูกตัด"
      do: >-
        `loopStep` อ่านคำตอบล่าสุด `cutOff` ดูว่าบล็อกสุดท้ายของคำตอบที่จบด้วย `max_tokens` เป็นการเรียก tool หรือไม่
        เพราะการเรียกที่ถูกตัดมี input ไม่ครบ รันไม่ได้
      ref: packages/core/src/loop.ts#cutOff
      fork:
        ask: บล็อกสุดท้ายที่ถูกตัดคืออะไร
        options:
          - id: text
            label: ข้อความ
            steps:
              - lane: loop
                at: step
                beat:
                  title: "ข้อความถูกตัด Geno จบ turn ทันที"
                  text: >-
                    ข้อความครึ่งเดียวไม่มีอะไรให้รัน Geno ไม่เรียก model ให้เขียนต่อ และจบ turn แบบ error
                  from: engine
                  to: engine
                do: >-
                  ไม่มี `tool_use` ค้าง ตาราง `AFTER_STOP` แปลง `max_tokens` เป็น `done(error)` ทันที
                  ไม่มีการเรียก model ซ้ำให้เขียนต่อ และ Stop hook ไม่ทำงานในทางนี้
                ref: packages/core/src/loop.ts#AFTER_STOP
                emits: [error]
                phase: ending
              - use: mstop-fails-quietly
                beat:
                  title: "เหตุผลไปอยู่แค่ใน output channel"
                  text: >-
                    Geno ไม่บันทึก error ลงบันทึกของ session เหตุผลถูกเขียนลง output channel "Geno engine" เท่านั้น
                    (ช่องในแผง Output ของ VS Code ที่รับข้อความ log ของ engine) แผงแชตรู้แค่ว่า turn ล้มเหลว
                  from: engine
                  to: panel

              - lane: panel
                at: rail
                beat:
                  title: "คำตอบค้างกลางประโยค"
                  text: >-
                    คำตอบหยุดกลางประโยค ท้าย turn ขึ้น Failed ไม่มีแถบ error และไม่มีปุ่ม Continue เพราะมีข้อความแล้ว คุณต้องเปิด
                    output channel จึงจะรู้ว่าทำไม
                  from: panel
                  to: you
                  end: "ข้อความถูกตัด turn ล้มเหลว"
                  sees: { kind: message, from: geno, text: package.json sets up three things. The first is, footer: [ failed after ..., Failed ] }
                do: >-
                  `headerOf` เปลี่ยนหัวข้อเป็น "failed after ..." `missingReply` เห็นข้อความหลังขั้นสุดท้าย
                  จึงไม่แสดงประกาศ Continue และ Retry คำตอบครึ่งเดียวค้างอยู่โดยไม่มีอะไรบอกว่าทำไม
                sees: >-
                  คำตอบที่หยุดกลางประโยค หัวข้อ "failed after ..." ท้าย turn ขึ้น "Failed" ไม่มีแถบ error และไม่มีปุ่ม Continue
                ref: packages/extension/src/chat/rail.ts#missingReply
                end: { turn: failed, reason: error }

          - id: tool
            label: การเรียก tool
            steps:
              - lane: loop
                at: step
                beat:
                  title: "Geno ไม่รัน tool call ที่ถูกตัด"
                  text: >-
                    tool call ที่ถูกตัดไม่ได้รัน ส่วน call อื่นที่ครบในคำตอบเดียวกันยังรันตามปกติก่อนเรียก model ครั้งถัดไป
                  from: engine
                  to: engine
                do: >-
                  `loopStep` เห็น `tool_use` ที่ยังไม่มีผล `unrunnable` คืนเฉพาะ call ที่ถูกตัดพร้อมข้อความ `UNRUN_TEXTS['cut-off']`
                  จึงตัดสิน `answer-tools` call อื่นที่ครบในคำตอบเดียวกัน (ถ้ามี) ยังรันตามปกติก่อนเรียก model ครั้งถัดไป
                ref: packages/core/src/loop.ts#unrunnable
                emits: [answer-tools]
                phase: running-tools
              - lane: loop
                at: drive
                beat:
                  title: "Geno เตรียมผลที่บอกให้เรียกให้เล็กลง"
                  text: >-
                    tool call ทุกตัวต้องมี `tool_result` คู่กัน Geno จึงเขียน `tool_result` แบบ error ให้ call ที่ถูกตัดลง log
                    ข้อความบอกว่าคำตอบชนเพดานจน call ถูกตัดและไม่ได้รัน ให้ทำต่อด้วย call ที่เล็กลง
                    ผลนี้ถึง model ตอนเรียกครั้งถัดไป
                  from: engine
                  to: engine
                do: >-
                  `drive` บอก watcher ว่าข้าม call นี้ แล้วบันทึก `tool-result` สถานะ error ที่บอก model ว่า
                  "Your response hit the output limit and cut this tool call short, so it did not run. Continue, and keep each tool call smaller."
                  tool ไม่ได้รัน
                ref: "packages/engine/src/drive.ts#\"watcher.toolSkipped?.(answer.use, describeCall(answer.use, mode.executors));\""
                emits: [tool-result]
              - lane: server
                at: updates
                do: >-
                  `watcher.toolSkipped` ส่ง `tool_call` สถานะ `pending` แล้วผลที่บันทึกตามไปเป็น `tool_call_update` สถานะ `failed`
                ref: "packages/engine/src/serve.ts#\"toolSkipped(use, title) {\""
                emits: [tool_call, pending, tool_call_update]
              - lane: panel
                at: rail
                beat:
                  title: "แชตขึ้นขั้น edit ที่ล้มเหลว แล้ว Geno ลองใหม่"
                  text: >-
                    ขั้นของ call ขึ้นแล้วล้มเหลวทันที ชื่อขั้นเป็นชื่อ tool เพราะ input อ่านไม่ครบ เพิ่งถูกตัดครั้งเดียว Geno
                    จึงเรียก model อีกรอบ
                  from: engine
                  to: panel
                  sees: { kind: step, label: edit, status: failed, output: "Your response hit the output limit and cut this tool call short, so it did not run. Continue, and keep each tool call smaller." }
                alongside: true
                do: >-
                  ขั้นของ call ขึ้นแล้วล้มเหลวทันที ชื่อขั้นมาจากชื่อ tool เพราะ input ที่ถูกตัดอ่านไม่ได้ครบ
                sees: ขั้น "edit" ขึ้นเครื่องหมายล้มเหลว เปิดดูแล้วเห็นข้อความ "Your response hit the output limit..."
                ref: packages/extension/src/chat/webview.ts#render
              - lane: loop
                at: step
                do: >-
                  `loopStep` เห็น `tool-result` ล่าสุดจึงได้ `call-model` และ `cutTwice` ยังไม่จริง เพราะเพิ่งถูกตัดครั้งเดียว
                  model จึงได้ลองอีกครั้ง
                ref: packages/core/src/loop.ts#cutTwice
                emits: [call-model]
                phase: calling-model
              - use: model-call
                beat:
                  title: "Geno ส่งผลนั้นให้ model"
                  text: >-
                    Geno ส่งบทสนทนาทั้งหมดอีกครั้ง ข้อความสุดท้ายคือ `tool_result` แบบ error ที่บอกให้เรียกให้เล็กลง
                    การ์ดข้างล่างมาจากการบันทึกเดียวกับการ์ดก่อน ดูข้อความที่ไฮไลต์ และ `is_error` ที่เป็น `true`
                  from: engine
                  to: model
                  sees:
                    kind: payload
                    source: packages/docs/src/data/recorded/max-tokens.jsonl#line=6
                    select: messages[4]
                    highlight: ['content[0].content', 'content[0].is_error']
              - lane: model
                beat:
                  title: "Model ตอบใหม่"
                  text: >-
                    model อ่านผลที่บอกว่า call ถูกตัด แล้วตอบอีกครั้ง ลองเลือกว่ารอบนี้ถูกตัดอีกไหม
                    การ์ดข้างล่างมาจากการบันทึกเดียวกัน ในการบันทึกนั้น model เริ่มคำตอบด้วยข้อความว่าจะเขียนไฟล์ส่วนแรกก่อน
                  from: model
                  to: engine
                  sees:
                    kind: payload
                    source: packages/docs/src/data/recorded/max-tokens.jsonl#line=7
                    select: '[2]'
                    highlight: [data.delta.text]
                  ask: "ถูกตัดอีกไหม"
                do: >-
                  model อ่านผลที่บอกว่า call ถูกตัด แล้วตอบใหม่
                ref: "packages/engine/src/gateway.ts#\"stopReason: message.stop_reason,\""
                fork:
                  ask: คำตอบใหม่ถูกตัดที่การเรียก tool อีกไหม
                  options:
                    - id: smaller
                      label: ไม่ เรียกเล็กลงแล้ว
                      steps:
                        - lane: model
                          beat:
                            title: "Model แบ่ง tool call ให้เล็กลง"
                            text: >-
                              model แบ่งงาน เช่นสร้างไฟล์ส่วนแรกก่อน แล้วจบด้วย `stop_reason` เป็น `tool_use` ตามปกติ Geno รัน tool และ turn ทำต่อ
                              การ์ดมาจากการบันทึกเดียวกัน แท็บแรกและสองคือ input ของ `edit` รอบนี้ที่มาสองชิ้นจนครบ ไฟล์มีแค่สองกรณี
                              แท็บสามคือท้าย stream ที่ `stop_reason` เป็น `tool_use`
                            from: model
                            to: engine
                            sees:
                              - kind: payload
                                source: packages/docs/src/data/recorded/max-tokens.jsonl#line=7
                                select: '[5]'
                                highlight: [data.delta.partial_json]
                              - kind: payload
                                source: packages/docs/src/data/recorded/max-tokens.jsonl#line=7
                                select: '[6]'
                                highlight: [data.delta.partial_json]
                              - kind: payload
                                source: packages/docs/src/data/recorded/max-tokens.jsonl#line=7
                                select: '[-2]'
                                highlight: [data.delta.stop_reason]
                            end: "เรียกเล็กลง turn ทำต่อ"
                          do: >-
                            model แบ่งงานเป็น call ที่เล็กลง เช่นสร้างไฟล์ส่วนแรกก่อน แล้วจบด้วย `stop_reason: tool_use` ตามปกติ
                          ref: "packages/engine/src/gateway.ts#\"stopReason: message.stop_reason,\""
                          emits: [tool_use]
                        - lane: loop
                          at: step
                          do: >-
                            `loopStep` เห็น `tool_use` ที่ครบและไม่มี call ที่ต้องตอบโดยไม่รัน จึงตัดสิน `run-tools` turn ทำงานต่อตามปกติ
                          ref: packages/core/src/loop.ts#loopStep
                          emits: [run-tools]
                          phase: running-tools
                          end: { turn: continues, reason: run-tools }
                    - id: cut-again
                      label: ถูกตัดอีก
                      steps:
                        - lane: loop
                          at: tools
                          beat:
                            title: "ถูกตัดอีก Geno เลิกลอง"
                            text: >-
                              call ที่ถูกตัดครั้งที่สองได้คำตอบแบบเดียวกัน และอีกขั้นในแชตล้มเหลว คำตอบสองครั้งล่าสุดถูกตัดที่ tool call
                              ทั้งคู่ Geno จึงจบ turn แบบ error แทนที่จะเสียรอบไปกับการถูกตัดซ้ำ เหตุผลไปอยู่ใน output channel เท่านั้น
                            from: engine
                            to: engine
                          do: >-
                            call ที่ถูกตัดครั้งที่สองได้คำตอบ `cut-off` แบบเดียวกัน ขั้นของมันในแผงล้มเหลวอีกขั้น
                          ref: "packages/engine/src/drive.ts#\"watcher.toolSkipped?.(answer.use, describeCall(answer.use, mode.executors));\""
                          emits: [tool-result]
                          phase: running-tools
                        - lane: loop
                          at: step
                          do: >-
                            `loopStep` จะได้ `call-model` แต่ `cutTwice` เห็นว่าคำตอบสองครั้งล่าสุดของรอบนี้ถูกตัดที่การเรียก tool ทั้งคู่
                            จึงจบด้วย `done(error)` แทนที่จะเสียรอบไปกับการถูกตัดซ้ำ
                          ref: packages/core/src/loop.ts#cutTwice
                          emits: [error]
                          phase: ending
                        - use: mstop-fails-quietly
                        - lane: panel
                          at: rail
                          beat:
                            title: "แชตขึ้นว่า Geno หยุดโดยไม่มีคำตอบ"
                            text: >-
                              ขั้นสุดท้ายล้มเหลวและไม่มีข้อความตามหลัง แผงจึงบอกว่าคำตอบสุดท้ายไม่มีข้อความ พร้อมปุ่มทำต่อหรือลองใหม่
                            from: panel
                            to: you
                            end: "ถูกตัดสองครั้ง turn ล้มเหลว"
                            sees: { kind: notice, text: Geno stopped without a reply, detail: Its last reply had no text., actions: [ Continue, Retry ], tone: warning }
                          do: >-
                            ขั้นสุดท้ายล้มเหลวและไม่มีข้อความตามหลัง ไม่มีแถบ error และไม่ได้ถูกหยุดหรือปฏิเสธ
                            `missingReply` จึงให้เหตุผลว่าคำตอบสุดท้ายไม่มีข้อความ
                          sees: >-
                            หัวข้อ "failed after ..." กล่อง "Geno stopped without a reply · Its last reply had no text."
                            พร้อมปุ่ม [Continue] [Retry] และท้าย turn ขึ้น "Failed"
                          ref: packages/extension/src/chat/rail.ts#missingReply
                          end: { turn: failed, reason: error }
---

[`max_tokens`](/start/glossary/) คือเพดานความยาวของคำตอบหนึ่งครั้ง `buildRequest` ตั้งค่านี้เป็นค่าที่น้อยกว่าระหว่างเพดาน output ของ model
กับที่ว่างที่เหลือในหน้าต่าง context (`maxTokensFor`) เพดานลดได้เฉพาะบน model ที่หน้าต่างเล็กเมื่อเทียบกับเพดาน output
เช่น `claude-haiku-4-5` (หน้าต่าง 200,000 เพดาน 64,000 [สรุปบริบท](/scenarios/ctx/compaction-auto/)ที่ 160,000)
บน qwen3.8-flash ซึ่งเป็นค่าตั้งต้น Geno สรุปบริบทที่ 200,000 จากหน้าต่าง 1,000,000 จึงยังว่างราว 800,000 เพดานคงที่ 131,072
ที่นั่นคำตอบถูกตัดก็ต่อเมื่อคำตอบเดียวยาวเกิน 131,072 token

| บล็อกที่ถูกตัด | Geno ทำอะไร | turn |
| --- | --- | --- |
| ข้อความ | จบทันที | `failed` ข้อความครึ่งเดียวค้างในแผง |
| การเรียก tool ครั้งแรก | ไม่รัน call นั้น บอก model ให้เรียกใหม่ให้เล็กลง | ทำต่อ |
| การเรียก tool สองครั้งติด | ไม่รัน แล้วจบ | `failed` พร้อมปุ่ม Continue และ Retry |

สิ่งที่ควรสังเกต

- **ทางของข้อความไม่บอกผู้ใช้ว่าเกิดอะไร** `finish` เขียนเหตุผลลง stderr ของ engine อย่างเดียว ไม่มี event `error`
  แผงเห็นแค่ `failed` และเพราะมีข้อความแล้ว `missingReply` จึงไม่แสดงประกาศ Continue และ Retry ด้วย
  ผู้ใช้เห็นคำตอบที่หยุดกลางประโยคกับคำว่า "Failed" โดยไม่มีเหตุผล ต้องเปิด output channel "Geno engine" จึงจะเห็น
  "error: the model stopped with max_tokens"
- **`STOP_MESSAGES.max_tokens` ของ extension ไม่เคยถูกใช้กับ loop ของ Geno** เพราะ [ACP](/start/glossary/) (โปรโตคอลระหว่าง VS Code กับ engine) ได้ `stopReason: end_turn` เสมอเมื่อ turn จบด้วย error
- **การถูกตัดนับเป็นการเรียก model หนึ่งครั้ง** การลองใหม่หลัง `cut-off` ใช้ขีดจำกัด 40 ครั้งของรอบเหมือนการเรียกอื่น

ปุ่ม Continue และ Retry ทำอะไรต่อ ดู [Turn จบโดยไม่มีคำตอบ แล้วคุณกด Continue หรือ Retry](/scenarios/mstop/no-reply-continue-retry/)
