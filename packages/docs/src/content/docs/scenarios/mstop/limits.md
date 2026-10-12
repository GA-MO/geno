---
title: "Turn ครบ 40 ครั้งของการเรียก model หรือเกินงบ $0.40"
description: รอบการทำงานหนึ่งรอบใกล้ขีดจำกัด Geno ปิดเครื่องมือในการเรียกครั้งสุดท้ายให้โมเดลเขียนรายงาน ถ้าไม่ได้รายงานหรือค่าใช้จ่ายเลยงบ turn จบแบบ failed
tableOfContents: false
sidebar:
  order: 3
scenario:
  surface: vscode
  given:
    - ผู้ใช้ส่งข้อความในแผงแชตของ VS Code และ turn ทำงานมานาน เรียกโมเดลไปแล้ว 39 ครั้ง
    - engine ใช้ขีดจำกัดตั้งต้นของ `gcode serve` คือ 40 ครั้งและ $0.40 ต่อ prompt ที่ผู้ใช้พิมพ์
    - ผลของเครื่องมือชุดล่าสุดเพิ่งถูกบันทึกลง log
  trigger: >-
    `loopStep` อ่าน log หลังผลของเครื่องมือ และต้องตัดสินว่าจะเรียกโมเดลอีกหรือไม่
  covers: [mstop.limit-max-turns, mstop.limit-budget]
  related: [mstop.no-reply-continue-retry, mstop.empty-answer-nudged, turn.with-tools]
  steps:
    - id: decide
      lane: loop
      at: step
      beat:
        title: "Geno นับรอบและค่าใช้จ่ายของ turn"
        text: >-
          turn นี้เรียกโมเดลไปแล้ว 39 ครั้ง ก่อนเรียกอีก Geno นับจำนวนครั้งและค่าใช้จ่ายของ turn แล้วเทียบกับขีดจำกัด
          ก่อนหน้านี้ตอนเหลือไม่ถึง 20% Geno เตือนโมเดลล่วงหน้าแล้ว แบบในคำขอจาก run จริงด้านล่าง
        ask: "ขีดจำกัดไหนมาก่อน"
        sees:
          kind: payload
          direction: request
          source: docs/results/real-usecases/runs/A17-budget-reminder/1/requests.jsonl#seq=20
          select: messages[-1].content
          highlight:
            - "[-1]"
          collapse:
            - "[0].content"
      do: >-
        `loopStep` นับการเรียกโมเดลและค่าใช้จ่ายของรอบนี้ (รวมค่าสรุปบริบทและค่า Auto classifier) แล้วเทียบกับขีดจำกัด
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
                    ใช้ไป 39 ครั้ง ยังไม่ถึง 40 Geno จึงเรียกโมเดลได้อีกครั้ง
                do: >-
                  ใช้ไป 39 ครั้ง ยังไม่ถึง 40 `loopStep` จึงตัดสิน `call-model`
                ref: packages/core/src/loop.ts#loopStep
                emits: [call-model]
              - lane: loop
                at: drive
                beat:
                  title: "Geno บอก model ว่านี่คือครั้งสุดท้าย"
                  text: >-
                    Geno รู้ว่าการเรียกนี้เป็นครั้งสุดท้ายที่ขีดจำกัดยอม จึงบันทึกโน้ตบอกโมเดลว่า tool ถูกปิดแล้ว
                    ให้เขียนรายงานเลย โน้ตนี้ไม่ขึ้นในแชต
                do: >-
                  `deliver()` เห็นจาก `lastCallDue` ว่าการเรียกนี้เป็นครั้งสุดท้ายที่ขีดจำกัดยอม จึงบันทึก `notice` ที่มี `last: true`
                  โมเดลจะอ่าน `LAST_CALL_NOTE` ว่าเครื่องมือถูกปิดและให้เขียนรายงานเลย ประกาศนี้ไม่แสดงในแผง
                ref: packages/core/src/loop.ts#lastCallDue
                emits: [notice]
              - lane: loop
                at: model-call
                beat:
                  title: "Geno ส่งคำขอโดยปิด tool"
                  text: >-
                    รายชื่อ tool ยังอยู่ในคำขอเพื่อให้ prompt cache ไม่หลุด แต่คำขอสั่งว่าห้ามเรียก tool
                  to: model
                do: >-
                  `callModel` บันทึก `checkpoint` แล้วส่งคำขอพร้อม `toolsOff` เครื่องมือยังอยู่ในคำขอเพื่อให้ cache ไม่หลุด
                  แต่ `tool_choice` เป็น `none` โมเดลจึงเรียกเครื่องมือไม่ได้
                ref: "packages/engine/src/drive.ts#\"{ toolsOff: true }\""
                emits: [checkpoint]
              - lane: model
                beat:
                  title: "Model ตอบโดยเรียก tool ไม่ได้"
                  text: >-
                    โมเดลอ่านโน้ตแล้วตอบ ลองเลือกว่ามันเขียนรายงานออกมาหรือไม่
                  ask: "เขียนรายงานไหม"
                do: >-
                  โมเดลตอบโดยไม่มีเครื่องมือให้เรียก
                ref: "packages/engine/src/gateway.ts#\"stopReason: message.stop_reason,\""
                fork:
                  ask: โมเดลเขียนรายงานออกมาหรือไม่
                  options:
                    - id: report
                      label: เขียนรายงาน
                      steps:
                        - use: answer-streams
                          beat:
                            title: "รายงานขึ้นในแชต"
                            text: >-
                              โมเดลสรุปว่าทำอะไรไปแล้วและเหลืออะไร ข้อความค่อยๆ ขึ้นในแชต
                            from: engine
                            to: panel
                            sees: { kind: message, from: geno, text: แก้ไปแล้ว 12 ไฟล์ เหลืออีก 6 ไฟล์ใน src/shop, streaming: true }

                        - use: turn-ends
                          beat:
                            title: "Turn จบตามปกติ"
                            text: >-
                              โมเดลจบด้วย end_turn Geno จึงจบ turn แบบ done คุณเห็นรายงานโดยไม่มีแถบเตือนขีดจำกัด
                            to: panel
                            end: "ได้รายงาน turn จบ"
                            sees: { kind: composer, state: idle }

                    - id: nothing
                      label: ไม่มีข้อความ
                      steps:
                        - lane: loop
                          at: step
                          beat:
                            title: "ไม่มีข้อความ Geno ไม่กระตุ้นซ้ำ"
                            text: >-
                              คำตอบไม่มีข้อความ ปกติ Geno จะกระตุ้นโมเดลหนึ่งครั้ง แต่ครบ 40 ครั้งแล้ว จึงจบที่ขีดจำกัดก่อน
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
                    การเรียกครั้งก่อนแพงกว่าค่าเฉลี่ยมาก Geno จึงไม่ได้เตือนล่วงหน้า และตอนนี้ค่าใช้จ่ายเลย $0.40 แล้ว Geno
                    ไม่เรียกโมเดลอีก แม้แต่ครั้งสุดท้ายแบบปิด tool
                do: >-
                  การเรียกครั้งก่อนแพงกว่าค่าเฉลี่ยมาก `lastCallDue` จึงไม่ได้เตือนล่วงหน้า และตอนนี้ค่าใช้จ่ายของรอบเลย $0.40 ไปแล้ว
                  `loopStep` จึงได้ `done(budget)` แทน `call-model` ไม่มีการเรียกครั้งสุดท้ายแบบปิดเครื่องมือ
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
          แผงวาดขีดจำกัดเป็นคำเตือนสีเหลือง ไม่ใช่ error สีแดง และแปลชื่อ flag เป็นคำธรรมดา engine บอก VS Code ว่า turn
          จบแบบ failed
        sees: { kind: notice, text: Reached the turn limit (40), tone: warning }
      alongside: true
      do: >-
        `errorBlock` วาดขีดจำกัดเป็นคำเตือนสีเหลือง ไม่ใช่ error สีแดง และแปลชื่อ flag เป็นคำธรรมดา
      sees: >-
        แถบเตือน "Reached the turn limit (40)" หรือ "Reached the cost limit ($0.4)"
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
          แถบขีดจำกัดเป็นขั้นสุดท้ายของ turn แผงจึงขึ้นประกาศพร้อมปุ่ม Continue ได้ขีดจำกัดชุดใหม่เต็ม และ prompt
          เดิมยังอยู่ในคำขอ
        end: "ชนขีดจำกัด turn ล้มเหลว"
        sees: { kind: notice, text: Geno stopped without a reply, detail: It reached its limit before it answered., actions: [ Continue, Retry ], tone: warning }
      do: >-
        `missingReply` เห็นบล็อกขีดจำกัดเป็นขั้นสุดท้ายของ turn จึงแสดงประกาศพร้อมปุ่ม Continue และ Retry
        ข้อความที่โมเดลเขียนก่อนบล็อกนั้นไม่ทำให้ประกาศหายไป เพราะมันอยู่ก่อนขั้นสุดท้าย
      sees: >-
        หัวข้อ "failed after 3m 12s" กล่อง "Geno stopped without a reply · It reached its limit before it answered."
        ปุ่ม [Continue] [Retry] และท้าย turn ขึ้น "Failed"
      ref: packages/extension/src/chat/rail.ts#missingReply
      end: { turn: failed, reason: max_turn_requests }
