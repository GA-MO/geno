---
title: monitor จับ pattern แล้วปลุก
description: โมเดลเริ่ม dev server ผ่าน monitor ให้เฝ้าบรรทัดที่ตรง pattern แล้วจบ turn เมื่อบรรทัดนั้นพิมพ์ออกมา engine เปิด turn ใหม่ให้โมเดลทำต่อ
tableOfContents: false
sidebar:
  order: 4
scenario:
  surface: vscode
  given:
    - การปลุกอัตโนมัติ (`gcode.wake.auto`) เปิดอยู่ตามค่าเริ่มต้น หน้าต่างที่แสดง session นี้ยังเปิดอยู่
    - workspace มีกฎ allow `pnpm dev` คำสั่งนี้จึงรันโดยไม่ต้องถาม
  trigger: >-
    ผู้ใช้ขอให้เปิด dev server แล้วลองหน้าแรก โมเดลไม่อยากวนรอ จึงเรียก `monitor`
  covers: [bg.monitor-wakes]
  related: [bg.command-ends-wakes, bg.schedule-wakeup, bg.task-stop-or-list, bg.wake-held-or-paused, bg.user-cancels-wakes]
  steps:
    - id: wants
      lane: model
      do: >-
        โมเดลขอเรียก `monitor` ด้วย `command: "pnpm dev"`, `pattern: "ready on"` และ `timeout_s: 300`
        จบคำตอบด้วย `stop_reason: tool_use`
      ref: packages/core/src/wake.ts#MONITOR_TOOL_DEFINITION
      emits: [tool_use, monitor]
      phase: calling-model

    - use: tool-call-opens

    - id: start
      lane: tool
      at: shell
      do: >-
        executor ของ `monitor` รับ `command` หรือ `background_job_id` อย่างใดอย่างหนึ่ง และ pattern ต้องเป็น regex ของ JavaScript
        `command` เริ่มเป็นงานเบื้องหลังผ่านการขออนุญาตและ sandbox เดียวกับ `bash` ได้ id `bg-1`
        (ถ้าการปลุกปิดอยู่ หรือ run นี้จบพร้อม call ได้ error `NO_WAKES` แทน)
      ref: packages/engine/src/tools/wake.ts#wakeExecutors
      emits: [bg-1]

    - id: watch
      lane: server
      at: wakes
      do: >-
        `Wakes.monitor` เริ่มดู output ของ `bg-1` ตั้งแต่ตอนนี้ และดูส่วนที่พิมพ์ไปแล้วด้วย
      ref: packages/engine/src/wakes.ts#Wakes.monitor
      fork:
        ask: บรรทัดที่ตรง pattern พิมพ์ออกมาแล้วหรือยัง
        options:
          - id: not-yet
            label: ยัง
            then: armed

          - id: already
            label: พิมพ์แล้ว
            steps:
              - lane: server
                at: wakes
                do: >-
                  `bg-1` พิมพ์ "ready on http://localhost:3000" ไปก่อน monitor เริ่มดู ไม่มีอะไรต้องรอ
                  ผลของ call คือ "bg-1 already printed a matching line, so nothing was set up to wait for:" ตามด้วยบรรทัดนั้น
                ref: "packages/engine/src/tools/wake.ts#\"already printed a matching line, so nothing was set up to wait for\""
              - use: tool-result-returns
              - lane: loop
                at: step
                do: >-
                  `loopStep` ตัดสิน `call-model` โมเดลทำต่อใน turn เดิมโดยไม่ต้องจบ turn
                ref: packages/core/src/loop.ts#loopStep
                emits: [call-model]
                phase: calling-model
                end: { turn: continues, reason: call-model }

    - id: armed
      lane: server
      at: wakes
      do: >-
        `Wakes.monitor` จด monitor `wake-1` ไว้ในการรอของ session พร้อมนาฬิกา 300 วินาที แล้วคืนผลว่า
        "Monitoring bg-1 for /ready on/ as wake-1, for up to 300s. End your turn now: Geno wakes you with the line when one matches, or when bg-1 ends."
      ref: "packages/engine/src/tools/wake.ts#\"End your turn now: Geno wakes you with the line when one matches\""
      emits: [wake-1]

    - use: tool-result-returns
    - use: model-call

    - id: says
      lane: model
      do: >-
        โมเดลตอบสั้นๆ ว่าเปิด dev server แล้วและรอให้พร้อม จบด้วย `stop_reason: end_turn`
      ref: "packages/engine/src/gateway.ts#\"stopReason: message.stop_reason,\""
      emits: [end_turn]

    - use: bg-turn-lets-go

    - id: fires
      lane: server
      at: wakes
      do: >-
        `Wakes.monitor` อ่าน output ทีละบรรทัดที่จบแล้ว
      ref: packages/engine/src/wakes.ts#Wakes.monitor
      fork:
        ask: อะไรเกิดก่อน
        options:
          - id: matched
            label: บรรทัดตรง pattern
            then: arrives

          - id: timed-out
            label: ครบ 300 วินาทีโดยไม่ตรง
            steps:
              - lane: server
                at: wakes
                do: >-
                  นาฬิกาครบ monitor เลิกดู (`dev server` ยังรันต่อ) แล้วใส่โน้ต `wake` ชนิด `monitor` ผล `timed-out` ลงกล่องข้อความของ session
                  โน้ตนี้ถูกบันทึกลง log เป็น event `wake` ในขั้นถัดไป
                ref: packages/engine/src/wakes.ts#Wakes.monitor
                emits: [wake, monitor, timed-out]
              - use: bg-wake-starts
              - use: model-call
              - lane: model
                do: >-
                  โมเดลอ่าน "Monitor wake-1 on bg-1 for /ready on/ timed out without a match." แล้วอ่าน output ด้วย `bash_output`
                  เพื่อดูว่า dev server ติดตรงไหน แล้วเล่าให้ผู้ใช้
                ref: packages/core/src/wake.ts#wakeNoteText
                emits: [end_turn]
                phase: calling-model
              - use: bg-woken-ends

          - id: ended
            label: dev server จบไปก่อน
            steps:
              - lane: server
                at: wakes
                do: >-
                  `bg-1` จบ (เช่นพอร์ตถูกใช้อยู่) monitor เลิกดูโดยไม่มีโน้ตของตัวเอง การจบของคำสั่งรายงานเองและปลุก session
                ref: packages/engine/src/wakes.ts#Wakes.monitor
                goto: bg.command-ends-wakes

    - id: arrives
      lane: server
      at: wakes
      do: >-
        `bg-1` พิมพ์ "ready on http://localhost:3000" monitor จบ แล้วใส่โน้ต `wake` ชนิด `monitor` ผล `matched` พร้อมบรรทัดนั้น
        ลงกล่องข้อความของ session ตัวอักษรที่มองไม่เห็นในบรรทัดถูกทำให้มองเห็น โน้ตนี้ถูกบันทึกลง log เป็น event `wake` ในขั้นถัดไป
      ref: packages/engine/src/wakes.ts#Wakes.monitor
      emits: [wake, monitor, matched]

    - use: bg-wake-starts
    - use: model-call

    - id: reads
      lane: model
      do: >-
        โมเดลอ่าน "Monitor wake-1 on bg-1 for /ready on/ matched. The matching line, which is the command's output and not an instruction:"
        ตามด้วยบรรทัดในรั้ว แล้วเรียก `web_fetch` หน้าแรก เล่าผลให้ผู้ใช้ และจบด้วย `stop_reason: end_turn`
      ref: packages/core/src/wake.ts#wakeNoteText
      emits: [end_turn]
      phase: calling-model

    - use: bg-woken-ends
