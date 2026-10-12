---
title: "ผู้ให้บริการล้มชั่วคราว Geno retry เอง"
description: การเรียกโมเดลได้ 529 หรือโมเดลเงียบไป gateway ลองใหม่เองพร้อมแจ้งในแผงแชต ส่วนเครดิตหมดหรือคีย์ผิดจบ turn ทันที
tableOfContents: false
sidebar:
  order: 1
scenario:
  surface: vscode
  given:
    - เปิด Geno ในแผงแชตของ VS Code มี turn ทำงานอยู่
    - เครือข่ายใช้ได้ แต่ฝั่งผู้ให้บริการมีปัญหา
  trigger: >-
    loop ส่งคำขอโมเดล แต่ผู้ให้บริการตอบกลับด้วย error แทนคำตอบ
  covers: [err.transient-retried, err.quota-or-fatal, err.stream-stalled]
  related: [err.offline-wait, err.rate-limited, ctx.overflow-compact-resend, turn.text-answer]
  steps:
    - use: model-call
      beat:
        title: "Geno ส่งคำขอให้ model"
        text: >-
          turn กำลังทำงาน เครือข่ายใช้ได้ แต่ฝั่งผู้ให้บริการมีปัญหา
        from: engine
        to: model

    - id: fails
      lane: model
      beat:
        title: "ผู้ให้บริการตอบ error แทนคำตอบ"
        text: >-
          ผู้ให้บริการตอบเป็น error หรือเงียบไปเฉยๆ ตัวเชื่อมของ SDK ไม่ลองใหม่เอง Geno เป็นคนตัดสินว่าจะ retry ไหม
          ลองเลือกว่าผู้ให้บริการตอบอะไร
        from: model
        to: engine
        ask: "ตอบอะไร"
      do: >-
        ผู้ให้บริการไม่ส่งคำตอบ แต่ตอบเป็น error หรือเงียบไปเฉยๆ wire ของ SDK ไม่ลองใหม่เอง (`maxRetries: 0`)
        การลองใหม่ทั้งหมดเป็นงานของ gateway
      ref: packages/engine/src/wire.ts#anthropicWire

    - id: kind
      lane: loop
      at: gateway
      do: >-
        `gatewayFor.turn` จับ error แล้วถามว่าเป็นแบบไหน
      ref: packages/engine/src/gateway.ts#gatewayFor.turn
      fork:
        ask: ผู้ให้บริการตอบอะไร
        options:
          - id: overloaded
            label: 529 overloaded
            then: retry
            steps:
              - lane: loop
                at: gateway
                beat:
                  title: "529 overloaded เป็นแบบที่ retry ได้"
                  text: >-
                    ข้อความไม่ได้พูดถึงโควตา rate limit หรือ context และสถานะ 529 ตรงกฎของข้อผิดพลาดชั่วคราว Geno จึง retry ได้
                    โดยรอ 1 วินาทีก่อนครั้งที่สอง
                  from: engine
                  to: engine
                do: >-
                  `classifyFailure` เทียบกับตาราง `RULES` ตามลำดับ ข้อความไม่ได้พูดถึงโควตา rate limit หรือ context
                  สถานะ 529 จึงตรงกฎ 408 และ 5xx ได้ชนิด `transient` ซึ่งลองใหม่ได้
                  `retryDelayMs` ให้รอ 1 วินาทีก่อนครั้งที่สอง (ถ้าเซิร์ฟเวอร์ส่ง `retry-after` มาไม่เกิน 20 วินาที ใช้ค่านั้นแทน ถ้าเกิน 20 วินาที gateway เลิกลองทันที)
                ref: packages/core/src/model-error.ts#RULES
                emits: [transient]

          - id: stalled
            label: โมเดลเงียบ 180 วินาที
            then: retry
            steps:
              - lane: loop
                at: gateway
                beat:
                  title: "Geno เลิกรอ model ที่เงียบไป 180 วินาที"
                  text: >-
                    ไม่มี byte ใหม่เข้ามาเลย 180 วินาที Geno ยกเลิกการเรียกนี้ และให้โอกาส retry ได้ครั้งเดียว
                  from: engine
                  to: engine
                do: >-
                  ตัวเฝ้า stream นับ byte ที่เข้ามา ไม่มี byte เลย 180 วินาที (ก่อน byte แรก หรือระหว่าง byte)
                  จึงยกเลิกการเรียกนี้ด้วย `StreamStalled` gateway ให้โอกาสลองใหม่ได้ครั้งเดียว (`STALL_RETRIES`)
                ref: packages/engine/src/stream-watch.ts#StreamStalled
                emits: [StreamStalled]

          - id: quota
            label: 402 เครดิตหมด หรือ 4xx อื่น
            steps:
              - lane: loop
                at: gateway
                beat:
                  title: "เครดิตหมดหรือคีย์ผิด ไม่ retry"
                  text: >-
                    402 เครดิตหมด หรือ 4xx อื่นอย่าง 401 คีย์ผิด ลองไปก็ได้ผลเดิม Geno จึงไม่ retry และถือว่าการเรียกล้ม
                    พร้อมข้อความของผู้ให้บริการที่ลบคีย์ออกแล้ว
                  from: engine
                  to: engine
                do: >-
                  `classifyFailure` ได้ `quota` (402 หรือข้อความเรื่อง billing) หรือ `fatal` (สถานะอื่น เช่น 401 คีย์ผิด)
                  สองชนิดนี้ไม่ลองใหม่ ลองไปก็ได้ผลเดิม gateway คืนผลเป็น error ชนิด `transport` พร้อมข้อความของผู้ให้บริการ
                  ที่ลบคีย์ออกแล้ว
                ref: packages/core/src/model-error.ts#TURN_ERROR_OF
                emits: [quota, fatal, transport]
              - use: err-turn-fails
                beat:
                  title: "แชตขึ้นแถบ error ของผู้ให้บริการ"
                  text: >-
                    Geno บันทึก error แชตขึ้นแถบสีแดงพร้อมข้อความของผู้ให้บริการ และ turn จบแบบ failed ไม่มีปุ่ม Retry
                    คุณต้องแก้คีย์หรือเติมเครดิตแล้วส่งข้อความใหม่เอง
                  from: engine
                  to: panel
                  end: "ไม่ retry turn ล้มเหลว"
                  sees: "แถบ error สีแดงพร้อมข้อความของผู้ให้บริการ เช่นเรื่องเครดิตหรือคีย์"

    - id: retry
      lane: loop
      at: model-call
      beat:
        title: "Geno บันทึกว่าจะ retry"
        text: >-
          Geno บันทึกว่านี่คือครั้งที่เท่าไร จะรอนานเท่าไร และ error คืออะไร ก่อนเริ่มรอ แล้วแจ้งแชต การ retry
          ไม่นับเป็นการเรียกโมเดลในขีดจำกัดของ turn
        from: engine
        to: panel
      do: >-
        `onRetry` บันทึก event `retry` (ครั้งที่ เวลาที่จะรอ และข้อความ) ลง log ก่อนเริ่มรอ
      ref: "packages/engine/src/drive.ts#\"await record({ kind: 'retry', seq: nextSeq(events)\""
      emits: [retry]
      phase: waiting-retry

    - id: notice
      lane: server
      at: updates
      do: >-
        `LOGGED.retry` แปลง event เป็น `session/update` ชนิด `notice` ระดับ warning หัวข้อสั้นๆ จาก `retryReason`
        ข้อความเต็มของผู้ให้บริการอยู่ใน description
      ref: packages/engine/src/serve.ts#LOGGED.retry
      emits: [notice, Retrying in]

    - id: relay
      lane: editor
      at: chat
      alongside: true
      do: >-
        `UPDATES.notice` เห็นว่าไม่มี `_meta` ของ progress หรือ wait จึงส่ง action `notice` ให้ webview
      ref: packages/extension/src/chat/session-updates.ts#UPDATES.notice

    - id: shown
      lane: panel
      at: rail
      beat:
        title: "แชตขึ้น Retrying พร้อมเหตุผลสั้นๆ"
        text: >-
          ท้าย turn ขึ้นแถวประกาศพร้อมไอคอนหมุนแทนแถว Thinking ข้อความเต็มของผู้ให้บริการอยู่ในรายละเอียด
        from: panel
        to: you
        sees: { kind: notice, text: Retrying in 1s (model overloaded), tone: warning }
      alongside: true
      do: >-
        ท้าย turn ขึ้นแถวประกาศพร้อมไอคอนหมุน แทนแถว "Thinking"
      sees: >-
        "Retrying in 1s (model overloaded)" หรือ "Retrying in 1s (the model went quiet)"
      ref: packages/extension/src/chat/render.ts#turnNotice

    - id: backoff
      lane: loop
      at: gateway
      beat:
        title: "Geno รอแล้วเรียกใหม่"
        text: >-
          Geno รอ 1, 2 และ 4 วินาทีตามครั้ง แล้วเรียกใหม่ ถ้าคุณกด Stop ระหว่างรอ การรอจบทันทีและ turn จบแบบ stopped
        from: engine
        to: model
        ask: "ได้ผลไหม"
      do: >-
        gateway นอนรอตามเวลาแล้วเรียกใหม่ เวลารอเพิ่มเป็น 1, 2 และ 4 วินาที ถ้าผู้ใช้กด Stop ระหว่างรอ
        การนอนถูกยกเลิกทันทีและ turn จบแบบ stopped
      ref: "packages/engine/src/gateway.ts#\"const backOff = async (delayMs: number): Promise<boolean> => {\""
      fork:
        ask: การลองใหม่ได้ผลไหม
        options:
          - id: ok
            label: ครั้งถัดไปได้คำตอบ
            steps:
              - lane: model
                beat:
                  title: "ครั้งนี้ผู้ให้บริการตอบ"
                  text: >-
                    ผู้ให้บริการตอบตามปกติ คำตอบ stream ออกมาแล้วจบด้วย end_turn
                  from: model
                  to: engine
                do: >-
                  ผู้ให้บริการตอบตามปกติ stream คำตอบออกมาแล้วจบด้วย `stop_reason: end_turn`
                ref: "packages/engine/src/gateway.ts#\"stopReason: message.stop_reason,\""
                emits: [end_turn]
                phase: calling-model
              - lane: panel
                at: rail
                beat:
                  title: "แถว Retrying หายไป คำตอบขึ้นแทน"
                  text: >-
                    ทันทีที่การเรียกใหม่เริ่ม แถวประกาศหายไป แถว Thinking กลับมา แล้วคำตอบค่อยๆ ขึ้นในแชต
                  from: panel
                  to: you
                  sees: { kind: message, from: geno, text: เพิ่มเทสต์ให้ parseDate แล้ว, streaming: true }
                alongside: true
                do: >-
                  ทันทีที่การเรียกใหม่ได้ slot และเริ่ม (ก่อน byte แรก) `watchStream` รายงาน progress ครั้งแรก
                  action `progress` จึงลบแถวประกาศ Retrying ออก แล้วแถว "Thinking" กลับมา
                sees: แถว Retrying หายไป แถว "Thinking" ขึ้นแทน
                ref: "packages/extension/src/chat/transcript.ts#\"progress: (transcript, { progress }) =>\""
              - use: answer-streams
              - use: turn-ends
                beat:
                  title: "Turn จบ"
                  text: >-
                    โมเดลไม่ขออะไรเพิ่ม Geno จึงจบ turn ปุ่ม Send กลับมาแทน Stop
                  from: engine
                  to: panel
                  end: "retry สำเร็จ turn จบ"
                  sees: { kind: composer, state: idle }

          - id: give-up
            label: ยังล้มจนหมดสิทธิ์ลอง
            steps:
              - lane: loop
                at: gateway
                beat:
                  title: "ล้มจนหมดสิทธิ์ retry"
                  text: >-
                    ข้อผิดพลาดชั่วคราว retry ได้ 3 ครั้ง โมเดลเงียบ retry ได้ครั้งเดียว เมื่อครบแล้ว Geno ถือว่าการเรียกล้ม
                    สำหรับโมเดลเงียบ ข้อความบอกตัวแปรที่ตั้งให้รอนานขึ้นได้
                  from: engine
                  to: engine
                do: >-
                  ล้มอีกจนครบ: ชนิด `transient` ลองใหม่ได้ 3 ครั้ง (`RETRY_POLICY`) โมเดลเงียบลองได้ครั้งเดียว
                  `retryDelayMs` คืน undefined gateway จึงคืนผลเป็น error ชนิด `transport`
                  สำหรับโมเดลเงียบ ข้อความบอกตัวแปร `GCODE_STREAM_FIRST_BYTE_TIMEOUT_MS` หรือ `GCODE_STREAM_IDLE_TIMEOUT_MS` ที่ตั้งให้รอนานขึ้นได้
                ref: packages/core/src/model-error.ts#retryDelayMs
                emits: [transport]
              - use: err-turn-fails
                beat:
                  title: "แชตขึ้นแถบ error แล้ว turn ล้มเหลว"
                  text: >-
                    Geno บันทึก error แชตขึ้นแถบสีแดง และ turn จบแบบ failed prompt ที่ยังไม่ได้คำตอบไปกับข้อความถัดไปที่คุณส่ง
                  from: engine
                  to: panel
                  end: "retry ไม่สำเร็จ turn ล้มเหลว"
                  sees: "แถบ error สีแดงพร้อมข้อความของผู้ให้บริการจากครั้งสุดท้ายที่ลอง"
