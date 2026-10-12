---
title: ตั้งเวลาปลุก
description: model ตั้งเวลาปลุกตัวเองพร้อมเหตุผล แล้วจบ turn เมื่อถึงเวลา engine เปิด turn ใหม่ให้ model อ่านเหตุผลนั้นแล้วทำต่อ แม้ engine จะเริ่มใหม่ระหว่างรอ
tableOfContents: false
sidebar:
  order: 5
scenario:
  surface: vscode
  given:
    - การปลุกอัตโนมัติเปิดอยู่ หน้าต่างที่แสดง session นี้ยังเปิดอยู่
    - model เพิ่ง deploy ไป staging และ staging ใช้เวลาราว 10 นาทีกว่าจะพร้อม
  trigger: >-
    model เรียก `schedule_wakeup` เพื่อกลับมาตรวจ staging ทีหลัง
  covers: [bg.schedule-wakeup]
  related: [bg.monitor-wakes, bg.task-stop-or-list, bg.user-cancels-wakes, bg.scheduled-task-fires]
  steps:
    - id: wants
      beat:
        title: Model ตั้งเวลาปลุกตัวเองใน 10 นาที
        text: model เพิ่ง deploy ไป staging ซึ่งใช้เวลาราว 10 นาทีกว่าจะพร้อม มันขอให้ Geno ปลุก พร้อมเหตุผล "check staging health after the deploy"
        from: model
        to: engine
      lane: model
      do: >-
        model ขอเรียก `schedule_wakeup` ด้วย `delay_s: 600` และ `reason: "check staging health after the deploy"`
        (ช่วงที่รับได้คือ 60 ถึง 3600 วินาที) จบคำตอบด้วย `stop_reason: tool_use`
      ref: packages/core/src/wake.ts#SCHEDULE_WAKEUP_TOOL
      emits: [tool_use, schedule_wakeup]
      phase: calling-model

    - use: tool-call-opens

    - id: record
      beat:
        title: Geno จดการปลุกลง log
        text: Geno บันทึก id `wake-1` เวลาที่ถึงกำหนด เหตุผล และ engine ที่ถือการปลุกนี้ log คือสิ่งที่ทำให้การปลุกรอด engine เริ่มใหม่
        from: engine
        to: engine
      lane: tool
      at: executor
      do: >-
        executor บันทึกโน้ต `wake` ชนิด `scheduled` ลง log ทันที: id `wake-1`, เวลาที่ถึงกำหนด, เหตุผล
        และ `by` ซึ่งเป็น pid กับโฟลเดอร์ของ engine ที่ถือการปลุกนี้ log คือที่ที่ engine ตัวถัดไปจะหาเจอ
      ref: "packages/engine/src/tools/wake.ts#\"await ctx.logNote({ kind: 'wake', at: new Date().toISOString(), note });\""
      emits: [wake, scheduled]

    - id: arm
      beat:
        title: Geno ตั้งนาฬิกาแล้วบอก model ให้จบ turn
        text: ผลของ call บอกเวลาที่จะปลุก และบอกให้จบ turn ตอนนี้
        from: engine
        to: model
      lane: server
      at: wakes
      do: >-
        `Wakes.schedule` ตั้งนาฬิกาของ `wake-1` ผลของ call คือ
        "Scheduled wake-up wake-1 for <เวลา>, 600s from now. End your turn now: Geno wakes you then with: check staging health after the deploy"
      ref: packages/engine/src/wakes.ts#Wakes.schedule
      emits: [Scheduled wake-up]

    - use: tool-result-returns
    - use: model-call

    - id: says
      beat:
        title: Model บอกว่าจะกลับมาตรวจ แล้ว turn จบ
        text: ปุ่ม Send กลับมา คุณทำอย่างอื่นต่อได้
        from: model
        to: panel
        sees:
          kind: composer
          state: idle
          header: worked for 9s
      lane: model
      do: >-
        model บอกผู้ใช้ว่าจะกลับมาตรวจในอีก 10 นาที แล้วจบด้วย `stop_reason: end_turn`
      ref: "packages/engine/src/gateway.ts#\"stopReason: message.stop_reason,\""
      emits: [end_turn]

    - use: bg-turn-lets-go

    - id: meanwhile
      beat:
        title: Tasks บอกว่ารอการปลุก
        text: ระหว่างรอ แผง Tasks บอกเวลาที่จะปลุก นาฬิกาอยู่ในหน่วยความจำของ engine
        from: panel
        to: you
        sees: Wakes on a wake-up at <เวลา>
        ask: engine ยังอยู่ไหม
      lane: server
      at: wakes
      do: >-
        ระหว่างรอ แผง Tasks บอก "Wakes on a wake-up at <เวลา>" นาฬิกาอยู่ในหน่วยความจำของ engine
      ref: packages/core/src/wake.ts#waitsForText
      fork:
        ask: engine ตัวเดิมยังอยู่จนถึงเวลาไหม
        options:
          - id: same
            label: ยังอยู่
            then: due

          - id: restarted
            label: engine เริ่มใหม่ระหว่างรอ
            then: due
            steps:
              - lane: server
                beat:
                  title: engine ตัวใหม่รับการปลุกต่อ
                  text: engine ตัวเดิมจบไป เมื่อหน้าต่างต่อ engine ตัวใหม่ มันหาการปลุกที่ยังไม่ดังใน log แล้วตั้งนาฬิกาตามเวลาเดิม ถ้าเลยเวลาแล้วก็ดังทันที
                  from: engine
                  to: engine
                at: sessions
                do: >-
                  engine ตัวเดิมจบไป (เช่นหลังปิดหน้าต่างทั้งหมด) เมื่อหน้าต่างต่อ engine ตัวใหม่ `takeUpWaits` เรียก `WakeDriver.takeUp`
                  ซึ่งหาโน้ต `scheduled` ที่ยังไม่ดังและไม่ถูกยกเลิก ใน log ที่แก้ภายใน 24 ชั่วโมง ของ engine ที่เคยรับใช้โฟลเดอร์นี้และไม่อยู่แล้ว
                ref: packages/engine/src/wake-hooks.ts#WakeDriver.takeUp
              - lane: server
                at: wakes
                do: >-
                  `takeUp` บันทึกโน้ต `scheduled` ของ `wake-1` ซ้ำโดยมี `by` เป็น engine ตัวใหม่ แล้ว `Wakes.schedule` ตั้งนาฬิกาตามเวลาเดิม
                  ถ้าเวลาผ่านไปแล้ว นาฬิกาดังทันที
                ref: packages/engine/src/wakes.ts#Wakes.schedule
                emits: [wake, scheduled]

    - id: due
      beat:
        title: นาฬิกาดัง
        text: Geno ลบการรอ แล้วใส่โน้ตว่าการปลุกถึงกำหนด พร้อมเหตุผล ลงกล่องข้อความของ session
        from: engine
        to: engine
      lane: server
      at: wakes
      do: >-
        นาฬิกาดัง `Wakes.schedule` ลบการรอ แล้วใส่โน้ต `wake` ชนิด `due` พร้อมเหตุผลลงกล่องข้อความของ session
        โน้ตนี้ถูกบันทึกลง log เป็น event `wake` ในขั้นถัดไป ซึ่งปิดโน้ต `scheduled` ของ `wake-1` ไม่ให้ engine ตัวอื่นรับช่วงอีก
      ref: packages/engine/src/wakes.ts#Wakes.schedule
      emits: [wake, due]

    - use: bg-wake-starts
      beat:
        title: Geno เปิด turn ใหม่เอง
        text: แชตเปิด turn ที่หัวมีกระดิ่งแทนข้อความของคุณ
        from: engine
        to: panel
        sees: 'กระดิ่งกับ "woke: scheduled" หัวข้อ "working" และปุ่ม Stop'
    - use: model-call

    - id: reads
      beat:
        title: Model ไปตรวจ staging
        text: model อ่านเหตุผลที่ตัวเองเขียนไว้ และข้อความว่า Geno เริ่ม turn นี้เอง แล้วเปิดหน้า health ของ staging
        from: model
        to: engine
        end: Turn ที่ถูกปลุกจบ
      lane: model
      do: >-
        model อ่าน "Scheduled wake-up wake-1 is due: check staging health after the deploy" กับข้อความว่า Geno เริ่ม turn นี้เอง (woke: scheduled)
        แล้วเรียก `web_fetch` หน้า health ของ staging เล่าผลให้ผู้ใช้ และจบด้วย `stop_reason: end_turn`
      ref: packages/core/src/wake.ts#wakeNoteText
      emits: [end_turn]
      phase: calling-model

    - use: bg-woken-ends
