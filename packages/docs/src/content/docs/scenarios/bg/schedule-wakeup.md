---
title: ตั้งเวลาปลุก
description: model ตั้งเวลาปลุกตัวเองพร้อมเหตุผล แล้วจบ turn เมื่อถึงเวลา engine เปิด turn ใหม่ให้ model อ่านเหตุผลนั้นแล้วทำต่อ แม้ engine จะเริ่มใหม่ระหว่างรอ
scenario:
  surface: vscode
  given:
    - การปลุกอัตโนมัติเปิดอยู่ หน้าต่างที่แสดง session นี้ยังเปิดอยู่
    - คุณเพิ่ง deploy ไป staging แล้วขอให้ตรวจ `https://staging.shop.example/health` เมื่อพร้อม ซึ่งใช้เวลาราว 10 นาที
  trigger: >-
    model เรียก `schedule_wakeup` เพื่อกลับมาตรวจ staging ทีหลัง
  covers: [bg.schedule-wakeup]
  related: [bg.monitor-wakes, bg.task-stop-or-list, bg.user-cancels-wakes, bg.scheduled-task-fires]
  steps:
    - id: wants
      beat:
        title: Model ตั้งเวลาปลุกตัวเองใน 10 นาที
        text: >-
          คุณเพิ่ง deploy ไป staging และให้ที่อยู่หน้า health ไว้ในข้อความ staging ใช้เวลาราว 10 นาทีกว่าจะพร้อม model เรียก tool `schedule_wakeup` ขอให้ Geno ปลุก session
          ใน 600 วินาที พร้อมเหตุผล "check staging health after the deploy" ปลุกคือ engine เริ่ม turn ใหม่เองโดยไม่มีใครพิมพ์
          การ์ดมาจากการบันทึกที่รัน Geno จริงกับ model จำลองที่ตอบตามบทที่เขียนไว้ก่อน ใบแรกคือ event ของ stream ที่เปิดบล็อก `tool_use` ดู `name` ว่าเป็น `schedule_wakeup`
          ใบที่สองคือชิ้นแรกของ input ที่มี `delay_s: 600` และต้นของเหตุผล
        from: model
        to: engine
        sees:
          - kind: payload
            source: packages/docs/src/data/recorded/bg-schedule-wakeup.jsonl#line=5
            select: '[4]'
            highlight: [data.content_block.name]
          - kind: payload
            source: packages/docs/src/data/recorded/bg-schedule-wakeup.jsonl#line=5
            select: '[5]'
            highlight: [data.delta.partial_json]
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
        title: Geno ตั้งนาฬิกาแล้วเตรียมผลให้ model
        text: >-
          Geno ตั้งนาฬิกาในหน่วยความจำของ engine แล้วเขียน `tool_result` ลง log ผลบอกเวลาที่จะปลุก
          และบอกให้จบ turn ตอนนี้ ผลนี้ถึง model ตอนเรียกครั้งถัดไป
        from: engine
        to: engine
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
        title: Model บอกว่าจะกลับมาตรวจ แล้วจบ turn
        text: >-
          model บอกว่าจะกลับมาตรวจในอีก 10 นาที แล้วจบ turn
          การ์ดมาจากการบันทึกเดียวกับการ์ดแรก ใบแรกคือข้อความที่ model ตอบ ใบที่สองคือท้าย stream ของคำตอบนั้น
          ดู `stop_reason` ที่ไฮไลต์ว่าเป็น `end_turn`
        from: model
        to: engine
        sees:
          - kind: message
            from: geno
            text: Staging takes about 10 minutes to come up. I will check its health in 10 minutes.
          - kind: payload
            source: packages/docs/src/data/recorded/bg-schedule-wakeup.jsonl#line=7
            select: '[-2]'
            highlight: [data.delta.stop_reason]
      lane: model
      do: >-
        model บอกผู้ใช้ว่าจะกลับมาตรวจในอีก 10 นาที แล้วจบด้วย `stop_reason: end_turn`
      ref: "packages/engine/src/gateway.ts#\"stopReason: message.stop_reason,\""
      emits: [end_turn]

    - use: bg-turn-lets-go
      beat:
        title: Geno จบ turn ปุ่ม Send กลับมา
        text: ปุ่ม Send กลับมา คุณทำอย่างอื่นต่อได้
        from: engine
        to: panel
        sees:
          kind: composer
          state: idle
          header: worked for <เวลา>

    - id: meanwhile
      beat:
        title: Tasks บอกว่ารอการปลุก
        text: >-
          ระหว่างรอ แผง Tasks (รายการงานของทุกแชตพร้อมสถานะ) บอกเวลาที่จะปลุก นาฬิกาอยู่ในหน่วยความจำของ engine
          แต่โน้ตใน log ยังอยู่ถ้า engine ตัวนี้จบไป
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
        text: >-
          Geno ลบการรอ แล้วใส่โน้ตว่าการปลุกถึงกำหนด พร้อมเหตุผล ลงกล่องข้อความของ session (คิวของสิ่งที่รอส่งให้ model)
          โน้ตนั้นถูกบันทึกลง log และปิดการปลุกนี้ไม่ให้ engine ตัวอื่นรับช่วงอีก
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
        text: >-
          model อ่านเหตุผลที่ตัวเองเขียนไว้ และข้อความว่า Geno เริ่ม turn นี้เอง แล้วเปิดหน้า health ของ staging
          การ์ดมาจากการบันทึกเดียวกับการ์ดแรก ใบแรกคือข้อความสุดท้ายของคำขอใน turn ที่ถูกปลุก ดูสองข้อความที่ไฮไลต์:
          โน้ตว่า wake-1 ถึงกำหนดพร้อมเหตุผล และข้อความว่า Geno เริ่ม turn นี้เอง (woke: scheduled)
          ใบที่สองคือ event ของ stream ที่เปิดบล็อก `tool_use` ดู `name` ว่าเป็น `web_fetch` ใบที่สามคือชิ้นแรกของ input ที่มี URL ของ staging ซึ่ง model เอามาจากข้อความของคุณ
          ในการบันทึกนี้ staging เป็นชื่อสมมติที่ไม่มีอยู่จริง `web_fetch` จึงหาเครื่องไม่เจอ และ model เล่าว่าเข้า staging ไม่ได้
          การบันทึกรันด้วยนาฬิกาที่เร็วขึ้น 600 วินาทีจึงผ่านไปในราวหนึ่งวินาที แต่ model ยังเห็นตัวเลขจริงคือ 600 วินาที
        from: model
        to: engine
        sees:
          - kind: payload
            source: packages/docs/src/data/recorded/bg-schedule-wakeup.jsonl#line=8
            select: messages[-1].content
            highlight: ['[0].text', '[1].text']
            quote: "Geno started this turn by itself (woke: scheduled)"
          - kind: payload
            source: packages/docs/src/data/recorded/bg-schedule-wakeup.jsonl#line=9
            select: '[4]'
            highlight: [data.content_block.name]
          - kind: payload
            source: packages/docs/src/data/recorded/bg-schedule-wakeup.jsonl#line=9
            select: '[5]'
            highlight: [data.delta.partial_json]
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

