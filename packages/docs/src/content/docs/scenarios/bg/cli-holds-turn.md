---
title: CLI ถือ turn ไว้รอรายงาน
description: ใน gcode agent ไม่มีอะไรปลุก session ทีหลัง turn ที่ model จบจึงค้างไว้จนลูกเบื้องหลังรายงาน แล้วเรียก model อีกรอบให้อ่านรายงานก่อน process จบ
scenario:
  surface: cli
  given:
    - "ผู้ใช้รัน `gcode agent \"Where is parseVersion called?\"` ในเทอร์มินัล"
    - "ค่า `agentTool` ในการตั้งค่าของผู้ใช้มีโหมด Ask model จึงเรียก `agent` เองได้"
  trigger: >-
    model เริ่ม `explore` แบบเบื้องหลัง แล้วจบ turn
  covers: [bg.cli-holds-turn]
  related: [bg.child-wakes-parent, bg.arrives-mid-turn, cli.agent-run]
  steps:
    - id: wants
      beat:
        title: Model เริ่ม explore แบบเบื้องหลัง
        text: >-
          ใน `gcode agent` model ส่ง `tool_use` ชื่อ `agent` ที่มี `agent: "explore"`, `task` ที่เขียนให้ครบในตัว
          และ `background: true` แล้วไม่รอ
        from: model
        to: engine
        sees:
          kind: payload
          source: packages/docs/src/data/recorded/cli-holds.jsonl#line=6
          select: messages[1].content
          highlight: ['[1].input']
      lane: model
      do: >-
        model ขอเรียก `agent` ด้วย `agent: "explore"` และ `background: true` จบคำตอบด้วย `stop_reason: tool_use`
      ref: packages/core/src/subagent.ts#agentToolDefinition
      emits: [tool_use]
      phase: calling-model

    - id: decide
      lane: loop
      at: step
      do: >-
        `drive` บันทึก event `assistant` แล้ว `loopStep` ตัดสินว่า `run-tools`
      ref: packages/core/src/loop.ts#loopStep
      emits: [run-tools]
      phase: running-tools

    - id: launch
      beat:
        title: Geno เริ่ม explore โดยไม่รอ
        text: >-
          session ค้างรายงานหนึ่งฉบับ CLI ไม่มีตัวปลุก จึงไม่มีงานรอใน Tasks เทอร์มินัลพิมพ์บรรทัดของ explore
          ผลของ call ที่ model ได้คือ session id ของ explore และคำสั่งว่าอย่าเดาผลจนกว่ารายงานจะมา
        from: engine
        to: model
        sees:
          - kind: payload
            source: packages/docs/src/data/recorded/cli-holds.jsonl#line=6
            select: messages[2].content[0]
            highlight: [content]
      lane: loop
      at: tools
      runs: 1
      do: >-
        `launch` เริ่มลูกโดยไม่รอ session ของแม่ติดหนี้รายงานหนึ่งฉบับ (`owe()`) CLI ไม่มีตัวปลุก จึงไม่มีการรอใน Tasks
        ผลของ call คือ "Started explore in the background as subagent session ... Its report arrives as a message from Geno when it finishes"
      ref: "packages/engine/src/subagents.ts#\"const paid = parentInbox!.owe();\""
      emits: [Started]

    - id: printed
      lane: panel
      at: terminal
      alongside: true
      do: >-
        `terminalChildHost.started` พิมพ์บรรทัดของลูก ขั้นของลูกพิมพ์ต่อด้วยชื่อลูกนำหน้า
      sees: "> explore started (<model>, caps 4 turns $0.02), log: ~/.g-code/sessions/....jsonl"
      ref: packages/engine/src/subagents.ts#terminalChildHost

    - id: logged
      lane: loop
      at: tools
      do: >-
        `runTools` บันทึก `tool-result` ของ `agent`
      ref: "packages/engine/src/drive.ts#\"for (const result of outcome.results) if (result !== undefined) await record(result);\""
      emits: [tool-result]

    - use: model-call
      beat:
        title: Model บอกว่า explore กำลังค้น
        text: Geno ส่งผลของ call ให้ model model เขียนว่า explore กำลังค้นอยู่ แล้วจบ turn ข้อความขึ้นใน stdout
        from: model
        to: panel

    - id: says
      lane: model
      do: >-
        model stream ว่า explore กำลังค้นอยู่ และจบด้วย `stop_reason: end_turn` ข้อความขึ้นใน stdout
      ref: "packages/engine/src/gateway.ts#\"stopReason: message.stop_reason,\""
      emits: [end_turn]

    - id: held
      beat:
        title: Geno ถือ turn ไว้
        text: ใน CLI ไม่มีอะไรปลุก session ทีหลัง และ session ยังค้างรายงาน Geno จึงไม่ให้ turn จบ process รออยู่
        from: engine
        to: engine
        ask: อะไรเกิดก่อน
      lane: loop
      at: drive
      do: >-
        `loopStep` ให้ `done(end_turn)` แต่ CLI ไม่ได้ตั้ง `wakeLater` และ session ยังติดหนี้รายงาน `holdsTurnOpen` จึงถือ turn ไว้
        `drive` รอที่ `held.arrival` process ยังไม่จบ และ Stop hook ยังไม่ทำงาน
      ref: "packages/engine/src/drive.ts#\"await held.arrival(signal);\""
      phase: held
      fork:
        ask: อะไรเกิดก่อน
        options:
          - id: reports
            label: explore รายงาน
            then: report

          - id: ctrl-c
            label: ผู้ใช้กด Ctrl-C
            steps:
              - lane: user
                beat:
                  title: คุณกด Ctrl-C
                  text: คุณไม่อยากรอ การรอจบทันที Geno บันทึกว่าคุณหยุด run
                  from: you
                  to: panel
                do: ผู้ใช้ไม่อยากรอ จึงกด Ctrl-C
              - lane: loop
                at: drive
                do: >-
                  `interrupts()` abort run การรอจบทันที `drive` บันทึก event `error` ชนิด `abort` "interrupted by the user"
                ref: "packages/engine/src/drive.ts#\"await record({ kind: 'error', seq: nextSeq(events), at: new Date().toISOString(), error: 'abort', message: 'interrupted by the user' });\""
                emits: [error, abort]
                phase: ending
              - lane: loop
                beat:
                  title: Geno หยุด explore แล้วจบ process
                  text: turn ไม่ได้จบเอง Geno จึงหยุดลูกเบื้องหลังทุกตัว รายงานของ explore ไม่มีใครได้ยิน เทอร์มินัลพิมพ์ usage แล้วจบด้วย exit 130
                  from: engine
                  to: panel
                  sees: "usage: ... turns=2"
                  end: คุณหยุด run
                at: agent
                do: >-
                  turn ไม่ได้จบด้วย `end_turn` `runAgent` จึงหยุดลูกเบื้องหลังทุกตัวด้วย `stopBackground` รายงานของ explore ไม่มีใครได้ยิน
                ref: "packages/engine/src/agent.ts#\"if (wakeLater) children?.detach();\""
              - lane: panel
                at: terminal
                do: >-
                  `finish` พิมพ์บรรทัด usage และ process จบด้วย exit code 130
                sees: >-
                  "usage: ... turns=2" แล้วเทอร์มินัลกลับมาที่ prompt
                ref: packages/engine/src/chat.ts#EXIT_CODES
                end: { turn: stopped, reason: abort }

    - id: report
      beat:
        title: explore รายงานแล้วจบ
        text: explore ค้นเสร็จ เทอร์มินัลพิมพ์บรรทัดว่ามันจบ พร้อมจำนวนรอบและค่าใช้จ่าย
        from: model
        to: engine
        sees: "> explore done, turns=3 $0.0071"
      lane: child@explore
      at: model
      do: >-
        explore ค้นเสร็จแล้วเรียก `report` ลูกจบแบบ `done` บรรทัดของลูกพิมพ์ว่าจบแล้ว
      ref: packages/engine/src/subagents.ts#reportExecutor
      emits: [report]

    - id: done-line
      lane: panel
      at: terminal
      alongside: true
      do: >-
        `terminalChildHost.ended` พิมพ์ผลของลูก
      sees: "> explore done, turns=3 $0.0071"
      ref: packages/engine/src/subagents.ts#terminalChildHost

    - id: put
      beat:
        title: Geno ส่งรายงานเข้า turn ที่ถือไว้
        text: >-
          Geno ใส่รายงานในรั้วลงกล่อง การรอจบ turn ที่ถือไว้บันทึกรายงานแล้วเรียก model อีกครั้ง request นั้นจบด้วยโน้ตของ Geno
          ที่มีรายงานในรั้ว `<subagent_report>` และคำเตือน ไม่มีบรรทัด "Geno started this turn by itself" เพราะ turn นี้ยังเป็น turn เดิม
        from: engine
        to: model
        sees:
          kind: payload
          source: packages/docs/src/data/recorded/cli-holds.jsonl#line=10
          select: messages[4]
          highlight: ['content[0].text']
      lane: loop
      at: tools
      do: >-
        `launch` บันทึก `child-end` ลง log ของแม่ ใส่รายงานในรั้วลงกล่องข้อความ แล้วล้างหนี้ `held.arrival` จึงจบการรอ
      ref: "packages/engine/src/subagents.ts#\"const report = async (text: string, ended: ChildEndNote | undefined) => {\""
      emits: [child-end, child-report]

    - id: deliver
      lane: loop
      at: drive
      do: >-
        turn ที่ถูกถือไว้ไปที่ `deliver()` แม้ขั้นของลูปจะเป็น `done` `deliver()` บันทึกรายงานเป็น event `user` แบบ steer `from: 'child'`
        ลูปดู log อีกรอบ `loopStep` เห็น event `user` ล่าสุดจึงตัดสิน `call-model` และเรียก model ขีดจำกัด 40 ครั้งและ $0.40 ยังนับต่อ
      ref: "packages/engine/src/drive.ts#\"} else if (step.kind === 'call-model' || held !== undefined) {\""
      emits: [user]
      phase: calling-model

    - id: relays
      beat:
        title: Model สรุปลง stdout
        text: model อ่านรายงาน แล้วเขียนสรุปที่เรียก `parseVersion`
        from: model
        to: panel
      lane: model
      do: >-
        model อ่านรายงานในรั้ว แล้ว stream สรุปที่เรียก `parseVersion`ลง stdout จบด้วย `stop_reason: end_turn`
      ref: "packages/engine/src/gateway.ts#\"stopReason: message.stop_reason,\""
      emits: [end_turn]

    - id: ends
      beat:
        title: run จบ
        text: ไม่มีรายงานค้างแล้ว turn จึงจบจริง เทอร์มินัลพิมพ์ usage ว่าเรียก model สามครั้ง แล้ว process จบด้วย exit 0
        from: engine
        to: panel
        sees: "usage: ... turns=3"
        end: process จบ exit 0
      lane: loop
      at: step
      do: >-
        `loopStep` ให้ `done(end_turn)` ไม่มีหนี้รายงานเหลือ turn จึงไม่ถูกถือ Stop hook (ถ้ามี) ได้ตัดสินแล้ว run จบ
      ref: packages/core/src/steer.ts#holdsTurnOpen
      emits: [end_turn]
      phase: ending

    - id: exit
      lane: panel
      at: terminal
      do: >-
        `finish` พิมพ์บรรทัด usage และ process จบด้วย exit code 0
      sees: >-
        "usage: ... turns=3" (เรียก model สามครั้ง: ขอ `agent` บอกว่ารอ และเล่ารายงาน) แล้วเทอร์มินัลกลับมาที่ prompt
      ref: packages/engine/src/drive.ts#terminalSurface
      end: { turn: done, reason: end_turn }
---

ใน VS Code turn ที่ model จบจะจบจริง และรายงานที่มาทีหลังปลุก session ([ลูกเบื้องหลังรายงานแล้วปลุกเซสชัน](/scenarios/bg/child-wakes-parent/))
ใน CLI ไม่มี engine ที่อยู่ต่อหลัง process จบ จึงไม่มีใครปลุก `drive` ถือ turn ไว้แทน เพื่อไม่ให้รายงานหายไปพร้อม process

สิ่งที่ควรสังเกต

- **VS Code ที่ปิดการปลุกก็ถือแบบเดียวกัน** ถ้า `gcode.wake.auto` ปิด engine ไม่ตั้ง `wakeLater` turn ในแผงแชตจึงค้างที่ "working" จนลูกรายงาน
- **ถือเฉพาะหนี้รายงานของลูก** คำสั่งเบื้องหลังที่ยังรันไม่ทำให้ turn ค้าง ใน CLI `monitor`, `schedule_wakeup` และ `watch_pr` ได้ error ว่าไม่มีอะไรปลุก session
- **รอได้นานเท่าลูก** ระหว่างรอ process ไม่เรียก model และไม่เสียเงิน เพดานของลูกเป็นตัวกำหนดว่ารอนานแค่ไหน
