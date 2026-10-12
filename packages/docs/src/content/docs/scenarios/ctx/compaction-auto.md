---
title: "Compaction อัตโนมัติก่อนเรียก model"
description: context ใหญ่ถึง 80% ของหน้าต่างโมเดล ก่อนเรียกครั้งถัดไป loop ให้โมเดลสรุปส่วนเก่าแล้วส่งคำขอที่เล็กลง
tableOfContents: false
sidebar:
  order: 1
scenario:
  surface: vscode
  given:
    - เปิด Geno ในแผงแชตของ VS Code turn ทำงานมานานและอ่านไฟล์ไปหลายไฟล์
    - context ล่าสุดที่วัดได้รวมกับสิ่งที่มาหลังจากนั้นถึง `compactAt` แล้ว (80% ของหน้าต่างโมเดล หรือค่า `GCODE_COMPACT_AT`)
  trigger: >-
    ผลของเครื่องมือชุดล่าสุดถูกบันทึกแล้ว และ loop กำลังจะเรียกโมเดลอีกครั้ง
  covers: [ctx.compaction-auto]
  related: [ctx.overflow-compact-resend, ctx.compaction-manual, ctx.large-output-spill, ctl.stop-during-compaction]
  steps:
    - id: decide
      lane: loop
      at: step
      beat:
        title: "ผลของ tool กลับมา Geno จะเรียก model"
        text: >-
          turn ทำงานมานานและอ่านไฟล์ไปหลายไฟล์ ผลของ tool ชุดล่าสุดถูกบันทึกแล้ว ขั้นต่อไปคือเรียกโมเดล
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
          ก่อนเรียกโมเดล Geno ดูว่า context ถึง 80% ของหน้าต่างโมเดลหรือยัง และมีการเรียกโมเดลหลังการสรุปครั้งก่อนไหม
          ทั้งสองข้อจริง Geno จึงวางจุดตัดและประเมินว่าสรุปแล้วจะเหลือเท่าไร
        ask: "สรุปแล้วช่วยไหม"
      do: >-
        สิ่งแรกที่ `callModel` ทำคือถาม `autoCompaction`: มีการเรียกโมเดลหลังการสรุปครั้งก่อนไหม และ context ถึงเกณฑ์หรือยัง
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
                    สรุปแล้ว context จะต่ำกว่าเกณฑ์ หรืออย่างน้อยเหลือครึ่ง Geno จึงเริ่ม compaction แชตขึ้นแถว Compacting the
                    context
                  sees: { kind: notice, text: Compacting the context, tone: info }
                do: >-
                  แผนนี้ทำให้ context ต่ำกว่าเกณฑ์ หรืออย่างน้อยเหลือครึ่งหนึ่ง `callModel` จึงเรียก `compact('auto', plan)`
                ref: "packages/engine/src/drive.ts#\"if (due !== undefined) await compact('auto', due);\""
              - use: ctx-compacts
                beat:
                  title: "Model สรุป แล้วแชตขึ้นเส้นคั่น"
                  text: >-
                    ส่วนก่อนจุดตัดถูกส่งให้โมเดลสรุปเป็นบันทึกการทำงาน ช่วงท้ายล่าสุดเก็บไว้ตามเดิม บันทึกของ session
                    ยังเก็บทุกอย่างเดิม แต่คำขอต่อจากนี้ใช้สรุปแทนส่วนเก่า แชตขึ้นเส้นคั่นที่เปิดดูสรุปได้
                  to: panel
                  sees: "เส้นคั่น \"Context compacted · 184,213 → about 31,400 tokens\" และวงแหวน context ในช่องพิมพ์ลดลง"

          - id: stuck
            label: ช่วยไม่ได้
            then: send
            steps:
              - lane: loop
                at: model-call
                beat:
                  title: "สรุปไปก็ไม่ลดพอ Geno ข้าม"
                  text: >-
                    system prompt รายชื่อ tool และช่วงท้ายล่าสุดกินพื้นที่ส่วนใหญ่ สรุปไปก็ไม่ลดลงพอ Geno เขียนบอกใน log ของ
                    engine ครั้งเดียว แล้วข้ามการสรุป คุณไม่เห็นอะไรในแชต
                do: >-
                  system prompt เครื่องมือ และช่วงท้ายล่าสุดกินพื้นที่ส่วนใหญ่ สรุปไปก็ไม่ลดลงพอ
                  `compactionStuck` เป็นจริง loop เขียนข้อความลง log ของ engine ครั้งเดียวต่อรอบ แล้วข้ามการสรุป
                  ผู้ใช้ไม่เห็นอะไรในแผงแชต
                ref: packages/core/src/compaction.ts#compactionStuck

    - id: send
      lane: loop
      at: model-call
      beat:
        title: "Geno ส่งคำขอที่เล็กลง"
        text: >-
          Geno บันทึก checkpoint แล้วประกอบคำขอ ถ้าเพิ่งสรุป ข้อความแรกคือข้อมูล session ตามด้วยสรุป
          แล้วจึงเป็นช่วงท้ายที่เก็บไว้ turn ทำงานต่อตามปกติ
        to: model
        end: "turn ทำต่อ"
      do: >-
        `callModel` ทำต่อตามปกติ: บันทึก `checkpoint` แล้วประกอบคำขอ `buildRequest` อ่าน log ผ่าน `contextView`
        ถ้าเพิ่งสรุป ข้อความแรกของผู้ใช้คือข้อมูล session ตามด้วยสรุป แล้วจึงเป็นช่วงท้ายที่เก็บไว้
      ref: packages/engine/src/drive.ts#callModel
      emits: [checkpoint]
      phase: calling-model
      end: { turn: continues, reason: call-model }
