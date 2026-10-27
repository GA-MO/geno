---
title: "Turn ครบ 40 ครั้งของการเรียก model หรือเกินงบ $0.40"
description: รอบการทำงานหนึ่งรอบใกล้ขีดจำกัด Geno ปิด tool ในการเรียกครั้งสุดท้ายให้ model เขียนรายงาน ถ้าไม่ได้รายงานหรือค่าใช้จ่ายเลยงบ turn จบแบบ failed
scenario:
  surface: vscode
  given:
    - ผู้ใช้ส่งข้อความในแผงแชตของ VS Code และ turn ทำงานมานาน เรียก model ไปแล้ว 39 ครั้ง
    - engine ใช้ขีดจำกัดตั้งต้นของ `gcode serve` คือ 40 ครั้งและ $0.40 ต่อ prompt ที่ผู้ใช้พิมพ์
    - ผลของ tool ชุดล่าสุดเพิ่งถูกบันทึกลง log
  trigger: >-
    `loopStep` อ่าน log หลังผลของ tool และต้องตัดสินว่าจะเรียก model อีกหรือไม่
  covers: [mstop.limit-max-turns, mstop.limit-budget]
  related: [mstop.no-reply-continue-retry, mstop.empty-answer-nudged, turn.with-tools]
  steps:
    - id: decide
      lane: loop
      at: step
      beat:
        title: "Geno นับรอบและค่าใช้จ่ายของ turn"
        text: >-
          turn นี้เรียก model ไปแล้ว 39 ครั้ง ก่อนเรียกอีก Geno นับจำนวนครั้งและค่าใช้จ่ายของ turn แล้วเทียบกับขีดจำกัด
          ก่อนหน้านี้ตอนเหลือไม่เกิน 20% (เหลือ 8 ครั้งจาก 40) Geno เตือน model ล่วงหน้าแล้วหนึ่งครั้ง
          การ์ดข้างล่างเป็นข้อความ user สุดท้ายของคำขอจริง จากการรันที่ตั้งขีดจำกัดไว้ 6 ครั้งและ $0.20
          จึงเห็นตัวเลขต่างจาก 40 ครั้งและ $0.40 ในการรันนั้น 20% คือเหลือ 1 ครั้ง บล็อกที่ไฮไลต์คือคำเตือนนั้น
          ขึ้นต้นด้วย `[Geno]` และบอกว่าเหลือการเรียกกี่ครั้งและเงินเท่าไร คุณไม่เห็นคำเตือนนี้ในแชต
        from: engine
        to: engine
        ask: "ขีดจำกัดไหนมาก่อน"
        sees:
          kind: payload
          source: docs/results/real-usecases/runs/A17-budget-reminder/1/requests.jsonl#seq=20
          select: messages[-1].content
          highlight:
            - "[-1]"
          collapse:
            - "[0].content"
      do: >-
        `loopStep` นับการเรียก model และค่าใช้จ่ายของรอบนี้ (รวมค่าสรุปบริบทและค่า Auto classifier) แล้วเทียบกับขีดจำกัด
      ref: packages/core/src/loop.ts#limitReached
      phase: calling-model
      fork:
        ask: ขีดจำกัดไหนมาถึงก่อน
        options:
          - id: calls
            label: เหลือการเรียกครั้งเดียว
            then: capped
            steps:
              - lane: loop
                at: step
                beat:
                  title: "เหลือการเรียกได้อีกครั้งเดียว"
                  text: >-
                    ใช้ไป 39 ครั้ง ยังไม่ถึง 40 Geno จึงเรียก model ได้อีกครั้ง
                  from: engine
                  to: engine
                do: >-
                  ใช้ไป 39 ครั้ง ยังไม่ถึง 40 `loopStep` จึงตัดสิน `call-model`
                ref: packages/core/src/loop.ts#loopStep
                emits: [call-model]
              - lane: loop
                at: drive
                beat:
                  title: "Geno เตรียมโน้ตครั้งสุดท้ายให้ model"
                  text: >-
                    Geno รู้ว่าการเรียกนี้เป็นครั้งสุดท้ายที่ขีดจำกัดยอม จึงบันทึกโน้ตบอก model ว่า tool ถูกปิดแล้ว
                    ให้เขียนรายงานเลย โน้ตนี้ไม่ขึ้นในแชต และถึง model ในคำขอถัดไป
                  from: engine
                  to: engine
                do: >-
                  `deliver()` เห็นจาก `lastCallDue` ว่าการเรียกนี้เป็นครั้งสุดท้ายที่ขีดจำกัดยอม จึงบันทึก `notice` ที่มี `last: true`
                  model จะอ่าน `LAST_CALL_NOTE` ว่า tool ถูกปิดและให้เขียนรายงานเลย ประกาศนี้ไม่แสดงในแผง
                ref: packages/core/src/loop.ts#lastCallDue
                emits: [notice]
              - lane: loop
                at: model-call
                beat:
                  title: "Geno ส่งคำขอโดยปิด tool"
                  text: >-
                    รายชื่อ tool ยังอยู่ในคำขอ เพราะ prompt cache (ผู้ให้บริการจำส่วนต้นของคำขอที่เหมือนครั้งก่อน จึงอ่านเร็วและถูกกว่า)
                    ใช้ได้เฉพาะเมื่อส่วนต้นไม่เปลี่ยน แต่คำขอสั่งว่าห้ามเรียก tool การ์ดข้างล่างเป็นคำขอจริงจากการรันแบบเดียวกับการ์ดแรก
                    (ขีดจำกัด 6 ครั้ง) การ์ดแรกให้ดู `tool_choice` ที่เป็น `none` การ์ดที่สองคือข้อความสุดท้าย
                    สองบล็อกที่ไฮไลต์คือคำเตือนว่าใกล้ขีดจำกัด และโน้ตว่านี่คือการเรียกครั้งสุดท้าย ให้เขียนรายงานเลย
                  from: engine
                  to: model
                  sees:
                    - kind: payload
                      source: docs/results/real-usecases/runs/A17-budget-reminder/fix-a2/wire.jsonl#line=11
                      collapse: [system, tools, messages]
                      highlight: [tool_choice]
                    - kind: payload
                      source: docs/results/real-usecases/runs/A17-budget-reminder/fix-a2/wire.jsonl#line=11
                      select: messages[-1].content
                      collapse: ['[0].content', '[1].content']
                      highlight: ['[2].text', '[3].text']
                do: >-
                  `callModel` บันทึก `checkpoint` แล้วส่งคำขอพร้อม `toolsOff` tool ยังอยู่ในคำขอเพื่อให้ cache ไม่หลุด
                  แต่ `tool_choice` เป็น `none` model จึงเรียก tool ไม่ได้
                ref: "packages/engine/src/drive.ts#\"{ toolsOff: true }\""
                emits: [checkpoint]
              - lane: model
                beat:
                  title: "Model ตอบโดยเรียก tool ไม่ได้"
                  text: >-
                    model อ่านโน้ตแล้วตอบ ลองเลือกว่ามันเขียนรายงานออกมาหรือไม่ การ์ดข้างล่างเป็นคำตอบจริงต่อคำขอก่อนหน้า (จากการรันที่ตั้งขีดจำกัด 6 ครั้ง)
                    บล็อก `text` ที่ไฮไลต์คือรายงาน ในรันสั้นนั้น model เขียนว่ายังไม่ได้แก้ไฟล์ไหน แล้วจบด้วย `stop_reason` เป็น `end_turn`
                    (field ท้ายคำตอบที่บอกว่าหยุดเพราะอะไร `end_turn` คือตอบจบแล้ว)
                  from: model
                  to: engine
                  sees:
                    kind: payload
                    source: docs/results/real-usecases/runs/A17-budget-reminder/fix-a2/session.jsonl#seq=21
                    select: content
                    collapse: ['[0].thinking']
                    highlight: ['[1].text']
                  ask: "เขียนรายงานไหม"
                do: >-
                  model ตอบโดยไม่มี tool ให้เรียก
                ref: "packages/engine/src/gateway.ts#\"stopReason: message.stop_reason,\""
                fork:
                  ask: model เขียนรายงานออกมาหรือไม่
                  options:
                    - id: report
                      label: เขียนรายงาน
                      steps:
                        - use: answer-streams
                          beat:
                            title: "รายงานขึ้นในแชต"
                            text: >-
                              model สรุปว่าทำอะไรไปแล้วและเหลืออะไร ข้อความค่อยๆ ขึ้นในแชต ข้อความข้างล่างคือต้นรายงานในรันจริงของการ์ดก่อน
                            from: engine
                            to: panel
                            sees: { kind: message, from: geno, text: "I did not get to make the edits — the run hit its limits before I could modify any files. Nothing in the repo was changed.", streaming: true }

                        - use: turn-ends
                          beat:
                            title: "Turn จบตามปกติ"
                            text: >-
                              model จบด้วย end_turn Geno จึงจบ turn แบบ done คุณเห็นรายงานโดยไม่มีแถบเตือนขีดจำกัด
                            from: engine
                            to: panel
                            end: "ได้รายงาน turn จบ"
                            sees: { kind: composer, state: idle }

                    - id: nothing
                      label: ไม่มีข้อความ
                      steps:
                        - lane: loop
                          at: step
                          beat:
                            title: "ไม่มีข้อความ Geno ไม่กระตุ้น"
                            text: >-
                              คำตอบไม่มีข้อความ ปกติ Geno จะกระตุ้น model หนึ่งครั้ง คือต่อข้อความบอกให้ทำต่อแล้วเรียกอีกรอบ
                              แต่ครบ 40 ครั้งแล้ว จึงจบที่ขีดจำกัดก่อน
                            from: engine
                            to: engine
                          do: >-
                            คำตอบไม่มีข้อความ ปกติ `loopStep` จะกระตุ้นหนึ่งครั้ง แต่ครบ 40 ครั้งแล้ว `limitReached` จึงได้ `done(max-turns)` ก่อน
                          ref: packages/core/src/loop.ts#loopStep
                          emits: [max-turns]
                          phase: ending
          - id: cost
            label: ค่าใช้จ่ายเลย $0.40
            then: capped
            steps:
              - lane: loop
                at: step
                beat:
                  title: "ค่าใช้จ่ายเลยงบไปแล้ว"
                  text: >-
                    Geno ใช้ค่าใช้จ่ายเฉลี่ยต่อครั้งทำนายว่าครั้งไหนเป็นครั้งสุดท้าย การเรียกครั้งก่อนแพงกว่าค่าเฉลี่ยมาก
                    Geno จึงไม่รู้ล่วงหน้าและไม่ได้ส่งโน้ตครั้งสุดท้าย ตอนนี้ค่าใช้จ่ายเลย $0.40 แล้ว Geno
                    ไม่เรียก model อีก แม้แต่ครั้งสุดท้ายแบบปิด tool
                  from: engine
                  to: engine
                do: >-
                  การเรียกครั้งก่อนแพงกว่าค่าเฉลี่ยมาก `lastCallDue` จึงไม่ได้ทำนายว่าเป็นครั้งสุดท้ายและไม่ได้บันทึกโน้ต `last: true` และตอนนี้ค่าใช้จ่ายของรอบเลย $0.40 ไปแล้ว
                  `loopStep` จึงได้ `done(budget)` แทน `call-model` ไม่มีการเรียกครั้งสุดท้ายแบบปิด tool
                ref: packages/core/src/loop.ts#limitReached
                emits: [budget]
                phase: ending

    - id: capped
      lane: loop
      at: drive
      beat:
        title: "Geno บันทึกว่าชนขีดจำกัด"
        text: >-
          Geno บันทึก error ที่บอกว่าหยุดที่ขีดจำกัดไหน แล้วส่งไปที่แชตพร้อมชนิดของขีดจำกัด
        from: engine
        to: panel
      do: >-
        `finish` เห็นว่ารอบจบที่ขีดจำกัดแต่ยังไม่มี error ของขีดจำกัดนั้น จึงบันทึก event `error` ด้วยข้อความจาก `LIMIT_MESSAGES`
        เช่น "stopped after 40 model calls (--max-turns 40)" หรือ "stopped at an estimated $0.412345, past --max-cost 0.4"
      ref: packages/engine/src/drive.ts#LIMIT_MESSAGES
      emits: [error]

    - id: error-update
      lane: server
      at: updates
      do: >-
        `errorUpdate` ส่ง error เป็น `agent_message_chunk` พร้อม `TURN_ERROR_META`
      ref: packages/engine/src/session-replay.ts#errorUpdate
      emits: [agent_message_chunk, TURN_ERROR_META]

    - id: error-action
      lane: editor
      at: chat
      alongside: true
      do: >-
        `agentChunkAction` แปลงเป็น action `error` ที่ระบุชนิดของขีดจำกัด
      ref: packages/extension/src/chat/compact-host.ts#agentChunkAction

    - id: limit-block
      lane: panel
      at: rail
      beat:
        title: "แชตขึ้นแถบเตือนสีเหลือง"
        text: >-
          แผงวาดขีดจำกัดเป็นคำเตือนสีเหลือง ไม่ใช่ error สีแดง และแปลข้อความของ engine (`--max-turns 40` หรือ `--max-cost`) เป็นคำธรรมดา
          engine บอก VS Code ว่า turn จบแบบ failed การ์ดเป็นทางจำนวนครั้ง ทางค่าใช้จ่ายขึ้นว่า `Reached the cost limit ($0.4)`
        from: panel
        to: you
        sees: { kind: notice, text: Reached the turn limit (40), tone: warning }
      alongside: true
      do: >-
        `errorBlock` วาดขีดจำกัดเป็นคำเตือนสีเหลือง ไม่ใช่ error สีแดง และแปลชื่อ flag เป็นคำธรรมดา
      sees: >-
        แถบเตือน "Reached the turn limit (40)" หรือ "Reached the cost limit ($0.4)" ตัวเลข $0.4 เป็นของ qwen3.8-flash
        ถ้าไม่ได้ตั้ง `--max-cost` Geno ปรับงบตามราคาของ model ที่ใช้ ถ้าตั้งเอง แถบแสดงตัวเลขที่ตั้งไว้ตรงๆ
      ref: packages/extension/src/chat/render.ts#errorBlock

    - id: response
      lane: server
      at: turns
      do: >-
        `runTurn` แปลงผลด้วย `TURN_ENDS` ทั้งสองขีดจำกัดได้ `stopReason: max_turn_requests` เพราะ ACP ไม่มี stop reason ของงบ
        meta บอกว่างานจบแบบ `failed`
      ref: packages/engine/src/serve.ts#TURN_ENDS
      emits: [max_turn_requests, TURN_END_META]

    - id: turn-end
      lane: editor
      at: chat
      do: >-
        `prompt()` ใช้ `turnEndOf` อ่านได้ `failed` บล็อก error ของ engine บอกเหตุผลไว้แล้ว ข้อความสำรองใน `STOP_MESSAGES` จึงไม่ถูกเพิ่ม
        แล้วส่ง action `turn-end` สถานะ `failed`
      ref: "packages/extension/src/chat/chat.ts#\"const status = turnEndOf(response);\""
      emits: [turn-end]

    - id: notice
      lane: panel
      at: rail
      beat:
        title: "แชตขึ้นปุ่ม Continue และ Retry"
        text: >-
          แถบขีดจำกัดเป็นขั้นสุดท้ายของ turn แผงจึงขึ้นประกาศว่า Geno หยุดโดยไม่มีคำตอบ พร้อมปุ่ม Continue และ Retry
          ทั้งสองปุ่มเริ่ม turn ใหม่ที่ได้ขีดจำกัดเต็มอีกชุด คำขอยังมีบทสนทนาเดิมทั้งหมด รวม prompt เดิมและงานที่ทำไปแล้ว model จึงทำต่อจากที่ค้างได้
        from: panel
        to: you
        end: "ชนขีดจำกัด turn ล้มเหลว"
        sees: { kind: notice, text: Geno stopped without a reply, detail: It reached its limit before it answered., actions: [ Continue, Retry ], tone: warning }
      do: >-
        `missingReply` เห็นบล็อกขีดจำกัดเป็นขั้นสุดท้ายของ turn จึงแสดงประกาศพร้อมปุ่ม Continue และ Retry
        ข้อความที่ model เขียนก่อนบล็อกนั้นไม่ทำให้ประกาศหายไป เพราะมันอยู่ก่อนขั้นสุดท้าย
      sees: >-
        หัวข้อ "failed after ..." กล่อง "Geno stopped without a reply · It reached its limit before it answered."
        ปุ่ม [Continue] [Retry] และท้าย turn ขึ้น "Failed"
      ref: packages/extension/src/chat/rail.ts#missingReply
      end: { turn: failed, reason: max_turn_requests }
