---
title: "Context เกินหน้าต่าง Geno ทำ compaction แล้วส่งใหม่"
description: ผู้ให้บริการปฏิเสธคำขอเพราะยาวเกิน loop สรุปบริบทหนึ่งครั้งแล้วส่งคำขอเดิมใหม่หนึ่งครั้ง ถ้ายังเกินอีก turn จบแบบ failed
tableOfContents: false
sidebar:
  order: 2
scenario:
  surface: vscode
  given:
    - เปิด Geno ในแผงแชตของ VS Code มี turn ทำงานอยู่
    - ผลของเครื่องมือชุดล่าสุดใหญ่มาก จน context เกินหน้าต่างของโมเดลก่อนที่การสรุปอัตโนมัติจะทันได้ทำ
  trigger: >-
    loop ส่งคำขอโมเดล และผู้ให้บริการตอบว่าคำขอยาวเกินไป
  covers: [ctx.overflow-compact-resend]
  related: [ctx.compaction-auto, err.transient-retried, ctx.large-output-spill]
  steps:
    - use: model-call
      beat:
        title: "Geno ส่งคำขอให้ model"
        text: >-
          ผลของ tool ชุดล่าสุดใหญ่มาก จน context เกินหน้าต่างของโมเดลก่อน compaction อัตโนมัติจะทันทำ
        to: model

    - id: refused
      lane: model
      beat:
        title: "ผู้ให้บริการบอกว่าคำขอยาวเกิน"
        text: >-
          ผู้ให้บริการตอบ error 400 ว่า prompt is too long บางรุ่นจบคำตอบด้วยสัญญาณว่า context เกินหน้าต่างแทน
        to: engine
      do: >-
        ผู้ให้บริการตอบ 400 ข้อความ "prompt is too long" (บางรุ่นจบ stream ด้วย `stop_reason: model_context_window_exceeded` แทน)
      ref: packages/engine/src/wire.ts#anthropicWire
      emits: [model_context_window_exceeded]

    - id: kind
      lane: loop
      at: gateway
      beat:
        title: "Geno รู้ว่าเป็น overflow ไม่ retry"
        text: >-
          Geno ดูข้อความก่อนดูสถานะ error เรื่อง context ยาวเกินจึงไม่ถูกนับเป็น error ที่แก้ไม่ได้
          การส่งซ้ำแบบเดิมไม่ช่วย Geno จึงไม่ retry และให้ loop จัดการเอง
      do: >-
        `classifyFailure` เทียบข้อความก่อนสถานะ ข้อความเรื่อง context ยาวเกินจึงได้ `overflow` ไม่ใช่ `fatal`
        (stop reason `model_context_window_exceeded` ก็ได้ผลเดียวกันใน `gateway.call`) gateway ไม่ลองซ้ำ แต่คืนผลเป็น error ชนิด `overflow` ทันที เพื่อให้ loop จัดการเอง
      ref: packages/core/src/model-error.ts#TURN_ERROR_OF
      emits: [overflow]

    - id: compact
      lane: loop
      at: model-call
      beat:
        title: "Geno ทำ compaction ทันที"
        text: >-
          Geno ยังไม่บันทึก error แต่เริ่ม compaction ทันที โดยไม่ตรวจว่าจะลดได้ครึ่งไหม เพราะส่งแบบเดิมไม่ได้อยู่แล้ว
      do: >-
        `callModel` เห็น error ชนิด `overflow` จึงเรียก `compact('overflow')` ทันที ยังไม่บันทึก error ลง log
        การสรุปแบบนี้ไม่ตรวจว่าจะลดได้ครึ่งหนึ่งไหม เพราะส่งแบบเดิมไม่ได้อยู่แล้ว
      ref: "packages/engine/src/drive.ts#\"if (result.kind === 'error' && result.error === 'overflow' && (await compact('overflow'))) result = await send();\""

    - use: ctx-compacts
      beat:
        title: "Model สรุป แล้วแชตขึ้นเส้นคั่น"
        text: >-
          แชตขึ้นแถว Compacting the context ส่วนเก่าถูกส่งให้โมเดลสรุป ช่วงท้ายล่าสุดเก็บไว้ตามเดิม
          แล้วแชตขึ้นเส้นคั่นที่เปิดดูสรุปได้
        to: panel
        sees: { kind: notice, text: Compacting the context, tone: info }

    - id: resend
      lane: loop
      at: gateway
      beat:
        title: "Geno ส่งคำขอเดิมที่เล็กลงอีกครั้ง"
        text: >-
          Geno ส่งคำขอเดิมด้วย context ที่เล็กลง ใช้ checkpoint เดิม นี่คือการส่งซ้ำครั้งเดียวที่ Geno ให้
        to: model
        ask: "รับคำขอไหม"
      do: >-
        `send()` ส่งคำขออีกครั้งด้วย `contextView` ที่เล็กลง ใช้ checkpoint เดิม ไม่บันทึกใหม่
        นี่คือการส่งซ้ำครั้งเดียวที่ loop ให้
      ref: packages/engine/src/drive.ts#callModel
      phase: calling-model
      fork:
        ask: ผู้ให้บริการรับคำขอที่เล็กลงไหม
        options:
          - id: accepted
            label: รับ
            steps:
              - lane: model
                beat:
                  title: "ผู้ให้บริการรับ คำตอบขึ้นในแชต"
                  text: >-
                    ผู้ให้บริการตอบตามปกติ คำตอบ stream ออกมา
                  sees: { kind: message, from: geno, text: เทสต์ที่ล้มมาจาก parseDate ที่ไม่รองรับเขตเวลา, streaming: true }
                do: >-
                  ผู้ให้บริการตอบตามปกติ stream คำตอบออกมา
                ref: "packages/engine/src/gateway.ts#\"stopReason: message.stop_reason,\""
              - lane: panel
                at: rail
                beat:
                  title: "เส้นคั่นบอกว่าทำไมสรุป"
                  text: >-
                    คำตอบขึ้นต่อจากเส้นคั่น เปิดเส้นคั่นแล้วเห็นเหตุผลว่าโมเดลปฏิเสธเพราะยาวเกิน Geno จึงสรุปแล้วส่งใหม่ Geno
                    บันทึกคำตอบแล้ว turn ทำต่อตามปกติ
                  end: "ส่งใหม่สำเร็จ turn ทำต่อ"
                  sees: "เส้นคั่น \"Context compacted\" ที่เปิดแล้วมีเหตุผล \"The model refused the request as too long, so Geno compacted and sent it again.\""
                alongside: true
                do: >-
                  คำตอบขึ้นต่อจากเส้นคั่น ซึ่งบอกเหตุผลว่าทำไมสรุป
                sees: >-
                  เส้นคั่น "Context compacted" ที่เปิดแล้วมีเหตุผล
                  "The model refused the request as too long, so Geno compacted and sent it again."
                ref: packages/extension/src/chat/compact-model.ts#compactLook
              - lane: loop
                at: drive
                do: >-
                  `callModel` บันทึก event `assistant` ของคำตอบ แล้ว `loopStep` ตัดสินขั้นต่อไปตามปกติ
                ref: "packages/engine/src/drive.ts#\"await record({ kind: 'assistant', seq: nextSeq(events), at, ...result.turn\""
                emits: [assistant]
                end: { turn: continues }

          - id: still-too-long
            label: ยังยาวเกิน
            steps:
              - lane: model
                beat:
                  title: "ยังยาวเกิน"
                  text: >-
                    ผู้ให้บริการปฏิเสธอีกครั้ง เช่นช่วงท้ายที่เก็บไว้มีผลของ tool ก้อนใหญ่ที่สรุปไม่ได้
                  to: engine
                do: >-
                  ผู้ให้บริการปฏิเสธอีกครั้ง เช่นช่วงท้ายที่เก็บไว้มีผลเครื่องมือก้อนใหญ่ที่สรุปไม่ได้
                ref: packages/engine/src/wire.ts#anthropicWire
              - lane: loop
                at: gateway
                beat:
                  title: "Geno ไม่สรุปซ้ำและไม่ส่งซ้ำ"
                  text: >-
                    Geno ให้โอกาสส่งซ้ำครั้งเดียว คราวนี้จึงถือว่าการเรียกล้ม
                do: >-
                  gateway คืน error ชนิด `overflow` อีกครั้ง loop ไม่สรุปซ้ำและไม่ส่งซ้ำอีก
                ref: packages/core/src/model-error.ts#TURN_ERROR_OF
                emits: [overflow]
              - use: err-turn-fails
                beat:
                  title: "แชตขึ้นแถบ error แล้ว turn ล้มเหลว"
                  text: >-
                    Geno บันทึก error แชตขึ้นแถบสีแดงพร้อมข้อความของผู้ให้บริการ และ turn จบแบบ failed
                  to: panel
                  end: "ยังยาวเกิน turn ล้มเหลว"
                  sees: { kind: notice, text: Prompt is too long, tone: error }
