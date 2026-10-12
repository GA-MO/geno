---
title: เฝ้าดู CI ของ PR
description: โมเดลเรียก watch_pr หลัง push engine ถาม gh เป็นระยะจนทุก check จบ แล้วปลุก session พร้อมรายงานและ log ของ check ที่ล้ม
tableOfContents: false
sidebar:
  order: 6
scenario:
  surface: vscode
  given:
    - การปลุกอัตโนมัติเปิดอยู่ ติดตั้งและล็อกอิน `gh` แล้ว branch ปัจจุบันมี PR #42 บน GitHub
    - โมเดลเพิ่ง push commit ใหม่ CI กำลังรัน
  trigger: >-
    โมเดลเรียก `watch_pr` เพื่อรอผล CI
  covers: [bg.watch-pr]
  related: [bg.monitor-wakes, bg.schedule-wakeup, bg.user-cancels-wakes]
  steps:
    - id: wants
      beat:
        title: Model ขอเฝ้า CI หลัง push
        text: model เพิ่ง push commit ใหม่ มันเรียก `watch_pr` เพื่อรอผล CI โดยไม่ต้องวนถาม เฝ้าได้นานสุด 1 ชั่วโมงตามค่าเริ่มต้น
        to: engine
      lane: model
      do: >-
        โมเดลขอเรียก `watch_pr` (เฝ้าได้นานสุดตามค่าเริ่มต้น 1 ชั่วโมง ตั้งได้ถึง 2 ชั่วโมง) จบคำตอบด้วย `stop_reason: tool_use`
      ref: packages/engine/src/tools/pr.ts#watchPrExecutor
      emits: [tool_use, watch_pr]
      phase: calling-model

    - use: tool-call-opens

    - id: look
      beat:
        title: Geno ถาม `gh` หนึ่งครั้ง
        text: Geno ประกอบคำสั่ง `gh` เองทั้งหมด ไม่มีข้อความจาก model หรือจาก log เข้าไปในคำสั่ง
        to: machine
        ask: CI จบหรือยัง
      lane: tool
      at: executor
      do: >-
        executor ถาม `gh` หนึ่งครั้งด้วย argv ที่ประกอบเองทั้งชุด (`gh pr view --json ...` และ `gh pr checks --json ...`)
        ไม่มีข้อความจากโมเดลหรือจาก log เข้าไปใน argv
      ref: packages/engine/src/gh.ts#lookUpPr
      fork:
        ask: CI เป็นอย่างไรตอนดูครั้งแรก
        options:
          - id: running
            label: ยังรันอยู่
            then: watch

          - id: settled
            label: จบแล้ว หรือ PR ปิดแล้ว
            steps:
              - lane: external
                beat:
                  title: CI จบแล้ว ไม่ต้องรอ
                  text: Geno เขียนรายงาน แนบ log ท้ายของ check ที่ล้มไม่เกิน 2 ตัว แล้วบอกว่าไม่ได้ตั้งอะไรรอ
                  from: machine
                do: >-
                  ไม่มีอะไรต้องรอ `prReport` เขียนรายงาน (ถ้ามี check ล้ม แนบ log ท้ายของไม่เกิน 2 ตัว) ต่อด้วย "Nothing was set up to wait for."
                  ถ้า `gh` ใช้ไม่ได้หรือหา PR ไม่เจอ call ได้ error แทน
                ref: packages/engine/src/gh.ts#prReport
              - use: tool-result-returns
              - lane: loop
                beat:
                  title: Model อ่านผล CI ใน turn เดิม
                  text: turn ไม่ต้องจบ model อ่านผลแล้วทำต่อ
                  to: model
                  end: Turn ทำต่อ
                at: step
                do: >-
                  `loopStep` ตัดสิน `call-model` โมเดลอ่านผล CI ใน turn เดิม
                ref: packages/core/src/loop.ts#loopStep
                emits: [call-model]
                phase: calling-model
                end: { turn: continues, reason: call-model }

    - id: watch
      beat:
        title: Geno ตั้งการเฝ้า `wake-1`
        text: ถ้า PR นี้ถูกเฝ้าอยู่แล้ว Geno ไม่เริ่มซ้ำ ผลของ call บอกจำนวน check ที่ยังรัน และบอกให้จบ turn
        to: model
      lane: server
      at: wakes
      do: >-
        ถ้า PR นี้ถูกเฝ้าอยู่แล้ว ไม่เริ่มซ้ำ ไม่อย่างนั้น `Wakes.pr` จดการเฝ้า `wake-1` แล้วตั้งเวลาถามรอบถัดไป
        ผลของ call บอกจำนวน check ที่ยังรันและ "Watching its checks as wake-1 for up to 3600s, polling every 60 to 90s.
        End your turn now: Geno wakes you when every check has finished, with the failing logs."
      ref: packages/core/src/pr.ts#prWatchingText
      emits: [wake-1]

    - use: tool-result-returns
    - use: model-call

    - id: says
      beat:
        title: Model บอกว่ารอ CI แล้ว turn จบ
        text: "model บอกคุณว่ากำลังรอ CI ของ PR #42 แผง Tasks บอกว่า session รออะไร"
        to: panel
        sees: แถวของ session บอก "Wakes on ..." พร้อมปุ่ม [Cancel]
      lane: model
      do: >-
        โมเดลบอกผู้ใช้ว่ากำลังรอ CI ของ PR #42 แล้วจบด้วย `stop_reason: end_turn`
      ref: "packages/engine/src/gateway.ts#\"stopReason: message.stop_reason,\""
      emits: [end_turn]

    - use: bg-turn-lets-go

    - id: polls
      beat:
        title: Geno ถาม `gh` เป็นระยะ
        text: ทุก 60 วินาทีใน 10 นาทีแรก แล้วทุก 90 วินาที CI จบเมื่อมี check และไม่มีตัวไหน pending
        from: engine
        to: machine
      lane: external
      do: >-
        `Wakes.pr` ถาม `gh` ทุก 60 วินาทีใน 10 นาทีแรก แล้วทุก 90 วินาที `nextPrWatch` ตัดสินแต่ละรอบ:
        CI จบเมื่อมี check และไม่มีตัวไหน pending ถ้าหา check ไม่เจอ 3 รอบติด หรือ `gh` ล้ม 3 รอบติด การเฝ้าจบเช่นกัน
      ref: packages/core/src/pr.ts#nextPrWatch

    - id: report
      beat:
        title: CI จบ มี check ล้ม
        text: Geno เขียนรายงานพร้อม log ท้ายของ check ที่ล้ม แล้วใส่โน้ตลงกล่องข้อความของ session
      lane: server
      at: wakes
      do: >-
        check สุดท้ายจบ มีตัวหนึ่งล้ม `prReport` เขียนรายงานพร้อม log ท้ายของ check ที่ล้ม (ไม่เกิน 50 บรรทัด 4,000 ตัวอักษรต่อตัว)
        แล้ว `Wakes.pr` ใส่โน้ต `wake` ชนิด `pr` ผล `failed` ลงกล่องข้อความของ session โน้ตนี้ถูกบันทึกลง log เป็น event `wake` ในขั้นถัดไป
      ref: packages/engine/src/wakes.ts#Wakes.pr
      emits: [wake, pr, failed]

    - use: bg-wake-starts
      beat:
        title: Geno ปลุก session
        text: แชตเปิด turn ใหม่ที่หัวมีกระดิ่งกับเหตุที่ปลุก
        sees: 'กระดิ่งกับ "woke: CI failed" หัวข้อ "working" และปุ่ม Stop'
    - use: model-call

    - id: reads
      beat:
        title: Model เปิดไฟล์ที่ทำให้เทสต์ล้ม
        text: model อ่านรายงานและ log ของ check ที่ล้ม แล้วเปิดไฟล์ที่เกี่ยวข้อง และเล่าสาเหตุให้คุณ
        end: Turn ที่ถูกปลุกจบ
      lane: model
      do: >-
        หัวของ turn บอก "woke: CI failed" โมเดลอ่าน "PR watch wake-1 ended." ตามด้วยรายงานและ log ของ check ที่ล้ม
        แล้วเปิดไฟล์ที่ทำให้เทสต์ล้ม เล่าสาเหตุให้ผู้ใช้ และจบด้วย `stop_reason: end_turn`
      ref: packages/core/src/wake.ts#wakeNoteText
      emits: [end_turn]
      phase: calling-model

    - use: bg-woken-ends