---

ขีดจำกัดของรอบมีไว้กันไม่ให้ turn เดียวเรียกโมเดลหรือใช้เงินไม่สิ้นสุด
ตัวเลขมาจาก flag `--max-turns 40` และ `--max-cost 0.40` ที่ `gcode serve` ใช้เป็นค่าตั้งต้น ส่วนขยายไม่ส่งค่าอื่นมา

| เหตุ | สิ่งที่ Geno ทำ | turn จบแบบ |
| --- | --- | --- |
| เหลือการเรียกครั้งเดียว และโมเดลเขียนรายงาน | เรียกครั้งสุดท้ายโดยปิดเครื่องมือ | `done (end_turn)` |
| เหลือการเรียกครั้งเดียว แต่โมเดลไม่เขียนอะไร | ไม่กระตุ้นซ้ำ | `failed` / `max-turns` |
| ค่าใช้จ่ายเลยงบก่อนจะรู้ว่าเป็นครั้งสุดท้าย | ไม่เรียกโมเดลอีก | `failed` / `budget` |

สิ่งที่ควรสังเกต

- **รอบที่ชนขีดจำกัดอาจจบแบบ done** เมื่อการเรียกครั้งที่ 40 ปิดเครื่องมือ โมเดลที่เขียนรายงานจบด้วย `end_turn` ตามปกติ
  `loopStep` จึงให้ `done(end_turn)` ไม่ใช่ `max-turns` ผู้ใช้เห็นรายงานโดยไม่มีแถบเตือนขีดจำกัด