---

ขีดจำกัดของรอบ ([งบ](/start/glossary/)) มีไว้กันไม่ให้ [turn](/start/glossary/) เดียวเรียก model หรือใช้เงินไม่สิ้นสุด
ค่าตั้งต้นของ `gcode serve` คือ 40 ครั้ง (`--max-turns 40`) และ $0.40 ตามราคาของ qwen3.8-flash
ถ้าใช้ model อื่น Geno ปรับงบตามราคาของ model นั้น (ตั้งเองได้ด้วย `--max-cost`) ส่วนขยายไม่ส่งค่าอื่นมา
model ระดับ principles เช่น Claude Sonnet 5.5 และ Opus 5.5 ได้ห้าเท่าของทั้งสองค่า คือ 200 ครั้ง และงบห้าเท่า เพราะ Claude Code ไม่จำกัดเลย และงานจริงของ model เหล่านี้เรียกเกิน 40 ครั้งบ่อย

| เหตุ | สิ่งที่ Geno ทำ | turn จบแบบ |
| --- | --- | --- |
| เหลือการเรียกครั้งเดียว และ model เขียนรายงาน | เรียกครั้งสุดท้ายโดยปิด tool | `done (end_turn)` |
| เหลือการเรียกครั้งเดียว แต่ model ไม่เขียนอะไร | ไม่กระตุ้น | `failed` / `max-turns` |
| ค่าใช้จ่ายเลยงบก่อนจะรู้ว่าเป็นครั้งสุดท้าย | ไม่เรียก model อีก | `failed` / `budget` |