---

`watch_pr` ใช้ `gh` ที่ผู้ใช้ล็อกอินไว้ อ่านอย่างเดียว และ engine เป็นคนถามซ้ำ ไม่ใช่โมเดล
โมเดลจึงไม่ต้องวนรอและไม่เสียค่าเรียกโมเดลระหว่าง CI รัน

| CI จบแบบ | ป้ายบนหัวของ turn |
| --- | --- |
| ทุก check ผ่าน | "woke: CI passed" |
| มี check ล้มหรือถูกยกเลิก | "woke: CI failed" |
| หมดเวลา PR ปิด ไม่มี check หรือ `gh` ล้มซ้ำ | "woke: PR watch ended" |

สิ่งที่ควรสังเกต

- **เฝ้า PR เดียวกันซ้ำไม่ได้** `watch_pr` ครั้งที่สองของ PR เดิมได้ผลว่าเฝ้าอยู่แล้วเป็น `wake-1`
- **ไม่รอดการเริ่ม engine ใหม่** (อ่านจากโค้ด) การเฝ้าอยู่ในหน่วยความจำของ engine เหมือน monitor
- **CLI ไม่มีการปลุก** ใน `gcode agent` `watch_pr` ได้ error ที่แนะนำให้ผู้ใช้รัน `gh pr checks --watch` เอง