- **เตือนล่วงหน้าเมื่อเหลือ 20%** ก่อนการเรียกที่เหลือจำนวนครั้งหรืองบไม่เกิน 20% `deliver()` บันทึก `notice` ที่บอกโมเดลว่าเหลือเท่าไร
  ครั้งเดียวต่อรอบ ผู้ใช้ไม่เห็นประกาศนี้
- **Continue ได้ขีดจำกัดใหม่** Continue และ Retry ส่ง prompt ใหม่ `drive` เริ่มนับรอบใหม่จาก prompt นั้น
  และ prompt เดิมยังอยู่ในคำขอ เพราะ error ของขีดจำกัดไม่ลบ prompt ที่ยังไม่ได้คำตอบ
- **ประกาศแสดงเสมอเมื่อมีแถบขีดจำกัด** `missingReply` มองหาข้อความหลังขั้นสุดท้าย และแถบขีดจำกัดก็นับเป็นขั้น
  ข้อความใดๆ ที่โมเดลเขียนก่อนชนขีดจำกัดจึงไม่ทำให้ประกาศ "It reached its limit before it answered." หายไป

ปุ่ม Continue และ Retry ทำอะไรต่อ ดู [Turn จบโดยไม่มีคำตอบ แล้วคุณกด Continue หรือ Retry](/scenarios/mstop/no-reply-continue-retry/)
