---
title: งานตามตารางเวลาเริ่มทำงาน
description: งานที่ตั้งไว้ด้วย /schedule ถึงเวลา engine เปิด session ใหม่ให้มันในโหมด Plan หรือใน lane ของตัวเองในโหมด Auto รันจนจบภายในงบ แล้วจดผลไว้ในแผง Tasks
tableOfContents: false
sidebar:
  order: 12
scenario:
  surface: vscode
  given:
    - "ผู้ใช้ตั้งงาน \"Check outdated deps\" ไว้ด้วย `/schedule` ให้รันวันธรรมดาเวลา 09:00 แบบอ่านอย่างเดียว งบ 20 รอบ และ $0.20"
    - หน้าต่าง VS Code ของโฟลเดอร์นี้เปิดอยู่ จึงมี engine ที่มีหน้าต่างต่ออยู่
  trigger: >-
    นาฬิกาถึง 09:00 ของวันจันทร์
  covers: [bg.scheduled-task-fires]
  related: [bg.schedule-wakeup, bg.task-attention, wf.spinoff]
  steps:
    - id: look
      beat:
        title: Geno ดูงานที่ตั้งเวลาไว้
        text: engine ของหน้าต่างที่เปิดอยู่ดูไฟล์งานของ workspace อย่างน้อยทุก 60 วินาที และตั้งนาฬิกาไว้ตรงเวลาของงานถัดไป ตอนนี้ถึง 09:00 ของวันจันทร์
        from: engine
        to: engine
        ask: พร้อมรันไหม
      lane: server
      at: schedules
      do: >-
        `Scheduler` ดูไฟล์งานของ workspace (`<app home>/schedules/<hash ของ workspace>.json`) ภายใต้ lock ของไฟล์
        อย่างน้อยทุก 60 วินาที และตั้งนาฬิกาไว้ตรงเวลาของงานถัดไป `planDue` ตัดสินแต่ละงาน
      ref: packages/core/src/schedule.ts#planDue
      phase: idle
      fork:
        ask: ตอนถึงเวลาเป็นอย่างไร
        options:
          - id: ready
            label: มีหน้าต่างต่ออยู่ และรอบก่อนจบแล้ว
            then: start

          - id: no-window
            label: ไม่มีหน้าต่างเปิดอยู่เลย
            steps:
              - lane: server
                beat:
                  title: ไม่มีหน้าต่างเปิดอยู่เลย
                  text: Geno ไม่มี daemon ของระบบ engine จบเองหลังหน้าต่างสุดท้ายปิด จึงไม่มีอะไรเริ่มรอบนี้ เมื่อคุณเปิดหน้าต่าง engine ตัวใหม่ดูงานแล้วจดว่ารอบนี้พลาด
                  from: engine
                  to: engine
                at: schedules
                do: >-
                  ไม่มี engine ที่มีหน้าต่างต่อ (engine จบเองหลังหน้าต่างสุดท้ายปิด 10 วินาที) จึงไม่มีอะไรเริ่ม Geno ไม่มี daemon ของระบบ
                  เมื่อผู้ใช้เปิดหน้าต่าง engine ตัวใหม่ดูงานอีกครั้ง: ถ้ายังไม่เกิน 1 ชั่วโมงจากเวลาที่ควรรัน งานรันหนึ่งครั้งแบบสาย (catch-up)
                  ถ้าเกิน งานถูกจดว่าพลาด
                ref: packages/core/src/schedule.ts#SCHEDULE_POLICY
              - lane: panel
                beat:
                  title: Tasks บอกว่ารอบนี้พลาด
                  text: ส่วน Scheduled ในแผง Tasks แสดงรอบที่พลาด พร้อมวันและเวลา
                  from: panel
                  to: you
                  sees: "Missed Mon 12 Oct 09:00: Geno was not running"
                  end: รอบนี้พลาด
                at: tasks
                do: >-
                  ส่วน Scheduled ในแผง Tasks แสดงรอบที่พลาด พร้อมวัน วันที่ เดือน และเวลาของรอบนั้น
                sees: >-
                  "Missed Mon 12 Oct 09:00: Geno was not running"
                ref: packages/extension/src/chat/schedule-model.ts#scheduleRowOf
                end: { turn: none }

          - id: busy
            label: รอบก่อนยังรันอยู่
            steps:
              - lane: server
                beat:
                  title: รอบก่อนยังรันอยู่
                  text: รอบวันศุกร์ยังไม่จบ Geno ไม่ซ้อนรอบ มันจดว่ารอบนี้พลาดเพราะรอบก่อนยังรัน
                  from: engine
                  to: engine
                at: schedules
                do: >-
                  รอบก่อนหน้า (รอบวันศุกร์) ยังไม่จบ (`hasOpenRun`) รอบนี้ไม่ซ้อน `planDue` ตัดสินว่าพลาดเพราะรอบก่อนยังรัน
                  แล้ว `Scheduler.settle` จดรอบที่พลาดลงไฟล์งาน
                ref: packages/engine/src/schedules.ts#Scheduler.settle
              - lane: panel
                beat:
                  title: Tasks บอกว่ารอบนี้พลาด
                  text: ส่วน Scheduled แสดงรอบที่พลาด พร้อมวันและเวลา
                  from: panel
                  to: you
                  sees: "Missed Mon 12 Oct 09:00: the last run still ran"
                  end: รอบนี้พลาด
                at: tasks
                do: >-
                  ส่วน Scheduled แสดงรอบที่พลาด พร้อมวัน วันที่ เดือน และเวลาของรอบนั้น
                sees: >-
                  "Missed Mon 12 Oct 09:00: the last run still ran"
                ref: packages/extension/src/chat/schedule-model.ts#scheduleRowOf
                end: { turn: none }

    - id: start
      beat:
        title: Geno เริ่มรอบ 09:00
        text: engine ของหน้าต่างที่ต่ออยู่เริ่มรอบ แล้วจดลงไฟล์งานว่ารอบนี้เริ่มแล้วแต่ยังไม่จบ
        from: engine
        to: engine
      lane: server
      at: schedules
      do: >-
        งานถึงเวลาและมีหน้าต่างต่ออยู่ `Scheduler` ใช้ engine ของหน้าต่างนั้นเริ่มรอบ แล้วจดรอบลงไฟล์ (`ran`, ยังไม่มี `end`)
      ref: packages/engine/src/schedules.ts#Scheduler
      emits: [ran]

    - id: session
      beat:
        title: Geno เปิด session ใหม่ในโหมด Plan
        text: งานอ่านอย่างเดียวรันใน checkout หลักโหมด Plan งานที่แก้ไฟล์ได้จะได้ lane ใหม่และโหมด Auto ขีดจำกัดของ turn คืองบของงาน
        from: engine
        to: engine
      lane: server
      at: sessions
      do: >-
        `startScheduled` เปิด session ใหม่ชื่อตามงาน งานอ่านอย่างเดียวรันใน checkout หลักโหมด Plan
        (งานที่แก้ไฟล์ได้ lane ใหม่และรันโหมด Auto) ขีดจำกัดของ turn คืองบของงาน ไม่ใช่ 40 ครั้งและ $0.40 ของ `gcode serve`
        ในทัวร์นี้คือเรียก model ได้ 20 ครั้ง และ $0.20 การตรวจขีดจำกัดก่อนเรียก model แต่ละครั้งในขั้นถัดไปใช้ตัวเลขนี้
      ref: "packages/engine/src/serve.ts#\"const startScheduled = async (workspace: string, task: ScheduledTask) => {\""
      phase: starting

    - id: tools
      beat:
        title: รอบนี้ไม่มีใครตอบคำถาม
        text: รอบตามตารางไม่มี tool ถามคุณ ไม่ขยับ editor และตั้งงานใหม่ไม่ได้ ข้อความแรกบอก model ว่าไม่มีใครอ่านจนกว่ารอบจะจบ แผง Tasks ขึ้นงานใหม่ใน Working
        from: panel
        to: you
        sees: งาน "Check outdated deps" ใน Working และแถว Scheduled "Running since Mon 12 Oct 09:00"
      lane: loop
      at: agent
      do: >-
        `runAgent` ของรอบตามตารางไม่มี `ask_user` และ `remember` ไม่ขยับ editor ไม่เปิด terminal และไม่มี tool schedule หรือ workflow
        ข้อความแรกบอก model ว่าไม่มีใครอ่านจนกว่าจะจบ ไม่มีใครตอบคำถาม ให้ทำตามที่ขอแล้วจบด้วยรายงานสั้นๆ
      ref: packages/core/src/schedule.ts#SCHEDULED_RUN_NOTE

    - id: running
      lane: panel
      at: tasks
      alongside: true
      do: >-
        แผง Tasks มีงานใหม่ใน Working และส่วน Scheduled บอกว่ารอบนี้กำลังรัน
      sees: >-
        งาน "Check outdated deps" ใน Working และแถว Scheduled "Running since Mon 12 Oct 09:00"
      ref: packages/extension/src/chat/schedule-model.ts#scheduleRowOf

    - use: model-call

    - id: works
      beat:
        title: Model ตรวจ dependency แล้วเขียนรายงาน
        text: model ใช้ tool อ่านที่โหมด Plan ยอม แล้วเขียนรายงานสั้นๆ ว่ามีอะไรล้าสมัย turn จบแบบ done
        from: model
        to: engine
      lane: model
      do: >-
        model ทำตาม prompt ด้วย tool อ่านที่โหมด Plan ยอม (ทัวร์นี้ย่อรอบของ tool ไว้) แล้วเขียนรายงานสั้นๆ ว่ามีอะไรล้าสมัย
        จบด้วย `stop_reason: end_turn`
      ref: "packages/engine/src/gateway.ts#\"stopReason: message.stop_reason,\""
      emits: [end_turn]

    - id: done
      lane: loop
      at: step
      do: >-
        `loopStep` ตัดสิน `done(end_turn)` turn ของรอบนี้จบแบบ `done`
      ref: packages/core/src/loop.ts#AFTER_STOP
      emits: [end_turn]
      phase: ending

    - id: recorded
      beat:
        title: Geno จดผลของรอบ
        text: Geno อ่านผลจาก log ของ session แล้วจดผลและค่าใช้จ่ายลงไฟล์งาน ทุกหน้าต่างเห็น คลิกแถวเพื่อเปิด session ของรอบนั้นและอ่านรายงาน
        from: engine
        to: panel
        sees: "Last run Mon 12 Oct 09:00: Done · $0.03"
        end: รอบจบ ผลอยู่ใน Tasks
      lane: server
      at: schedules
      do: >-
        `runEndOf` อ่านผลจาก log ของ session แล้ว `Scheduler` จดจุดจบของรอบ (ผลและค่าใช้จ่าย) ลงไฟล์
        ทุกหน้าต่างได้ `_gcode/schedulesUpdate`
      ref: packages/core/src/schedule.ts#runEndOf
      emits: [_gcode/schedulesUpdate]

    - id: shown
      lane: panel
      at: tasks
      do: >-
        แถว Scheduled แสดงรอบล่าสุด คลิกเปิด session ของรอบนั้นเพื่ออ่านรายงาน งานของรอบย้ายไปส่วนที่จบแล้ว
      sees: >-
        "Last run Mon 12 Oct 09:00: Done · $0.03"
      ref: packages/extension/src/chat/schedule-model.ts#scheduleRowOf
      end: { turn: done, reason: end_turn }
---

ไฟล์งานตามตารางเวลาคือความจริงหนึ่งเดียว มันอยู่นอก engine จึงรอดการเริ่ม engine ใหม่
แต่สิ่งที่เริ่มรอบได้มีแค่ engine ที่มีหน้าต่าง VS Code ต่ออยู่ Geno ไม่ลงทะเบียน daemon ของระบบ

สิ่งที่ควรสังเกต

- **รายงานไม่ไปที่แชตไหน** รอบตามตารางเป็น session แยก ผลอยู่ใน session นั้นและในแถว Scheduled ไม่ปลุกแชตที่ตั้งงาน
- **รอบที่ engine ตายระหว่างรัน** ถูกปิดเป็น failed ครั้งถัดไปที่ `Scheduler` ดูไฟล์ เพื่อไม่ให้มันขวางรอบต่อไปตลอด
- **ไม่ซ้อนกัน** งานเดียวกันมีรอบที่รันอยู่ได้ทีละรอบ รอบที่ถึงเวลาระหว่างนั้นถูกจดว่าพลาด
