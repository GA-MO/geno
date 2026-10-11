---
title: สรุปบริบทอัตโนมัติก่อนเรียกโมเดล
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
      do: >-
        `loopStep` เห็น `tool-result` ล่าสุดจึงตัดสินว่า `call-model` แล้ว `deliver()` ส่งของที่รออยู่เข้าสู่ log ก่อน
      ref: packages/core/src/loop.ts#loopStep
      emits: [call-model]
      phase: calling-model

    - id: due
      lane: loop
      at: model-call
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
                do: >-
                  แผนนี้ทำให้ context ต่ำกว่าเกณฑ์ หรืออย่างน้อยเหลือครึ่งหนึ่ง `callModel` จึงเรียก `compact('auto', plan)`
                ref: "packages/engine/src/drive.ts#\"if (due !== undefined) await compact('auto', due);\""
              - use: ctx-compacts

          - id: stuck
            label: ช่วยไม่ได้
            then: send
            steps:
              - lane: loop
                at: model-call
                do: >-
                  system prompt เครื่องมือ และช่วงท้ายล่าสุดกินพื้นที่ส่วนใหญ่ สรุปไปก็ไม่ลดลงพอ
                  `compactionStuck` เป็นจริง loop เขียนข้อความลง log ของ engine ครั้งเดียวต่อรอบ แล้วข้ามการสรุป
                  ผู้ใช้ไม่เห็นอะไรในแผงแชต
                ref: packages/core/src/compaction.ts#compactionStuck

    - id: send
      lane: loop
      at: model-call
      do: >-
        `callModel` ทำต่อตามปกติ: บันทึก `checkpoint` แล้วประกอบคำขอ `buildRequest` อ่าน log ผ่าน `contextView`
        ถ้าเพิ่งสรุป ข้อความแรกของผู้ใช้คือข้อมูล session ตามด้วยสรุป แล้วจึงเป็นช่วงท้ายที่เก็บไว้
      ref: packages/engine/src/drive.ts#callModel
      emits: [checkpoint]
      phase: calling-model
      end: { turn: continues, reason: call-model }
---

การสรุปอัตโนมัติเกิดได้ที่จุดเดียว: ต้น `callModel` ก่อน checkpoint และก่อนประกอบคำขอ
ไม่เกิดกลาง stream และไม่เกิดระหว่างเครื่องมือรัน

สิ่งที่ควรสังเกต

- **log ไม่หายอะไร** event `compact` เพิ่มเข้าไปเฉยๆ ทุก event เดิมยังอยู่ `contextView` เลือกเฉพาะสรุปล่าสุดกับช่วงท้ายมาให้โมเดล
  การเล่นซ้ำ session จึงยังเห็นบทสนทนาเต็ม พร้อมเส้นคั่นตรงที่สรุป
- **ต้องมีการเรียกโมเดลใหม่ก่อนสรุปซ้ำ** ถ้า event ล่าสุดที่เป็นคำตอบหรือการสรุปคือ `compact` การสรุปจะไม่เกิดอีก
  จนกว่าโมเดลจะตอบอีกครั้งและวัดขนาดจริงได้
- **ค่าใช้จ่ายของการสรุปนับรวมในงบของรอบ** แต่ไม่นับเป็นการเรียกโมเดลใน 40 ครั้ง
- **สรุปล้มเหลวไม่ทำให้ turn ล้ม** ถ้าการเรียกเพื่อสรุปได้ error หรือได้ข้อความว่าง `compactContext` คืน `failed`
  ไม่มีอะไรถูกบันทึก ข้อความลง log ของ engine และคำขอถูกส่งไปด้วย context เต็มเท่าเดิม
  ถ้ามันยาวเกินจริง ผู้ให้บริการจะปฏิเสธ แล้วทางจะไปที่ [context เกินหน้าต่าง สรุปแล้วส่งใหม่](/scenarios/ctx/overflow-compact-resend/)
- **Stop ระหว่างสรุปยกเลิกการเรียกเพื่อสรุปด้วย** signal ของ turn ส่งต่อไปถึงการเรียกนั้น