---

`schedule_wakeup` เป็นการรอแบบเดียวที่รอดการเริ่ม engine ใหม่ เพราะมันเขียนโน้ตลง log ก่อนตั้งนาฬิกา
monitor และการเฝ้า PR อยู่แค่ในหน่วยความจำ

สิ่งที่ควรสังเกต

- **ไม่ปลุกเกินกำหนด** ถ้าตอนถึงเวลามี turn รันอยู่ ผู้ใช้กำลังพิมพ์ หรือมีการ์ดค้าง ประตูรอจนว่าง
  ดู [การปลุกถูกพักหรือรอ](/scenarios/bg/wake-held-or-paused/)
- **ยกเลิกได้สองทาง** model เรียก `task_stop wake-1` (ได้โน้ต `stopped` และไม่ดัง) หรือผู้ใช้กด Cancel ในแผง Tasks
- **ต้องมี engine ที่มีหน้าต่างต่ออยู่** engine จบเองหลังหน้าต่างสุดท้ายปิดไป 10 วินาที ถ้าไม่มีหน้าต่างเปิดเลยตอนถึงเวลา
  การปลุกเกิดเมื่อมีหน้าต่างต่อ engine ใหม่ ซึ่งรับช่วงการปลุกที่ค้างไว้ (ภายใน 24 ชั่วโมง)