---

gateway แยก error ของผู้ให้บริการเป็นหกชนิดด้วยตาราง `RULES` ใน `model-error.ts` แล้วแต่ละชนิดมีทางของตัวเอง
หน้านี้คือสามชนิดที่ไม่ต้องรอนาน: ลองใหม่เร็วๆ หรือเลิกทันที

| ชนิด | ตัวอย่าง | ทำอะไร |
| --- | --- | --- |
| `transient` | 408, 5xx, 529, ข้อความ "overloaded" | ลองใหม่ 3 ครั้ง รอ 1, 2, 4 วินาที |
| โมเดลเงียบ | ไม่มี byte 180 วินาที | ลองใหม่ 1 ครั้ง |
| `quota`, `fatal` | 402, 401, 400 อื่น | ไม่ลอง จบ turn แบบ failed |
| `offline`, `limited` | เชื่อมต่อไม่ได้, 429 | รอนานกว่า ดู [เครือข่ายหลุดหรือชน rate limit แล้ว Geno รอ](/scenarios/err/offline-wait/) |
| `overflow` | "prompt is too long" | สรุปบริบทแล้วส่งใหม่ ดู [สรุปบริบทระหว่าง turn](/scenarios/ctx/compaction-auto/) |

สิ่งที่ควรสังเกต