`schedule_wakeup` ([การปลุก](/start/glossary/)แบบตั้งเวลา) เป็นการรอแบบเดียวที่รอดการเริ่ม engine ใหม่ เพราะมันเขียนโน้ตลง log ก่อนตั้งนาฬิกา
monitor และการเฝ้า PR อยู่แค่ในหน่วยความจำ

สิ่งที่ควรสังเกต

- **อาจปลุกช้ากว่ากำหนด** ถ้าตอนถึงเวลามี turn รันอยู่ ผู้ใช้กำลังพิมพ์ หรือมีการ์ดค้าง ประตูรอจนว่าง
  ดู [การปลุกถูกพักหรือรอ](/scenarios/bg/wake-held-or-paused/)
- **ยกเลิกได้สองทาง** model เรียก `task_stop wake-1` (ได้โน้ต `stopped` และไม่ดัง) หรือผู้ใช้กด Cancel ในแผง Tasks
- **ต้องมี engine ที่มีหน้าต่างต่ออยู่** engine จบเองหลังหน้าต่างสุดท้ายปิดไป 10 วินาที ถ้าไม่มีหน้าต่างเปิดเลยตอนถึงเวลา
  การปลุกเกิดเมื่อมีหน้าต่างต่อ engine ใหม่ ซึ่งรับช่วงการปลุกที่ค้างไว้ (ภายใน 24 ชั่วโมง)