---

การสรุปอัตโนมัติเกิดได้ที่จุดเดียว: ต้น `callModel` ก่อน checkpoint และก่อนประกอบคำขอ
ไม่เกิดกลาง stream และไม่เกิดระหว่าง tool รัน

สิ่งที่ควรสังเกต

- **log ไม่หายอะไร** event `compact` เพิ่มเข้าไปเฉยๆ ทุก event เดิมยังอยู่ `contextView` เลือกเฉพาะสรุปล่าสุดกับช่วงท้ายมาให้โมเดล
  การเล่นซ้ำ session จึงยังเห็นบทสนทนาเต็ม พร้อมเส้นคั่นตรงที่สรุป
- **ต้องมีการเรียกโมเดลใหม่ก่อนสรุปซ้ำ** ถ้า event ล่าสุดที่เป็นคำตอบหรือการสรุปคือ `compact` การสรุปจะไม่เกิดอีก
  จนกว่าโมเดลจะตอบอีกครั้งและวัดขนาดจริงได้
- **ค่าใช้จ่ายของการสรุปนับรวมในงบของรอบ** แต่ไม่นับเป็นการเรียกโมเดลใน 40 ครั้ง
- **สรุปล้มเหลวไม่ทำให้ turn ล้ม** ถ้าการเรียกเพื่อสรุปได้ error หรือได้ข้อความว่าง `compactContext` คืน `failed`
  ไม่มีอะไรถูกบันทึก ข้อความลง log ของ engine และคำขอถูกส่งไปด้วย context เต็มเท่าเดิม
  ถ้ามันยาวเกินจริง ผู้ให้บริการจะปฏิเสธ แล้วทางจะไปที่ [Context เกินหน้าต่าง Geno ทำ compaction แล้วส่งใหม่](/scenarios/ctx/overflow-compact-resend/)
- **Stop ระหว่างสรุปยกเลิกการเรียกเพื่อสรุปด้วย** signal ของ turn ส่งต่อไปถึงการเรียกนั้น

ถ้าผู้ให้บริการปฏิเสธก่อน compaction จะทัน ดู [Context เกินหน้าต่าง Geno ทำ compaction แล้วส่งใหม่](/scenarios/ctx/overflow-compact-resend/)
