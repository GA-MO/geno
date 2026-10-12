---
title: แสดงหรือหยุดงานเบื้องหลัง
description: โมเดลเรียก list_agents ดูว่า session มีลูก คำสั่ง และการรออะไรค้างอยู่ แล้วเรียก task_stop หยุดตัวที่ไม่ต้องการแล้ว
tableOfContents: false
sidebar:
  order: 7
scenario:
  surface: vscode
  given:
    - ใน turn นี้โมเดลเริ่มลูก `explore` แบบเบื้องหลัง เริ่ม `pnpm dev` เป็น `bg-1` และตั้ง `schedule_wakeup` เป็น `wake-2` ไว้แล้ว
    - ผู้ใช้เพิ่งบอกว่าไม่ต้องสำรวจต่อแล้ว เพราะเจอคำตอบเอง
  trigger: >-
    โมเดลต้องการรู้ว่ามีอะไรค้างอยู่ก่อนจะหยุด จึงเรียก `list_agents`
  covers: [bg.task-stop-or-list]
  related: [bg.monitor-wakes, bg.schedule-wakeup, sub.user-cancels-child, bg.user-cancels-wakes]
  steps:
    - id: lists
      beat:
        title: Model ขอดูว่ามีอะไรค้างอยู่
        text: คุณบอกว่าไม่ต้องสำรวจต่อแล้ว ก่อนหยุดอะไร model เรียก `list_agents` เพื่อดูของที่ค้าง
        to: engine
      lane: model
      do: >-
        โมเดลขอเรียก `list_agents` ซึ่งไม่มี input จบคำตอบด้วย `stop_reason: tool_use`
      ref: packages/core/src/work.ts#LIST_AGENTS_TOOL_DEFINITION
      emits: [tool_use, list_agents]
      phase: calling-model

    - use: tool-call-opens

    - id: rows
      beat:
        title: Geno รวบรวมลูก คำสั่ง และการรอ
        text: Geno อ่าน subagent จาก log คำสั่งเบื้องหลัง และ monitor wake-up หรือการเฝ้า PR ที่ยังค้าง แล้วส่งรายการให้ model
        to: model
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
        text: model เรียก `task_stop` ด้วย id ของสิ่งที่จะหยุด การ์ดเป็นคำขอจริงจากการรันที่หยุด dev server
        to: engine
        sees:
          kind: payload
          direction: response
          source: docs/results/real-usecases/runs/A12-background-server/fix-a1/session.jsonl#seq=21
          select: content[1]
      lane: model
      do: >-
        โมเดลอ่านรายการ แล้วขอเรียก `task_stop` ด้วย `id` ของสิ่งที่จะหยุด จบคำตอบด้วย `stop_reason: tool_use`
      ref: packages/core/src/work.ts#TASK_STOP_TOOL_DEFINITION
      emits: [tool_use, task_stop]
      phase: calling-model

    - use: tool-call-opens

    - id: which
      beat:
        title: Geno ดูว่า id เป็นของอะไร
        text: "`bg-N` คือคำสั่งเบื้องหลัง `wake-N` คือ monitor wake-up หรือการเฝ้า PR อย่างอื่นคือ session ของ subagent id ที่ไม่รู้จักได้ error"
        ask: Model หยุดอะไร
      lane: loop
      at: tools
      do: >-
        `taskRefOf` อ่านชนิดของ id: `bg-N` คือคำสั่งเบื้องหลัง `wake-N` คือ monitor wake-up หรือการเฝ้า PR อย่างอื่นคือ session id ของลูก
        id ที่ไม่รู้จักได้ error ที่บอกว่า id แบบไหนใช้ได้
      ref: packages/engine/src/tools/work.ts#workExecutors
      fork:
        ask: โมเดลหยุดอะไร
        options:
          - id: child
            label: ลูก explore
            then: result
            steps:
              - lane: loop
                beat:
                  title: Geno หยุด explore
                  text: Geno ปิดเสียงรายงานที่จะมาทีหลัง แล้วหยุด explore และรอจนมันจบ แถวของมันขึ้นว่ายกเลิก ผลของ call คือข้อความที่ explore เขียนไว้ก่อนถูกหยุด
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
                  text: Geno ส่ง SIGTERM แล้ว SIGKILL ถ้ายังไม่จบในไม่กี่วินาที ผลบอกท้ายของ output และที่อยู่ไฟล์ การ์ดเป็นผลจริงจากการรันเดียวกัน
                  from: machine
                  sees:
                    kind: payload
                    direction: tool_result
                    source: docs/results/real-usecases/runs/A12-background-server/fix-a1/session.jsonl#seq=22
                    select: output
                at: shell
                do: >-
                  `stopJob` ส่ง SIGTERM ให้ `pnpm dev` แล้ว SIGKILL ถ้ายังไม่จบในไม่กี่วินาที
                  ผลคือ "Stopped background command bg-1 (`pnpm dev`)." ตามด้วยท้าย output และที่อยู่ไฟล์ output
                  คำสั่งที่โมเดลหยุดเองไม่ปลุก session
                ref: "packages/engine/src/tools/work.ts#\"async function stopJob(\""

          - id: wake
            label: wake-up wake-2
            then: result
            steps:
              - lane: tool
                beat:
                  title: Geno ยกเลิก `wake-2`
                  text: Geno ล้างนาฬิกาและจดลง log ว่ายกเลิก engine ตัวถัดไปจึงไม่ตั้งนาฬิกานี้อีก
                at: executor
                do: >-
                  `Wakes.stop` ล้างนาฬิกาของ `wake-2` แล้วบันทึกโน้ต `wake` ชนิด `stopped` ลง log
                  engine ตัวถัดไปจึงไม่ตั้งนาฬิกานี้อีก ผลคือ "Cancelled wake-up wake-2. It will not wake you."
                ref: "packages/engine/src/tools/work.ts#\"async function stopWake(\""
                emits: [stopped]

          - id: gone
            label: ลูกที่จบไปแล้ว
            steps:
              - lane: tool
                beat:
                  title: explore จบไปแล้ว
                  text: ไม่มีอะไรให้หยุด Geno ตอบ error ว่า explore ไม่ได้รันแล้ว subagent แบบรอก็หยุดทางนี้ไม่ได้ เพราะมันจบพร้อมรายงานอยู่แล้ว
                at: executor
                do: >-
                  ลูกไม่ได้รันแล้ว `stopChild` จึงโยน `ToolError` "explore subagent ... is not running: it ended (done)."
                  ลูกแบบรอก็หยุดด้วยทางนี้ไม่ได้: ได้ error ว่าลูกแบบรอจบพร้อมรายงานของมันเอง
                ref: "packages/engine/src/tools/work.ts#\"async function stopChild(\""
                emits: [ToolError]
              - use: tool-result-returns
              - lane: loop
                beat:
                  title: Model อ่าน error แล้วทำต่อ
                  text: turn ไม่จบ model อ่านเหตุผลแล้วทำงานต่อ
                  to: model
                  end: Model ทำต่อ
                at: step
                do: >-
                  `loopStep` ตัดสิน `call-model` โมเดลอ่าน error แล้วทำต่อ
                ref: packages/core/src/loop.ts#loopStep
                emits: [call-model]
                phase: calling-model
                end: { turn: continues, reason: call-model }

    - id: result
      beat:
        title: Geno บันทึกผลของ `task_stop`
        text: สิ่งที่หยุดแล้วหายจากรายการรอของงาน เมื่อ turn จบ แผง Tasks จึงไม่แสดงมันว่ากำลังรอ
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
        text: model สรุปสิ่งที่หยุด และสิ่งที่ explore เจอก่อนถูกหยุด
        to: panel
        end: Turn จบ
      lane: model
      do: >-
        โมเดลบอกผู้ใช้ว่าหยุดอะไรไปแล้ว และสรุปสิ่งที่ explore เจอก่อนถูกหยุด
      ref: "packages/engine/src/gateway.ts#\"stopReason: message.stop_reason,\""
      emits: [end_turn]
      end: { turn: done, reason: end_turn }