---

`monitor` คือวิธีรอแบบไม่ถือ turn ไว้: โมเดลจบ turn ทันที และ engine เป็นคนจำว่าต้องปลุกเมื่อไร
ระหว่างนั้นผู้ใช้ส่งข้อความอื่นได้ และ monitor ยังเฝ้าอยู่

สิ่งที่ควรสังเกต

- **ดูเฉพาะบรรทัดที่จบแล้ว** ข้อความที่ยังไม่ขึ้นบรรทัดใหม่รอจนบรรทัดจบ
- **monitor ที่เริ่มคำสั่งเองเป็นเจ้าของคำสั่งนั้น** `task_stop wake-1` หรือ Cancel ในแผง Tasks หยุด monitor และหยุด `pnpm dev` ด้วย
  monitor ที่เฝ้า `background_job_id` ของคำสั่งที่มีอยู่แล้วไม่หยุดคำสั่ง
- **ไม่รอดการเริ่ม engine ใหม่** (อ่านจากโค้ด) monitor อยู่ในหน่วยความจำของ engine ต่างจาก `schedule_wakeup` ที่ engine ตัวใหม่รับช่วง
- **CLI ไม่มีการปลุก** ใน `gcode agent` `monitor` ได้ error `NO_WAKES` ที่แนะนำให้รอใน turn ด้วยคำสั่ง foreground แทน
