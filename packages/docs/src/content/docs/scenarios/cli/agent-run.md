---
title: รันเอเจนต์จากเทอร์มินัล
description: gcode agent รันเอเจนต์หนึ่งรอบใน process เดียว ข้อความออก stdout คำถามขออนุญาตเป็น [y/N] บนเทอร์มินัล และผลจบเป็น exit code
tableOfContents: false
sidebar:
  order: 1
scenario:
  surface: cli
  given:
    - ตั้ง API key ของผู้ให้บริการไว้ในตัวแปรสภาพแวดล้อมหรือ `.env` แล้ว
    - อยู่ในโฟลเดอร์ของ repo ที่ commit ล่าสุดเป็นงานที่ผู้ใช้อยากทิ้ง
  trigger: >-
    ผู้ใช้รัน `gcode agent "ทิ้ง commit ล่าสุดทั้งหมด"` ในเทอร์มินัล
  covers: [cli.agent-run, cli.approve-on-terminal, cli.non-interactive]
  related: [perm.ask-allow, turn.with-tools, sec.sandbox-blocks-write]
  steps:
    - id: run
      lane: user
      do: >-
        ผู้ใช้รันคำสั่ง (เพิ่ม `--mode auto` หรือ `--non-interactive` ได้ ค่าเริ่มต้นคือโหมด Ask)
      phase: idle

    - id: setup
      lane: loop
      at: agent
      do: >-
        คำสั่ง `agent` อ่านแฟล็ก เปิด session ใหม่ (หรือต่อ session เดิมด้วย `--session`) ตั้งขีดจำกัด 40 ครั้ง และ $0.40
        เลือกตัวขออนุญาต: `askOnTerminal` สำหรับคนที่นั่งหน้าเทอร์มินัล หรือแบบ non-interactive
        hook ที่รันมีแค่ของผู้ใช้เอง ไม่มี hook ของ workspace และ MCP เปิดเมื่อมีคนตอบได้ (ปิดด้วย `--no-mcp`)
      ref: packages/engine/src/agent.ts#agent
      phase: starting

    - id: build
      lane: loop
      at: drive
      do: >-
        `runAgent` ทำงานใน process นี้เลย ไม่มี engine daemon และไม่มี ACP พื้นผิวเป็น `terminalSurface`
        ไฟล์อ่านเขียนจากดิสก์ตรง `drive` บันทึก event `user` ลง log ของ session
      ref: packages/engine/src/drive.ts#terminalSurface
      emits: [user]

    - use: model-call

    - id: wants
      lane: model
      do: >-
        โมเดล stream ข้อความสั้นๆ แล้วขอเรียก `bash` ด้วย `git reset --hard HEAD~1` จบด้วย `stop_reason: tool_use`
      ref: "packages/engine/src/gateway.ts#\"stopReason: message.stop_reason,\""
      emits: [tool_use]

    - id: printed
      lane: panel
      at: terminal
      do: >-
        ข้อความของโมเดลเขียนลง stdout ทีละส่วน และทุก call ที่เริ่มพิมพ์บรรทัด `> ` ตามด้วยชื่อขั้น
      sees: "> bash git reset --hard HEAD~1"
      ref: packages/engine/src/drive.ts#terminalSurface

    - id: judge
      lane: policy
      at: rules
      do: >-
        `loopStep` ตัดสิน `run-tools` แล้ว `ruledDenial` จับคำสั่งได้ด้วยกฎ `git-reset-hard`
        ซึ่งโหมด Ask ต้องถาม Auto ให้ classifier ตัดสิน และ non-interactive ปฏิเสธ
      ref: packages/core/src/permission-rules.ts#ruledDenial
      emits: [git-reset-hard]
      phase: running-tools
      fork:
        ask: ใครตอบคำถามนี้
        options:
          - id: yes
            label: ผู้ใช้พิมพ์ y
            steps:
              - lane: panel
                at: terminal
                do: >-
                  `askOnTerminal` ถามผ่าน `terminalConfirm` ซึ่งรอบรรทัดจากเทอร์มินัล
                sees: >-
                  "Allow `git reset --hard HEAD~1`? It uses git reset --hard. [y/N] "
                ref: packages/engine/src/terminal-confirm.ts#terminalConfirm
                phase: waiting-user
              - lane: user
                do: ผู้ใช้พิมพ์ y แล้วกด Enter
              - lane: policy
                at: settle
                do: >-
                  `settle` บันทึก `decidedBy: user, verdict: allow`
                ref: packages/engine/src/tools/agent.ts#settle
                phase: running-tools
              - lane: tool
                at: shell
                do: >-
                  `bash` รันคำสั่งใน sandbox ไฟล์ใน workspace กลับไปเป็นของ commit ก่อนหน้า
                ref: "packages/engine/src/tools/agent.ts#\"tools.sandbox.run(command\""
              - use: model-call
              - lane: model
                do: >-
                  โมเดลอ่านผลแล้วตอบว่าทิ้ง commit แล้ว จบด้วย `stop_reason: end_turn`
                ref: "packages/engine/src/gateway.ts#\"stopReason: message.stop_reason,\""
                emits: [end_turn]
              - lane: loop
                at: step
                do: >-
                  `loopStep` ตัดสิน `done(end_turn)` `finish` พิมพ์ยอดใช้งานลง stdout แล้วคืน exit code จาก `DONE_EXIT`
                ref: packages/engine/src/drive.ts#finish
                emits: [end_turn]
                phase: ending
              - lane: panel
                at: terminal
                do: process จบ
                sees: "usage: ... turns=2 แล้ว process จบด้วย exit code 0"
                ref: packages/engine/src/drive.ts#finish
                end: { turn: done, reason: end_turn }

          - id: no
            label: ผู้ใช้กด Enter (N)
            then: rejected
            steps:
              - lane: panel
                at: terminal
                do: >-
                  `terminalConfirm` ถามแบบเดียวกัน คำตอบที่ไม่ใช่ y หรือ yes นับเป็นไม่
                sees: >-
                  "Allow `git reset --hard HEAD~1`? It uses git reset --hard. [y/N] "
                ref: packages/engine/src/terminal-confirm.ts#terminalConfirm
                phase: waiting-user
              - lane: user
                do: ผู้ใช้กด Enter เฉยๆ

          - id: no-tty
            label: stdin ไม่ใช่เทอร์มินัล
            then: rejected
            steps:
              - lane: panel
                at: terminal
                do: >-
                  คำสั่งถูกรันโดยมี pipe เป็น stdin ไม่มีคนตอบ `terminalConfirm` จึงตอบไม่ทันที และเขียนเหตุลงไว้
                sees: >-
                  "Allow `git reset --hard HEAD~1`? It uses git reset --hard. There is no terminal to answer, so it was refused."
                ref: packages/engine/src/terminal-confirm.ts#terminalConfirm

          - id: non-interactive
            label: --non-interactive
            steps:
              - lane: policy
                at: settle
                do: >-
                  ในโหมด non-interactive กฎนี้ปฏิเสธเลย `settle` ให้ PermissionRequest hook ตอบแทนได้ก่อน ไม่มี hook
                  จึงบันทึก `decidedBy: rule, verdict: deny` เป็น `ToolDenied` ซึ่งไม่จบ turn
                ref: packages/engine/src/tools/agent.ts#denialText
                emits: [ToolDenied]
              - lane: loop
                at: tools
                do: >-
                  ผลของ call บอกโมเดลว่า "denied: `git reset --hard HEAD~1` uses git reset --hard, which needs the user's approval,
                  and nobody can answer here." ตามด้วยคำแนะนำว่าอย่าหาทางเลี่ยงเจตนาของการปฏิเสธ
                ref: packages/core/src/loop.ts#DONT_ASK
                emits: [denied]
              - use: model-call
              - lane: model
                do: >-
                  โมเดลอธิบายว่าต้องให้ผู้ใช้อนุญาต และบอกคำสั่งที่ผู้ใช้รันเองได้ จบด้วย `stop_reason: end_turn`
                ref: "packages/engine/src/gateway.ts#\"stopReason: message.stop_reason,\""
                emits: [end_turn]
              - lane: panel
                at: terminal
                do: >-
                  `finish` พิมพ์ยอดใช้งาน run จบแบบ `end_turn` จึงได้ exit code 0 ทั้งที่งานไม่ได้ทำ
                sees: "usage: ... turns=2 แล้ว process จบด้วย exit code 0"
                ref: packages/engine/src/drive.ts#finish
                phase: ending
                end: { turn: done, reason: end_turn }

    - id: rejected
      lane: policy
      at: settle
      do: >-
        `askOnTerminal` ได้ `reject` `settle` บันทึก `decidedBy: user, verdict: deny` และ `refusalOf` โยน `ToolRejected`
        คำสั่งไม่ได้รัน
      ref: packages/engine/src/tools/agent.ts#refusalOf
      emits: [ToolRejected]
      phase: running-tools

    - id: stops
      lane: loop
      at: step
      do: >-
        ผล `rejected` บอกโมเดลให้หยุดรอผู้ใช้ `loopStep` ตัดสิน `done(end_turn)` ทันทีโดยไม่เรียกโมเดลอีก
      ref: packages/core/src/loop.ts#loopStep
      emits: [rejected, end_turn]
      phase: ending

    - id: exit
      lane: panel
      at: terminal
      do: >-
        `finish` พิมพ์ยอดใช้งาน event ล่าสุดไม่ใช่ error จึงได้ exit code 0 จาก `DONE_EXIT.end_turn`
      sees: "usage: ... turns=1 แล้ว process จบด้วย exit code 0"
      ref: packages/engine/src/drive.ts#finish
      end: { turn: done, reason: end_turn }
