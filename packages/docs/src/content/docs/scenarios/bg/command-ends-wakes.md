---
title: คำสั่งเบื้องหลังจบแล้วปลุก
description: โมเดลรัน build แบบเบื้องหลัง เมื่อคำสั่งจบ โมเดลได้รู้ที่จุดปลอดภัยถ้า turn ยังรัน หรือ engine เปิด turn ใหม่ให้ถ้า turn จบไปแล้ว
tableOfContents: false
sidebar:
  order: 2
scenario:
  surface: vscode
  given:
    - เปิด Geno ในโหมด Ask การปลุกอัตโนมัติเปิดอยู่ และหน้าต่างที่แสดง session นี้ยังเปิดอยู่
    - กฎของ workspace อนุญาต `pnpm build` ไว้แล้ว จึงไม่ขึ้นการ์ด
  trigger: >-
    โมเดลขอรัน `bash` ด้วย `pnpm build` และ `run_in_background: true`
  covers: [bg.command-ends-wakes]
  related: [bg.child-wakes-parent, bg.monitor-wakes, bg.task-stop-or-list, tool.bash-background]
  steps:
    - use: tool-call-opens

    - id: approve
      lane: policy
      at: rules
      do: >-
        `approveCommand` ตรวจคำสั่งเบื้องหลังด้วยกฎชุดเดียวกับคำสั่งปกติ (ในโหมด Plan คำสั่งเบื้องหลังถูกปฏิเสธทันที)
        กฎ allow ของ workspace ครอบคลุม `pnpm build` จึงผ่าน
      ref: packages/core/src/permission-rules.ts#ruledDenial

    - id: start
      lane: tool
      at: shell
      do: >-
        `BackgroundJobs.start` ให้ id `bg-1` (session หนึ่งรันได้พร้อมกันไม่เกิน 4 ตัว) เริ่มคำสั่งใน sandbox
        และเขียนผลทั้งหมดลงไฟล์ `background/bg-1.log` ในโฟลเดอร์ spill ของ session แล้วคืนผลทันทีโดยไม่รอคำสั่งจบ
      ref: packages/engine/src/background.ts#BackgroundJobs.start
      emits: [Started background command]

    - id: shown
      lane: server
      at: updates
      do: >-
        ทุกครั้งที่งานเปลี่ยน `backgroundUpdate` ส่ง `tool_call_update` ที่มี `BACKGROUND_META` ให้ขั้นของ `bash`
        และงานในแผง Tasks แสดงคำสั่งที่รันอยู่
      ref: packages/engine/src/session-replay.ts#backgroundUpdate
      emits: [tool_call_update, BACKGROUND_META]

    - use: tool-result-returns

    - id: when
      lane: tool
      at: shell
      do: >-
        `pnpm build` รันต่อไปเรื่อยๆ ขณะที่ loop ทำงานอื่น
      ref: packages/engine/src/background.ts#BackgroundJobs.start
      fork:
        ask: build จบตอนไหน
        options:
          - id: mid-turn
            label: ระหว่างที่ turn ยังรัน
            steps:
              - lane: loop
                at: step
                do: >-
                  `loopStep` ตัดสิน `call-model` โมเดลอ่านว่า bg-1 เริ่มแล้ว และทำงานอื่นต่อ เช่นแก้เอกสาร
                ref: packages/core/src/loop.ts#loopStep
                emits: [call-model]
                phase: calling-model
              - lane: tool
                at: shell
                do: >-
                  ระหว่างนั้น build จบด้วย exit code 0 งานส่ง `background-end` พร้อมท้ายของผลเข้ากล่องข้อความของ session
                  (คำสั่งที่จบเองและคำสั่งที่ผู้ใช้หยุดเท่านั้นที่บอกโมเดล)
                ref: packages/core/src/background.ts#TELLS_MODEL
                emits: [background-end]
              - lane: loop
                at: drive
                do: >-
                  ที่จุดปลอดภัยก่อนเรียกโมเดลครั้งถัดไป `deliver()` บันทึก event `background-end` ลง log
                  และวนอีกรอบก่อนเรียกโมเดล เพื่อให้ `loopStep` เห็น log ใหม่
                ref: packages/engine/src/drive.ts#deliver
                emits: [background-end]
              - lane: model
                do: >-
                  คำขอถัดไปมีโน้ตว่า "Background command bg-1 (`pnpm build`) exited with code 0." พร้อมที่อยู่ไฟล์ผลและท้ายของผล
                  ที่ล้อมไว้เป็นข้อมูล โมเดลทำงานต่อโดยรู้ว่า build ผ่าน
                ref: packages/core/src/background.ts#backgroundEndNotice
                end: { turn: continues }

          - id: after-turn
            label: หลัง turn จบแล้ว
            steps:
              - lane: model
                do: >-
                  โมเดลบอกผู้ใช้ว่า build กำลังรันและจะแจ้งเมื่อเสร็จ แล้วจบด้วย `stop_reason: end_turn`
                  (system prompt บอกให้จบ turn แทนการคอยถามสถานะ เพราะ Geno จะเริ่ม turn ถัดไปให้เอง)
                ref: "packages/engine/src/gateway.ts#\"stopReason: message.stop_reason,\""
                emits: [end_turn]
                phase: calling-model
              - lane: loop
                at: step
                do: >-
                  `loopStep` ตัดสิน `done(end_turn)` turn จบแบบ done คำสั่งเบื้องหลังไม่ถือ turn ไว้ และ engine ไม่ฆ่ามันตอนจบ turn
                ref: packages/core/src/loop.ts#AFTER_STOP
                emits: [end_turn]
                phase: idle
              - lane: tool
                at: shell
                runs: 0
                do: >-
                  หลายนาทีต่อมา build จบด้วย exit code 0 งานส่ง `background-end` เข้ากล่องข้อความของ session
                ref: packages/core/src/background.ts#TELLS_MODEL
                emits: [background-end]
              - lane: server
                at: wakes
                do: >-
                  ไม่มี turn รันอยู่ `logArrivals` จึงบันทึก event `background-end` ลง log ทันที แล้ว `wakeGate` รอ 2 วินาที
                  ไม่มีการ์ดค้าง ผู้ใช้ไม่ได้พิมพ์ จึงปลุก `logWake` เปิด turn ด้วยข้อความจาก engine เป็น event `user` ที่มี `from: 'wake'`
                  (การจบของคำสั่งไม่มี event `wake` ของตัวเอง) แล้ว `runTurn` ส่งข้อความนั้นพร้อม `WAKE_META`
                ref: packages/engine/src/background-hooks.ts#logArrivals
                emits: [background-end, user, WAKE_META]
                phase: starting
              - lane: panel
                at: rail
                do: แผงเปิด turn ใหม่ที่หัวมีกระดิ่งแทนข้อความของผู้ใช้
                sees: >-
                  กระดิ่งกับ "woke: 1 task finished" หัวข้อ "working"
                ref: packages/extension/src/chat/render.ts#turnHead
              - lane: model
                do: >-
                  โมเดลอ่านโน้ตของ bg-1 ตามด้วยข้อความว่า Geno เริ่ม turn นี้เอง แล้วเล่าผล build ให้ผู้ใช้
                ref: packages/core/src/background.ts#backgroundEndNotice
                phase: calling-model
                end: { turn: continues }
---

คำสั่งเบื้องหลังต่างจากลูกเบื้องหลังตรงที่ไม่มีหนี้รายงาน: turn ไม่ถูกถือไว้รอ และโมเดลไม่ต้องรอผล
ถ้าคำสั่งจบ โมเดลจะได้รู้เสมอ ไม่ว่าจะระหว่าง turn หรือหลังจากนั้น

สิ่งที่ควรสังเกต

- **คำสั่งที่ผู้ใช้หยุดไม่ปลุก** โมเดลได้รู้ใน turn ถัดไปของผู้ใช้ แต่ไม่มี turn ที่ถูกปลุก เพราะผู้ใช้รู้อยู่แล้ว
- **dev server ไม่ปลุก** คำสั่งที่เป็น preview ของ dev server ตั้งใจให้รันต่อ การจบของมันไปกับ turn ถัดไปแทน
- **ผลยาวไม่เข้า context ทั้งหมด** โน้ตมีแค่ท้ายของผล ที่เหลืออยู่ในไฟล์ `bg-1.log` ให้อ่านด้วย `bash_output` หรือ `read`
- **ใน CLI ไม่มีการปลุก** `gcode agent` ฆ่าคำสั่งเบื้องหลังเมื่อรอบจบ
