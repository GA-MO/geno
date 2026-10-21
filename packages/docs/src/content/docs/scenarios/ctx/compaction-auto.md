---
title: "Compaction อัตโนมัติก่อนเรียก model"
description: context ใหญ่ถึง 80% ของหน้าต่าง model ก่อนเรียกครั้งถัดไป loop ให้ model สรุปส่วนเก่าแล้วส่งคำขอที่เล็กลง
scenario:
  surface: vscode
  given:
    - เปิด Geno ในแผงแชตของ VS Code turn ทำงานมานานและอ่านไฟล์ไปหลายไฟล์
    - context ล่าสุดที่วัดได้รวมกับสิ่งที่มาหลังจากนั้นถึง `compactAt` แล้ว (80% ของหน้าต่าง model หรือค่า `GCODE_COMPACT_AT`)
  trigger: >-
    ผลของ tool ชุดล่าสุดถูกบันทึกแล้ว และ loop กำลังจะเรียก model อีกครั้ง
  covers: [ctx.compaction-auto]
  related: [ctx.overflow-compact-resend, ctx.compaction-manual, ctx.large-output-spill, ctl.stop-during-compaction]
  steps:
    - id: decide
      lane: loop
      at: step
      beat:
        title: "ผลของ tool กลับมา Geno จะเรียก model"
        text: >-
          turn ทำงานมานานและอ่านไฟล์ไปหลายไฟล์ ผลของ tool ชุดล่าสุดถูกบันทึกแล้ว ขั้นต่อไปคือเรียก model
        from: engine
        to: engine
      do: >-
        `loopStep` เห็น `tool-result` ล่าสุดจึงตัดสินว่า `call-model` แล้ว `deliver()` ส่งของที่รออยู่เข้าสู่ log ก่อน
      ref: packages/core/src/loop.ts#loopStep
      emits: [call-model]
      phase: calling-model

    - id: due
      lane: loop
      at: model-call
      beat:
        title: "Geno ดูว่า context ถึงเกณฑ์หรือยัง"
        text: >-
          context คือทุกอย่างที่ Geno ส่งให้ model ในคำขอหนึ่ง ทั้ง system prompt รายชื่อ tool และบทสนทนา
          หน้าต่าง model (context window) คือจำนวน token สูงสุดที่ model อ่านได้ในคำขอเดียว
          ก่อนเรียก model Geno ดูว่า context ถึง 80% ของหน้าต่างนั้นหรือยัง และมีการเรียก model หลังการสรุปครั้งก่อนไหม
          ข้อหลังสำคัญเพราะขนาดจริงวัดได้จากคำตอบของ model เท่านั้น (คำตอบของ model บอกจำนวน token ที่คำขอใช้จริง
          ก่อนหน้านั้น Geno ได้แค่ค่าประมาณ)
          ทั้งสองข้อจริง Geno จึงวางจุดตัด ส่วนก่อนจุดตัดจะถูกสรุป ส่วนหลังเก็บไว้คำต่อคำ แล้วประเมินว่าสรุปแล้วจะเหลือเท่าไร
        from: engine
        to: engine
        ask: "สรุปแล้วช่วยไหม"
      do: >-
        สิ่งแรกที่ `callModel` ทำคือถาม `autoCompaction`: มีการเรียก model หลังการสรุปครั้งก่อนไหม และ context ถึงเกณฑ์หรือยัง
        ทั้งสองข้อจริง จึงวางแผนจุดตัดและประเมินขนาดหลังสรุป (รวมที่สำหรับไฟล์ที่จะแนบ)
      ref: packages/core/src/compaction.ts#autoCompaction
      fork:
        ask: การสรุปจะช่วยได้ไหม
        options:
          - id: helps
            label: ช่วยได้
            then: send
            steps:
              - lane: loop
                at: model-call
                beat:
                  title: "Geno เริ่มสรุปบทสนทนาเก่า"
                  text: >-
                    สรุปแล้ว context จะต่ำกว่าเกณฑ์ หรืออย่างน้อยเหลือครึ่ง Geno จึงเริ่ม compaction
                    คือเรียก model อีกครั้งให้สรุปส่วนเก่า แล้วใช้สรุปแทนส่วนนั้นในคำขอต่อๆ ไป แชตขึ้นแถว Compacting the context
                  from: engine
                  to: panel
                  sees: { kind: notice, text: Compacting the context, tone: info }
                do: >-
                  แผนนี้ทำให้ context ต่ำกว่าเกณฑ์ หรืออย่างน้อยเหลือครึ่งหนึ่ง `callModel` จึงเรียก `compact('auto', plan)`
                ref: "packages/engine/src/drive.ts#\"if (due !== undefined) await compact('auto', due);\""
              - use: ctx-compacts
                beat:
                  title: "Model สรุป แล้วแชตขึ้นเส้นคั่น"
                  text: >-
                    ส่วนก่อนจุดตัดถูกส่งให้ model สรุปเป็นบันทึกการทำงาน ช่วงท้ายล่าสุดเก็บไว้ตามเดิม บันทึกของ session
                    ยังเก็บทุกอย่างเดิม แต่คำขอต่อจากนี้ใช้สรุปแทนส่วนเก่า แชตขึ้นเส้นคั่นที่เปิดดูสรุปได้
                    การ์ดข้างล่างเป็นสรุปจริงที่ model เขียน บันทึกใน log จากการรันใน terminal ที่ตั้ง `GCODE_COMPACT_AT` ต่ำ
                    ดู field `summary` ที่ไฮไลต์ มันแบ่งเป็นหัวข้อ การ์ดแสดงช่วงที่หัวข้อ Goal จบ แล้วต่อด้วยหัวข้อ The user's rules และ Progress
                  from: model
                  to: engine
                  sees:
                    kind: payload
                    source: docs/results/real-usecases/runs/A16-compaction-goal/2/session.jsonl.gz#seq=59
                    highlight: [summary]
                    quote: "## The user's rules, word for word"

          - id: stuck
            label: ช่วยไม่ได้
            steps:
              - lane: loop
                at: model-call
                beat:
                  title: "สรุปไปก็ไม่ลดพอ Geno ข้าม"
                  text: >-
                    system prompt รายชื่อ tool และช่วงท้ายล่าสุดกินพื้นที่ส่วนใหญ่ สรุปไปก็ไม่ลดลงพอ
                    (หรือหาจุดตัดไม่ได้เลย) Geno เขียนข้อความลง stderr ของ engine (ไม่ใช่บันทึกของ session) ครั้งเดียวต่อ turn
                    แล้วข้ามการสรุป คุณไม่เห็นอะไรในแชต
                  from: engine
                  to: engine
                do: >-
                  system prompt tool และช่วงท้ายล่าสุดกินพื้นที่ส่วนใหญ่ สรุปไปก็ไม่ลดลงพอ
                  `compactionStuck` เป็นจริง `callModel` เขียนข้อความด้วย `io.err` (stderr) ครั้งเดียวต่อ turn แล้วข้ามการสรุป
                  ผู้ใช้ไม่เห็นอะไรในแผงแชต
                ref: packages/core/src/compaction.ts#compactionStuck
              - lane: loop
                at: model-call
                beat:
                  title: "Geno ส่งคำขอด้วยบทสนทนาเต็ม"
                  text: >-
                    Geno บันทึก checkpoint (ภาพถ่ายไฟล์ใน workspace ไว้ย้อนกลับ) แล้วส่งคำขอที่มีบทสนทนาเต็มเท่าเดิม
                    ไม่มีสรุป ถ้ายังไม่เกินหน้าต่าง model ตอบตามปกติและ turn ทำต่อ ถ้าเกิน ผู้ให้บริการจะปฏิเสธ
                    แล้วทางจะไปที่หน้า Context เกินหน้าต่าง Geno ทำ compaction แล้วส่งใหม่
                    การ์ดเป็นการบันทึกที่รัน Geno จริงกับ model จำลองที่ตอบตามบทที่เขียนไว้ก่อน ที่ตั้ง `GCODE_COMPACT_AT=8000` ต่ำกว่าขนาดของ system prompt กับรายชื่อ tool รวมกัน
                    (model จำลองรายงานว่าคำขอแรกใช้ 9,500 token) บทสนทนามีรอบเดียว จึงไม่มีส่วนเก่าให้สรุป
                    การ์ดคือ `messages` ของคำขอที่สอง ข้อความแรกไม่มี `<compacted_context>` และสองข้อความที่ไฮไลต์คือ call กับผลของมันครบทุกคำ
                  from: engine
                  to: model
                  sees:
                    kind: payload
                    source: packages/docs/src/data/recorded/ctx-compaction-auto.jsonl#line=4
                    select: messages
                    highlight: ['[1]', '[2]']
                  end: "turn ทำต่อด้วยคำขอขนาดเต็ม"
                do: >-
                  `callModel` ทำต่อตามปกติ: บันทึก `checkpoint` แล้วประกอบคำขอจาก log ทั้งหมดผ่าน `contextView` โดยไม่มี event `compact` ใหม่
                ref: packages/engine/src/drive.ts#callModel
                emits: [checkpoint]
                phase: calling-model
                end: { turn: continues }

    - id: send
      lane: loop
      at: model-call
      beat:
        title: "Geno ส่งคำขอที่เล็กลง"
        text: >-
          Geno บันทึก checkpoint (ภาพถ่ายไฟล์ใน workspace ไว้ย้อนกลับ) แล้วประกอบคำขอ
          ข้อความแรกมีคำสั่งที่โหลดตอนเปิด session และข้อมูลสภาพแวดล้อม ตามด้วยสรุป
          แล้วจึงเป็นช่วงท้ายที่เก็บไว้ ในที่นี้คือคำขอ edit ล่าสุดของ model และผลของมัน
          การ์ดข้างล่างเป็น `messages` จริงจากการรันใน terminal ที่ตั้ง `GCODE_COMPACT_AT` ต่ำ เป็นคำขอแรกหลัง Geno สรุปเอง
          บล็อกที่ไฮไลต์ขึ้นต้นด้วย `<compacted_context>` คือสรุป สองข้อความที่พับไว้คือช่วงท้ายที่เก็บไว้
        from: engine
        to: model
        sees:
          kind: payload
          source: docs/results/real-usecases/runs/A16-compaction-goal/2/requests.jsonl.gz#seq=62
          select: messages
          collapse: ['[1]', '[2]']
          highlight: ['[0].content[2]']
      do: >-
        `callModel` ทำต่อตามปกติ: บันทึก `checkpoint` แล้วประกอบคำขอ `buildRequest` อ่าน log ผ่าน `contextView`
        ข้อความแรกของผู้ใช้คือข้อมูล session ตามด้วยสรุป แล้วจึงเป็นช่วงท้ายที่เก็บไว้
      ref: packages/engine/src/drive.ts#callModel
      emits: [checkpoint]
      phase: calling-model

    - id: reply
      lane: model
      beat:
        title: "Model ทำงานต่อจากสรุป"
        text: >-
          คำขอนี้คือทั้งหมดที่ model เห็น มันไม่เห็นบทสนทนาเก่าแล้ว เห็นแค่สรุปกับช่วงท้าย ในการรันจริงนี้ model
          รู้จากสรุปว่าเหลือสองไฟล์ที่ยังไม่ได้แก้ จึงขอ `edit` สองไฟล์นั้นต่อ
          ข้อความที่ไฮไลต์ในการ์ดคือตอนที่ model บอกชื่อสองไฟล์นั้น คือ wallet.ts กับ warehouse.ts
        from: model
        to: engine
        sees:
          kind: payload
          source: docs/results/real-usecases/runs/A16-compaction-goal/2/session.jsonl.gz#seq=62
          select: content
          collapse: ['[0].thinking']
          highlight: ['[1].text']
        end: "turn ทำต่อ"
      do: >-
        model อ่านสรุปและช่วงท้ายที่เก็บไว้ แล้วตอบด้วยคำขอใหม่ ในการรันนี้คือ `edit` สองครั้ง และจบคำตอบด้วย `stop_reason: tool_use`
      ref: "packages/engine/src/gateway.ts#\"stopReason: message.stop_reason,\""
      emits: [tool_use]
      end: { turn: continues, reason: run-tools }
