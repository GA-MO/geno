---
title: แสดงหรือหยุดงานเบื้องหลัง
description: model เรียก list_agents ดูว่า session มีลูก คำสั่ง และการรออะไรค้างอยู่ แล้วเรียก task_stop หยุดตัวที่ไม่ต้องการแล้ว
scenario:
  surface: vscode
  given:
    - ใน turn นี้ model เริ่มลูก `explore` แบบเบื้องหลัง เริ่ม `pnpm dev` เป็น `bg-1` และตั้ง `schedule_wakeup` เป็น `wake-1` ไว้แล้ว
    - ผู้ใช้เพิ่งบอกว่าไม่ต้องสำรวจต่อแล้ว เพราะเจอคำตอบเอง
  trigger: >-
    model ต้องการรู้ว่ามีอะไรค้างอยู่ก่อนจะหยุด จึงเรียก `list_agents`
  covers: [bg.task-stop-or-list]
  related: [bg.monitor-wakes, bg.schedule-wakeup, sub.user-cancels-child, bg.user-cancels-wakes]
  steps:
    - id: lists
      beat:
        title: Model ขอดูว่ามีอะไรค้างอยู่
        text: >-
          คุณบอกว่าไม่ต้องสำรวจต่อแล้ว ก่อนหยุดอะไร model เรียก `list_agents` เพื่อดูของที่ค้าง คือ subagent
          (session ลูกที่ model สร้างไว้ทำงานย่อย) คำสั่งเบื้องหลัง และสิ่งที่ตั้งไว้ให้ปลุก session ทีหลัง
          (ปลุกคือ engine เริ่ม turn ใหม่เอง) การ์ดข้างล่างเป็นคำตอบจริงจากการรันหนึ่งที่ model เรียก `list_agents` ก่อนหยุด dev server
          บล็อกที่ไฮไลต์คือ `tool_use` ของ `list_agents` ซึ่งไม่มี input
        from: model
        to: engine
        sees:
          kind: payload
          source: docs/results/real-usecases/runs/A12-background-server/fix-s3-2/session.jsonl#seq=46
          select: content
          collapse: ['[0].thinking']
          highlight: ['[1]']
      lane: model
      do: >-
        model ขอเรียก `list_agents` ซึ่งไม่มี input จบคำตอบด้วย `stop_reason: tool_use`
      ref: packages/core/src/work.ts#LIST_AGENTS_TOOL_DEFINITION
      emits: [tool_use, list_agents]
      phase: calling-model

    - use: tool-call-opens

    - id: rows
      beat:
        title: Geno รวบรวมลูก คำสั่ง และการรอ
        text: >-
          Geno อ่านอย่างเดียว: subagent จาก log คำสั่งเบื้องหลัง และการรอที่ยังค้าง ได้แก่ monitor (การเฝ้า output ของคำสั่งจนเจอบรรทัดที่ต้องการ) การปลุกตามเวลา (wake-up)
          และการเฝ้า PR แล้วเขียนรายการเป็น `tool_result` ลง log ผลนี้ถึง model ตอนเรียกครั้งถัดไป
          การ์ดข้างล่างเป็นผลจริงจากการรันเดียวกับการ์ดก่อนหน้า ข้อความที่ไฮไลต์มีแค่คำสั่ง `bg-1` (แท็บแรก) และจบด้วยคำแนะนำให้หยุดด้วย `task_stop` (แท็บสอง)
        from: engine
        to: engine
        sees:
          - kind: payload
            source: docs/results/real-usecases/runs/A12-background-server/fix-s3-2/wire.jsonl.gz#line=31
            select: messages[-1].content[0]
            highlight: [content]
            quote: "bg-1: background command `npm run dev`, running"
          - kind: payload
            source: docs/results/real-usecases/runs/A12-background-server/fix-s3-2/wire.jsonl.gz#line=31
            select: messages[-1].content[0]
            highlight: [content]
            quote: Stop a running or pending one with task_stop and its id.
      lane: tool
      at: executor
      do: >-
        `list_agents` อ่านอย่างเดียว: ลูกจาก event `child-start` และ `child-end` ใน log, คำสั่งเบื้องหลังจาก `BackgroundJobs`
        และ monitor, wake-up, การเฝ้า PR ที่ยังค้างจาก `Wakes.pending` แล้วเรียงใหม่สุดก่อน
        ผลขึ้นต้น "This session's subagents and background work, newest first:" และจบด้วยคำแนะนำให้หยุดด้วย `task_stop`
      ref: packages/core/src/work.ts#workListText

    - use: tool-result-returns
    - use: model-call

    - id: stops
      beat:
        title: Model ขอหยุดสิ่งที่ไม่ต้องการ
        text: model เรียก `task_stop` ด้วย id ของสิ่งที่จะหยุด การ์ดเป็นบล็อก `tool_use` จริงจากการรันที่หยุด dev server ดู `input.id` ว่าเป็น `bg-1`
        from: model
        to: engine
        sees:
          kind: payload
          source: docs/results/real-usecases/runs/A12-background-server/fix-a1/session.jsonl#seq=21
          select: content[1]
      lane: model
      do: >-
        model อ่านรายการ แล้วขอเรียก `task_stop` ด้วย `id` ของสิ่งที่จะหยุด จบคำตอบด้วย `stop_reason: tool_use`
      ref: packages/core/src/work.ts#TASK_STOP_TOOL_DEFINITION
      emits: [tool_use, task_stop]
      phase: calling-model

    - use: tool-call-opens

    - id: which
      beat:
        title: Geno ดูว่า id เป็นของอะไร
        text: "Geno ดูรูปของ id `bg-N` คือคำสั่งเบื้องหลัง `wake-N` คือ monitor การปลุกตามเวลา หรือการเฝ้า PR อย่างอื่นคือ session id ของ subagent id ที่ไม่รู้จักได้ error"
        from: engine
        to: engine
        ask: Model หยุดอะไร
      lane: loop
      at: tools
      do: >-
        `taskRefOf` อ่านชนิดของ id: `bg-N` คือคำสั่งเบื้องหลัง `wake-N` คือ monitor wake-up หรือการเฝ้า PR อย่างอื่นคือ session id ของลูก
        id ที่ไม่รู้จักได้ error ที่บอกว่า id แบบไหนใช้ได้
      ref: packages/engine/src/tools/work.ts#workExecutors
      fork:
        ask: model หยุดอะไร
        options:
          - id: child
            label: ลูก explore
            then: result
            steps:
              - lane: loop
                beat:
                  title: Geno หยุด explore
                  text: >-
                    Geno ปิดเสียงรายงาน คือรายงานของ explore จะไม่มาเป็นข้อความทีหลังอีก แล้วหยุด explore และรอจนมันจบ
                    แถวของมันขึ้นว่ายกเลิก ผลของ call คือข้อความที่ explore เขียนไว้ก่อนถูกหยุด ห่อในรั้ว `<subagent_report>`
                    ที่บอก model ว่าเป็นข้อมูล ไม่ใช่คำสั่ง ผลนี้ถึง model ตอนเรียกครั้งถัดไป
                  from: engine
                  to: engine
                at: tools
                do: >-
                  `stopChild` หาตัวหยุดของลูก `stopNow` ปิดเสียงรายงานที่จะมาทีหลัง แล้ว abort ลูกด้วยเหตุ `MODEL_STOP`
                  call นี้รอจนลูกจบ
                ref: "packages/engine/src/subagents.ts#\"const stopNow = async () => {\""
              - lane: child@explore
                at: loop
                do: >-
                  ลูกจบแบบ `cancelled` โดย `model` รายงานคือข้อความทั้งหมดที่ลูกเขียนไว้ (`partial`)
                ref: packages/core/src/subagent.ts#childEndWords
                emits: [cancelled]
              - lane: server
                at: updates
                do: >-
                  `acpChildHost.ended` ส่ง `subagent_update` แถวของลูกขึ้นไอคอน cancelled
                ref: packages/engine/src/subagent-acp.ts#acpChildHost
                emits: [subagent_update]
              - lane: tool
                at: executor
                do: >-
                  ผลของ `task_stop` คือรายงานในรั้วสถานะ `cancelled` ตามด้วย
                  "The subagent was stopped with task_stop before it finished, so this is what it had."
                  รายงานฉบับนี้ไม่มาเป็นข้อความอีก และ session ไม่ติดหนี้รายงานแล้ว
                ref: packages/core/src/subagent.ts#childReport
                emits: [subagent_report]

          - id: job
            label: คำสั่ง bg-1
            then: result
            steps:
              - lane: tool
                beat:
                  title: Geno หยุด `pnpm dev`
                  text: >-
                    Geno ส่ง SIGTERM (ขอให้ process จบ) แล้ว SIGKILL (บังคับจบ) ถ้ายังไม่จบในไม่กี่วินาที
                    การ์ดเป็น `tool_result` จริงจากการรันเดียวกัน (ในรันนั้นคำสั่งคือ `npm run dev`) ข้อความที่ไฮไลต์บอกว่าหยุด `bg-1` แล้วและไฟล์ที่เก็บ output ทั้งหมดอยู่ที่ไหน (แท็บแรก) ตามด้วยท้ายของ output (แท็บสอง)
                  from: engine
                  to: machine
                  sees:
                    - kind: payload
                      source: docs/results/real-usecases/runs/A12-background-server/fix-a1/wire.jsonl#line=15
                      select: messages[-1].content[0]
                      highlight: [content]
                      quote: Stopped background command bg-1
                    - kind: payload
                      source: docs/results/real-usecases/runs/A12-background-server/fix-a1/wire.jsonl#line=15
                      select: messages[-1].content[0]
                      highlight: [content]
                      quote: listening on http://localhost:5173
                at: shell
                do: >-
                  `stopJob` ส่ง SIGTERM ให้ `pnpm dev` แล้ว SIGKILL ถ้ายังไม่จบในไม่กี่วินาที
                  ผลคือ "Stopped background command bg-1 (`pnpm dev`)." ตามด้วยท้าย output และที่อยู่ไฟล์ output
                  คำสั่งที่ model หยุดเองไม่ปลุก session
                ref: "packages/engine/src/tools/work.ts#\"async function stopJob(\""

          - id: wake
            label: wake-up wake-1
            then: result
            steps:
              - lane: tool
                beat:
                  title: Geno ยกเลิก `wake-1`
                  text: Geno ล้างนาฬิกาและจดลง log ว่ายกเลิก ถ้า engine เริ่มใหม่ ตัวใหม่จึงไม่ตั้งนาฬิกานี้อีก
                  from: engine
                  to: engine
                at: executor
                do: >-
                  `Wakes.stop` ล้างนาฬิกาของ `wake-1` แล้วบันทึกโน้ต `wake` ชนิด `stopped` ลง log
                  engine ตัวถัดไปจึงไม่ตั้งนาฬิกานี้อีก ผลคือ "Cancelled wake-up wake-1. It will not wake you."
                ref: "packages/engine/src/tools/work.ts#\"async function stopWake(\""
                emits: [stopped]

          - id: gone
            label: ลูกที่จบไปแล้ว
            steps:
              - lane: tool
                beat:
                  title: explore จบไปแล้ว
                  text: >-
                    ไม่มีอะไรให้หยุด Geno เขียน `tool_result` แบบ error ว่า explore ไม่ได้รันแล้วลง log ผลนี้ถึง model ตอนเรียกครั้งถัดไป
                  from: engine
                  to: engine
                at: executor
                do: >-
                  ลูกไม่ได้รันแล้ว `stopChild` จึงโยน `ToolError` "explore subagent ... is not running: it ended (done)."
                  ลูกแบบรอก็หยุดด้วยทางนี้ไม่ได้: ได้ error ว่าลูกแบบรอจบพร้อมรายงานของมันเอง
                ref: "packages/engine/src/tools/work.ts#\"async function stopChild(\""
                emits: [ToolError]
              - use: tool-result-returns
              - lane: loop
                beat:
                  title: Geno ส่ง error ให้ model ในคำขอใหม่
                  text: >-
                    turn ไม่จบ Geno ส่งบทสนทนาทั้งหมดไปให้ model อีกครั้ง การ์ดข้างล่างเป็นคำขอจริงจากการรันที่ model เรียก `task_stop`
                    กับ `bg-1` ซ้ำหลังมันหยุดไปแล้ว error มีรูปแบบเดียวกัน การ์ดแรกคือข้อความรองสุดท้าย ส่วนที่ไฮไลต์คือ call `task_stop`
                    ของ model การ์ดที่สองคือข้อความสุดท้าย ส่วนที่ไฮไลต์คือ `tool_result` ที่มี `is_error: true` model อ่านเหตุผลแล้วทำงานต่อ
                  from: engine
                  to: model
                  sees:
                    - kind: payload
                      source: docs/results/real-usecases/runs/A12-background-server/1/requests.jsonl#seq=23
                      select: messages[-2]
                      highlight: ['content[1]']
                    - kind: payload
                      source: docs/results/real-usecases/runs/A12-background-server/1/requests.jsonl#seq=23
                      select: messages[-1]
                      highlight: ['content[0]']
                  end: Model ทำต่อ
                at: step
                do: >-
                  `loopStep` เห็น `tool-result` ล่าสุดจึงตัดสิน `call-model` คำขอใหม่มี `tool_result` ที่ `is_error` เป็น true อยู่ท้ายสุด
                ref: packages/core/src/loop.ts#loopStep
                emits: [call-model]
                phase: calling-model
                end: { turn: continues, reason: call-model }

    - id: result
      beat:
        title: Geno บันทึกผลของ `task_stop`
        text: สิ่งที่หยุดแล้วหายจากรายการรอของงาน เมื่อ turn จบ แผง Tasks จึงไม่แสดงมันว่ากำลังรอ
        from: engine
        to: engine
        sees: หลัง turn จบ แถวของ session ไม่มีตัวที่หยุดแล้วในรายการที่รอ
      lane: loop
      at: tools
      do: >-
        `runTools` บันทึก `tool-result` ของ `task_stop`
      ref: "packages/engine/src/drive.ts#\"for (const result of outcome.results) if (result !== undefined) await record(result);\""
      emits: [tool-result]

    - id: tasks
      lane: panel
      at: tasks
      alongside: true
      do: >-
        สิ่งที่หยุดแล้วหายจากการรอของงานใน engine ระหว่างที่ turn ยังรัน แถวของ session ในแผง Tasks ไม่แสดง "Wakes on ..." อยู่แล้ว
        (`wakesOf` ข้ามงานที่ยังรัน) เมื่อ turn จบ บรรทัดนั้นไม่มีตัวที่หยุดไป
      sees: หลัง turn จบ แถวของ session ไม่มีตัวที่หยุดแล้วในรายการที่รอ
      ref: packages/core/src/wake.ts#waitsForText

    - use: model-call

    - id: tells
      beat:
        title: Model บอกคุณว่าหยุดอะไรไปแล้ว
        text: >-
          model บอกคุณว่าหยุดอะไรไปแล้ว ถ้าหยุด explore ก็สรุปสิ่งที่มันเจอก่อนถูกหยุดด้วย
          การ์ดข้างล่างเป็นคำตอบจริงจากการรันเดียวกับการ์ดของ `task_stop` ซึ่งหยุด dev server ส่วนที่ไฮไลต์คือ model
          บอกผลที่ได้และว่าหยุด server แล้ว จบคำตอบด้วย `end_turn`
        from: model
        to: engine
        sees:
          kind: payload
          source: docs/results/real-usecases/runs/A12-background-server/fix-a1/session.jsonl#seq=24
          select: content
          collapse: ['[0].thinking']
          highlight: ['[1].text']
          quote: The server has been stopped.
        end: Turn จบ
      lane: model
      do: >-
        model บอกผู้ใช้ว่าหยุดอะไรไปแล้ว ถ้าหยุด explore ก็สรุปสิ่งที่มันเจอก่อนถูกหยุดด้วย
      ref: "packages/engine/src/gateway.ts#\"stopReason: message.stop_reason,\""
      emits: [end_turn]
      end: { turn: done, reason: end_turn }