สิ่งที่ควรสังเกต

- **รอบที่ชนขีดจำกัดอาจจบแบบ done** เมื่อการเรียกครั้งที่ 40 ปิด tool model ที่เขียนรายงานจบด้วย `end_turn` ตามปกติ
  `loopStep` จึงให้ `done(end_turn)` ไม่ใช่ `max-turns` ผู้ใช้เห็นรายงานโดยไม่มีแถบเตือนขีดจำกัด
- **เตือนล่วงหน้าเมื่อเหลือไม่เกิน 20%** ก่อนการเรียกที่เหลือจำนวนครั้งหรืองบไม่เกิน 20% `deliver()` บันทึก `notice` ที่บอก model ว่าเหลือเท่าไร
  ครั้งเดียวต่อรอบ ผู้ใช้ไม่เห็นประกาศนี้
- **Continue ได้ขีดจำกัดใหม่** Continue และ Retry ส่ง prompt ใหม่ `drive` เริ่มนับรอบใหม่จาก prompt นั้น
  บทสนทนาเดิมทั้งหมดยังอยู่ในคำขอ เพราะ error ของขีดจำกัดไม่ตัดอะไรออกจากบทสนทนา (ต่างจาก refusal ที่ตัดสิ่งที่ยังรอคำตอบทิ้ง)
- **ประกาศแสดงเสมอเมื่อมีแถบขีดจำกัด** `missingReply` มองหาข้อความหลังขั้นสุดท้าย และแถบขีดจำกัดก็นับเป็นขั้น
  ข้อความใดๆ ที่ model เขียนก่อนชนขีดจำกัดจึงไม่ทำให้ประกาศ "It reached its limit before it answered." หายไป

ปุ่ม Continue และ Retry ทำอะไรต่อ ดู [Turn จบโดยไม่มีคำตอบ แล้วคุณกด Continue หรือ Retry](/scenarios/mstop/no-reply-continue-retry/)