---

[Compaction](/start/glossary/) คือการให้ model สรุปส่วนเก่าของบทสนทนา เพื่อให้คำขอไม่เกิน [context window](/foundations/memory-and-context/)
หน้านี้เล่าการสรุปที่ Geno ทำเองโดยไม่มีใครสั่ง

การสรุปอัตโนมัติเกิดได้ที่จุดเดียว: ต้น `callModel` ก่อน checkpoint และก่อนประกอบคำขอ
ไม่เกิดกลาง stream และไม่เกิดระหว่าง tool รัน

สิ่งที่ควรสังเกต

- **log ไม่หายอะไร** event `compact` เพิ่มเข้าไปเฉยๆ ทุก event เดิมยังอยู่ `contextView` เลือกเฉพาะสรุปล่าสุดกับช่วงท้ายมาให้ model
  การเล่นซ้ำ session จึงยังเห็นบทสนทนาเต็ม พร้อมเส้นคั่นตรงที่สรุป
- **ต้องมีการเรียก model ใหม่ก่อนสรุปซ้ำ** ถ้า event ล่าสุดที่เป็นคำตอบหรือการสรุปคือ `compact` การสรุปจะไม่เกิดอีก
  จนกว่า model จะตอบอีกครั้งและวัดขนาดจริงได้