---

`gcode agent` คือ loop ตัวเดียวกับใน VS Code แต่ไม่มี extension host ไม่มี engine daemon และไม่มี ACP
คอลัมน์ VS Code และเซิร์ฟเวอร์ engine จึงไม่มีในทัวร์นี้ แผงแชตคือเทอร์มินัล

| exit code | เมื่อไร |
| --- | --- |
| 0 | รอบจบด้วย `end_turn` รวมถึงตอนที่ผู้ใช้ตอบไม่ หรือการปฏิเสธใน non-interactive |
| 1 | error ของผู้ให้บริการ การปฏิเสธของโมเดล หรือ hook บล็อก |
| 2 | ใช้แฟล็กผิด |
| 3 | ถึงขีดจำกัด `--max-turns` หรือ `--max-cost` |
| 130 | ผู้ใช้กด Ctrl-C |

สิ่งที่ควรสังเกต

- **ตอบไม่แล้วยังได้ 0** exit code บอกว่ารอบจบอย่างไร ไม่ได้บอกว่างานสำเร็จ สคริปต์ที่เรียก `gcode agent`
  ต้องอ่านข้อความด้วยถ้าอยากรู้ว่าคำสั่งถูกปฏิเสธ
- **ไม่มีเทอร์มินัลก็บันทึกว่าผู้ใช้ปฏิเสธ** เมื่อ stdin ไม่ใช่เทอร์มินัล `terminalConfirm` ตอบไม่แทน แต่ `settle` บันทึก
  `decidedBy: user` เหมือนผู้ใช้กดไม่เอง turn จึงจบแบบเดียวกับการปฏิเสธของคน ต่างจาก `--non-interactive` ที่ทำต่อได้
- **hook ของ workspace ไม่รัน** บรรทัดคำสั่งไม่มี editor ที่ยืนยันว่าผู้ใช้เชื่อถือโฟลเดอร์ จึงรันเฉพาะ hook ของผู้ใช้
- **non-interactive ไม่ได้ปฏิเสธทุกอย่าง** คำสั่งที่ไม่อยู่ใน safe list แต่ไม่มีกฎจับ (`unlisted`) รันได้ใน sandbox
  กฎ allow ของ workspace ไม่มีผลในโหมดนี้ และ `--mode` ใช้คู่กับ `--non-interactive` ไม่ได้
- **Auto บนเทอร์มินัล** เมื่อ classifier ตัดสิน เทอร์มินัลพิมพ์ `auto: the classifier ...` พร้อมเหตุผลใต้บรรทัดของ call