---

`list_agents` กับ `task_stop` คือมือของ model บนงานเบื้องหลังของ session ตัวเอง
ผู้ใช้มีมือของตัวเองในแผง Tasks: ปุ่ม Cancel บนแถวของลูก ปุ่ม Stop ของคำสั่ง และปุ่ม Cancel ของการรอทั้งหมด

| id | `task_stop` ทำอะไร | ผล |
| --- | --- | --- |
| `bg-N` | SIGTERM แล้ว SIGKILL | ท้าย output ของคำสั่ง |
| `wake-N` ของ monitor | เลิกเฝ้า และหยุดคำสั่งที่ monitor เริ่มเอง | บอกว่าคำสั่งหยุดด้วยหรือยังรัน |
| `wake-N` ของ wake-up | ล้างนาฬิกา บันทึก `stopped` | "It will not wake you." |
| `wake-N` ของการเฝ้า PR | เลิกเฝ้า | "It will not wake you." |
| session id ของลูกเบื้องหลัง | abort ลูก | รายงานบางส่วนในรั้ว |

สิ่งที่ควรสังเกต

- **ลูกไม่มี tool สองตัวนี้** `list_agents` และ `task_stop` อยู่ในรายการที่ลูกไม่ได้ ลูกหยุดงานของแม่ไม่ได้
- **subagent แบบที่แม่รอหยุดด้วย `task_stop` ไม่ได้** call ที่เริ่มมันจบพร้อมรายงานของมันเองอยู่แล้ว `task_stop` จึงตอบเป็น error
- **[workflow](/start/glossary/) หยุดได้เฉพาะเมื่อเปิดการปลุก** (อ่านจากโค้ด) session ของ workflow ถูกจดเป็นการรอใน `Wakes` เฉพาะเมื่อการปลุกอัตโนมัติเปิด
  ถ้าปิดอยู่ `task_stop` ด้วย id ของ workflow หาไม่เจอ