- **ค่าใช้จ่ายของการสรุปนับรวมใน[งบของ turn](/start/glossary/)** แต่ไม่นับเป็นการเรียก model ในงบ 40 ครั้ง (ค่าเริ่มต้น)
- **สรุปล้มเหลวไม่ทำให้ turn ล้ม** ถ้าการเรียกเพื่อสรุปได้ error หรือได้ข้อความว่าง `compactContext` คืน `failed`
  ไม่มีอะไรถูกบันทึก Geno เขียนข้อความลง stderr ของ engine และคำขอถูกส่งไปด้วย context เต็มเท่าเดิม
  ถ้ามันยาวเกินจริง ผู้ให้บริการจะปฏิเสธ แล้วทางจะไปที่ [Context เกินหน้าต่าง Geno ทำ compaction แล้วส่งใหม่](/scenarios/ctx/overflow-compact-resend/)
- **Stop ระหว่างสรุปยกเลิกการเรียกเพื่อสรุปด้วย** สัญญาณยกเลิกของ turn ส่งต่อไปถึงการเรียกนั้นด้วย

ถ้าผู้ให้บริการปฏิเสธก่อน compaction จะทัน ดู [Context เกินหน้าต่าง Geno ทำ compaction แล้วส่งใหม่](/scenarios/ctx/overflow-compact-resend/)