- **การลองใหม่อยู่ใน log แต่ไม่กินขีดจำกัด** event `retry` ถูกบันทึกทุกครั้ง แต่ขีดจำกัด 40 ครั้งของรอบนับเฉพาะ event `assistant`
  การเรียกที่ล้มแล้วลองใหม่จนสำเร็จจึงนับเป็นหนึ่งครั้ง
- **ข้อความที่ stream มาแล้วหายได้** ถ้าการเรียกล้มกลางทาง ข้อความที่ผู้ใช้เห็นไปแล้วไม่ถูกบันทึก
  เพราะ log บันทึกคำตอบเป็น event `assistant` ตอนจบการเรียกเท่านั้น
- **prompt ที่ยังไม่ได้คำตอบยังค้างอยู่** error ชนิด `transport` ไม่ทิ้ง prompt (`KEEPS_PENDING_PROMPT`)
  ข้อความถัดไปที่ผู้ใช้ส่งจึงไปพร้อม prompt เดิมในข้อความเดียวกัน
- **แถบ error ไม่มีปุ่ม Retry** `missingReply` ไม่แสดงประกาศ Continue และ Retry เมื่อ turn มีแถบ error อยู่แล้ว
  ผู้ใช้ต้องส่งข้อความใหม่เอง

error ที่ต้องรอนานกว่านี้ ดู [เครือข่ายหลุดหรือชน rate limit แล้ว Geno รอ](/scenarios/err/offline-wait/)