---

`list_agents` กับ `task_stop` คือมือของโมเดลบนงานเบื้องหลังของ session ตัวเอง
ผู้ใช้มีมือของตัวเองในแผง Tasks: ปุ่ม Cancel บนแถวของลูก ปุ่ม Stop ของคำสั่ง และปุ่ม Cancel ของการรอทั้งหมด

| id | `task_stop` ทำอะไร | ผล |
| --- | --- | --- |
| `bg-N` | SIGTERM แล้ว SIGKILL | ท้าย output ของคำสั่ง |
| `wake-N` ของ monitor | เลิกเฝ้า และหยุดคำสั่งที่ monitor เริ่มเอง | บอกว่าคำสั่งหยุดด้วยหรือยังรัน |
| `wake-N` ของ wake-up | ล้างนาฬิกา บันทึก `stopped` | "It will not wake you." |
| `wake-N` ของการเฝ้า PR | เลิกเฝ้า | "It will not wake you." |
| session id ของลูกเบื้องหลัง | abort ลูก | รายงานบางส่วนในรั้ว |

สิ่งที่ควรสังเกต

- **ลูกไม่มีเครื่องมือสองตัวนี้** `list_agents` และ `task_stop` อยู่ในรายการที่ลูกไม่ได้ ลูกหยุดงานของแม่ไม่ได้
- **workflow หยุดได้เฉพาะเมื่อเปิดการปลุก** (อ่านจากโค้ด) session ของ workflow ถูกจดเป็นการรอใน `Wakes` เฉพาะเมื่อการปลุกอัตโนมัติเปิด
  ถ้าปิดอยู่ `task_stop` ด้วย id ของ workflow หาไม่เจอ