---

Geno พยายามสรุปก่อนถึงขอบหน้าต่างเสมอ ([สรุปบริบทอัตโนมัติ](/scenarios/ctx/compaction-auto/)) ทางนี้จึงเกิดเมื่อการประเมินขนาดพลาด
เช่น token ที่ประเมินจากจำนวนตัวอักษรน้อยกว่าที่ผู้ให้บริการนับจริง หรือผลเครื่องมือชุดเดียวใหญ่จนกระโดดข้ามเกณฑ์ไป

สิ่งที่ควรสังเกต

- **สรุปหนึ่งครั้ง ส่งใหม่หนึ่งครั้ง** ไม่มีวงวน ถ้าคำขอที่สองถูกปฏิเสธ turn จบแบบ failed ด้วย error ชนิด `overflow`
- **ไม่มีจุดตัดก็ไม่มีการส่งซ้ำ** ถ้า `planCompaction` หาจุดตัดไม่ได้ (เช่น turn แรกที่ยังไม่มีคำตอบของโมเดลเลย)
  หรือการเรียกเพื่อสรุปล้ม `compact()` คืน false แล้ว error ชนิด `overflow` ถูกบันทึกทันที
- **prompt ยังค้างอยู่** `overflow` เป็นชนิดที่เก็บ prompt ไว้ ข้อความถัดไปของผู้ใช้จะส่งไปพร้อม prompt เดิม
  และถ้าผู้ใช้กดปุ่ม Compact หรือพิมพ์ `/compact` ก่อน ([สรุปด้วยมือ](/scenarios/ctx/compaction-manual/)) ข้อความถัดไปก็มีที่พอ

error อื่นของผู้ให้บริการ ดู [ผู้ให้บริการล้มชั่วคราว Geno retry เอง](/scenarios/err/transient-retried/)
