---
title: "รัน agent จากเทอร์มินัล"
description: gcode agent รันเอเจนต์หนึ่งรอบใน process เดียว ข้อความออก stdout คำถามขออนุญาตเป็น [y/N] บนเทอร์มินัล และผลจบเป็น exit code
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
      beat:
        title: คุณรัน `gcode agent`
        text: >-
          คุณขอให้ทิ้ง commit ล่าสุดทั้งหมด ค่าเริ่มต้นคือโหมด Ask เพิ่ม `--mode auto` ได้
          หรือเพิ่ม `--non-interactive` สำหรับสคริปต์ที่ไม่มีใครตอบคำถาม สิ่งที่ปกติต้องถามจะถูกตัดสินทันที
        from: you
        to: panel
      lane: user
      do: >-
        ผู้ใช้รันคำสั่ง (เพิ่ม `--mode auto` หรือ `--non-interactive` ได้ ค่าเริ่มต้นคือโหมด Ask)
      phase: idle

    - id: setup
      beat:
        title: Geno เตรียม session ใน process นี้
        text: >-
          ไม่มี engine แยก และไม่มี VS Code ไฟล์อ่านเขียนจากดิสก์ตรง Geno ตั้งขีดจำกัดให้เรียก model ได้ไม่เกิน 40 ครั้ง และใช้เงินไม่เกิน $0.40 เลือกวิธีถามคุณบนเทอร์มินัล
          แล้วส่ง prompt ให้ model ข้อความของคุณอยู่ท้ายข้อความแรกของคำขอ ต่อจากข้อมูลที่ Geno แนบ
          การ์ดข้างล่างเป็นคำขอแรกจริงจาก `gcode agent` อีกรันที่ขอให้ลบ `build/` ด้วย `rm -rf`
          บล็อกที่ไฮไลต์คือ prompt ของคุณ บล็อกก่อนหน้าคือข้อมูลที่ Geno แนบ
        from: engine
        to: model
        sees:
          kind: payload
          source: docs/results/real-usecases/runs/A08-ask-risky-denied/1/requests.jsonl#seq=5
          select: messages[0]
          highlight: ['content[4]']
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
      beat:
        title: Model ขอรัน `git reset --hard HEAD~1`
        text: >-
          ข้อความของ model ออก stdout ทีละส่วน ทุก call ที่เริ่มพิมพ์บรรทัดของขั้น เช่น `> bash git reset --hard HEAD~1`
          การ์ดข้างล่างเป็นคำตอบจริงจากรันเดียวกับการ์ดก่อน ซึ่ง model ขอรัน `rm -rf build && npm test` แทน
          ดู `input` ที่ไฮไลต์
        from: model
        to: engine
        sees:
          kind: payload
          source: docs/results/real-usecases/runs/A08-ask-risky-denied/1/session.jsonl#seq=8
          select: content
          collapse: ['[0].thinking']
          highlight: ['[2].input']
      lane: model
      do: >-
        model stream ข้อความสั้นๆ แล้วขอเรียก `bash` ด้วย `git reset --hard HEAD~1` จบด้วย `stop_reason: tool_use`
      ref: "packages/engine/src/gateway.ts#\"stopReason: message.stop_reason,\""
      emits: [tool_use]

    - id: printed
      lane: panel
      at: terminal
      do: >-
        ข้อความของ model เขียนลง stdout ทีละส่วน และทุก call ที่เริ่มพิมพ์บรรทัด `> ` ตามด้วยชื่อขั้น
      sees: "> bash git reset --hard HEAD~1"
      ref: packages/engine/src/drive.ts#terminalSurface

    - id: judge
      beat:
        title: Geno จับคำสั่งด้วยกฎ git reset --hard
        text: >-
          คำสั่งนี้ทิ้ง commit และงานที่ยังไม่ commit ได้ กฎในตัวของ Geno จึงจับมัน โหมด Ask ต้องถาม โหมด Auto ให้ classifier
          (การเรียก model แยกที่ตอบว่า allow ask หรือ deny) ตัดสิน และ non-interactive ปฏิเสธ
          ทางเลือกข้างล่างเดินเฉพาะโหมด Ask (ค่าเริ่มต้น) กับ non-interactive ส่วนโหมด Auto ดูท้ายหน้า
        from: engine
        to: engine
        ask: ใครตอบ
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
                beat:
                  title: เทอร์มินัลถาม [y/N]
                  text: Geno รอบรรทัดจากเทอร์มินัล
                  from: panel
                  to: you
                  sees: "Allow `git reset --hard HEAD~1`? It uses git reset --hard. [y/N] "
                at: terminal
                do: >-
                  `askOnTerminal` ถามผ่าน `terminalConfirm` ซึ่งรอบรรทัดจากเทอร์มินัล
                sees: >-
                  "Allow `git reset --hard HEAD~1`? It uses git reset --hard. [y/N] "
                ref: packages/engine/src/terminal-confirm.ts#terminalConfirm
                phase: waiting-user
              - lane: user
                beat:
                  title: คุณพิมพ์ y
                  text: Geno จดว่าคุณเป็นคนอนุญาต
                  from: you
                  to: panel
                do: ผู้ใช้พิมพ์ y แล้วกด Enter
              - lane: policy
                at: settle
                do: >-
                  `settle` คืนบันทึก `decidedBy: user, verdict: allow`
                ref: packages/engine/src/tools/agent.ts#settle
                phase: running-tools
              - lane: tool
                beat:
                  title: คำสั่งรันใน sandbox
                  text: >-
                    sandbox (กรอบของระบบปฏิบัติการที่ให้คำสั่งเขียนได้แค่ใน workspace กับโฟลเดอร์ชั่วคราว) ยังครอบคำสั่งอยู่
                    ไฟล์ใน workspace กลับไปเป็นของ commit ก่อนหน้า
                  from: engine
                  to: machine
                at: shell
                do: >-
                  `bash` รันคำสั่งใน sandbox ไฟล์ใน workspace กลับไปเป็นของ commit ก่อนหน้า
                ref: "packages/engine/src/tools/agent.ts#\"tools.sandbox.run(command\""
              - use: model-call
              - lane: model
                beat:
                  title: Model บอกว่าทิ้ง commit แล้ว
                  text: >-
                    model อ่านผลแล้วตอบ turn จบ การ์ดข้างล่างเป็นคำตอบจริงจาก `gcode agent` อีกรัน ที่ model อ่านผลของคำสั่ง git
                    ที่รันแล้ว ตอบสรุป และจบด้วย `stop_reason: end_turn` ดู `text` ที่ไฮไลต์ซึ่งเป็นคำตอบที่พิมพ์ออก stdout
                  from: model
                  to: engine
                  sees:
                    kind: payload
                    source: docs/results/real-usecases/runs/A24-git-commit-safety/1/session.jsonl#seq=20
                    select: content
                    collapse: ['[0].thinking']
                    highlight: ['[1].text']
                do: >-
                  model อ่านผลแล้วตอบว่าทิ้ง commit แล้ว จบด้วย `stop_reason: end_turn`
                ref: "packages/engine/src/gateway.ts#\"stopReason: message.stop_reason,\""
                emits: [end_turn]
              - lane: loop
                beat:
                  title: process จบด้วย exit 0
                  text: Geno พิมพ์ยอดใช้งานลง stdout แล้วคืน exit code ตามวิธีที่ turn จบ
                  from: engine
                  to: panel
                  sees: "usage: ... turns=2"
                  end: process จบ exit 0
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
                beat:
                  title: เทอร์มินัลถาม [y/N]
                  text: คำตอบที่ไม่ใช่ y หรือ yes นับเป็นไม่
                  from: panel
                  to: you
                  sees: "Allow `git reset --hard HEAD~1`? It uses git reset --hard. [y/N] "
                at: terminal
                do: >-
                  `terminalConfirm` ถามแบบเดียวกัน คำตอบที่ไม่ใช่ y หรือ yes นับเป็นไม่
                sees: >-
                  "Allow `git reset --hard HEAD~1`? It uses git reset --hard. [y/N] "
                ref: packages/engine/src/terminal-confirm.ts#terminalConfirm
                phase: waiting-user
              - lane: user
                beat:
                  title: คุณกด Enter เฉยๆ
                  text: N เป็นค่าเริ่มต้น Geno ถือว่าคุณปฏิเสธ
                  from: you
                  to: panel
                do: ผู้ใช้กด Enter เฉยๆ

          - id: no-tty
            label: stdin ไม่ใช่เทอร์มินัล
            then: rejected
            steps:
              - lane: panel
                beat:
                  title: ไม่มีเทอร์มินัลให้ตอบ
                  text: stdin เป็น pipe ไม่มีคนตอบ Geno จึงตอบไม่ทันที และเขียนเหตุไว้
                  from: panel
                  to: engine
                  sees: Allow `git reset --hard HEAD~1`? It uses git reset --hard. There is no terminal to answer, so it was refused.
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
                beat:
                  title: กฎปฏิเสธทันที
                  text: >-
                    ในโหมด non-interactive hook `PermissionRequest` (คำสั่ง shell ที่คุณตั้งให้ตอบคำถามสิทธิ์แทนได้) มีสิทธิ์ตอบก่อน
                    แต่ไม่มี hook ตั้งไว้ Geno จึงปฏิเสธ การปฏิเสธนี้ไม่จบ turn Geno เขียนผลไว้ใน log
                    ผลนี้บอก model ว่าไม่มีใครตอบได้ที่นี่ และถึง model ตอนเรียกครั้งถัดไป
                  from: engine
                  to: engine
                at: settle
                do: >-
                  ในโหมด non-interactive กฎนี้ปฏิเสธเลย `settle` ให้ PermissionRequest hook ตอบแทนได้ก่อน ไม่มี hook
                  จึงบันทึก `decidedBy: rule, verdict: deny` เป็น `ToolDenied` ซึ่งไม่จบ turn
                ref: packages/engine/src/tools/agent.ts#denialText
                emits: [ToolDenied]
              - lane: loop
                at: tools
                do: >-
                  ผลของ call บอก model ว่า "denied: `git reset --hard HEAD~1` uses git reset --hard, which needs the user's approval,
                  and nobody can answer here." ตามด้วยคำแนะนำว่าอย่าหาทางเลี่ยงเจตนาของการปฏิเสธ
                ref: packages/core/src/loop.ts#DONT_ASK
                emits: [denied]
              - use: model-call
              - lane: model
                beat:
                  title: Model อธิบายว่าต้องให้คุณอนุญาต
                  text: >-
                    model บอกคำสั่งที่คุณรันเองได้ แล้วจบ turn การ์ดข้างล่างเป็นคำตอบจริงจาก `gcode agent` อีกรันที่ถูกปฏิเสธเพราะไม่มีใครตอบได้
                    ในรันนั้นคือ path นอก workspace model อธิบายว่าทำต่อไม่ได้ (แท็บแรก) และคุณต้องทำอะไร (แท็บสอง) แล้วจบด้วย `stop_reason: end_turn`
                    สองแท็บคือ `text` ที่ไฮไลต์อันเดียวกัน แต่แสดงคนละช่วง
                  from: model
                  to: engine
                  sees:
                    - kind: payload
                      source: docs/results/real-usecases/runs/A32-outside-explicit/1/session.jsonl#seq=15
                      select: content
                      collapse: ['[0].thinking']
                      highlight: ['[1].text']
                      quote: I can't complete the comparison
                    - kind: payload
                      source: docs/results/real-usecases/runs/A32-outside-explicit/1/session.jsonl#seq=15
                      select: content
                      collapse: ['[0].thinking']
                      highlight: ['[1].text']
                      quote: Add the parent directory
                do: >-
                  model อธิบายว่าต้องให้ผู้ใช้อนุญาต และบอกคำสั่งที่ผู้ใช้รันเองได้ จบด้วย `stop_reason: end_turn`
                ref: "packages/engine/src/gateway.ts#\"stopReason: message.stop_reason,\""
                emits: [end_turn]
              - lane: panel
                beat:
                  title: process จบด้วย exit 0
                  text: run จบแบบปกติจึงได้ exit 0 ทั้งที่งานไม่ได้ทำ
                  from: engine
                  to: panel
                  sees: "usage: ... turns=2"
                  end: exit 0 แต่งานไม่ได้ทำ
                at: terminal
                do: >-
                  `finish` พิมพ์ยอดใช้งาน run จบแบบ `end_turn` จึงได้ exit code 0 ทั้งที่งานไม่ได้ทำ
                sees: "usage: ... turns=2 แล้ว process จบด้วย exit code 0"
                ref: packages/engine/src/drive.ts#finish
                phase: ending
                end: { turn: done, reason: end_turn }

    - id: rejected
      beat:
        title: คำสั่งไม่ได้รัน
        text: >-
          Geno ถือว่าคุณปฏิเสธ ผลบอก model ให้หยุดรอคุณ การ์ดเป็นผลจริงจาก `gcode agent` ที่ไม่มีเทอร์มินัลให้ตอบ
          ซึ่งปฏิเสธ `rm -rf build` แบบเดียวกัน ดู `status` ที่เป็น `rejected` และ `output` ที่บอก model ให้หยุดรอ
        from: engine
        to: model
        sees:
          kind: payload
          source: docs/results/real-usecases/runs/A08-ask-risky-denied/1/session.jsonl#seq=9
          highlight:
            - status
            - output
      lane: policy
      at: settle
      do: >-
        `askOnTerminal` ได้ `reject` `settle` คืนบันทึก `decidedBy: user, verdict: deny` และ `refusalOf` โยน `ToolRejected`
        คำสั่งไม่ได้รัน
      ref: packages/engine/src/tools/agent.ts#refusalOf
      emits: [ToolRejected]
      phase: running-tools

    - id: stops
      beat:
        title: Geno จบ turn ทันที
        text: Geno ไม่เรียก model อีก แล้วพิมพ์ยอดใช้งาน process จบด้วย exit 0
        from: engine
        to: panel
        sees: "usage: ... turns=1"
        end: process จบ exit 0
      lane: loop
      at: step
      do: >-
        ผล `rejected` บอก model ให้หยุดรอผู้ใช้ `loopStep` ตัดสิน `done(end_turn)` ทันทีโดยไม่เรียก model อีก
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
| 1 | error ของผู้ให้บริการ model ไม่ยอมตอบ (`stop_reason: refusal`) หรือ hook บล็อก |
| 2 | ใช้แฟล็กผิด |
| 3 | ถึงขีดจำกัด `--max-turns` หรือ `--max-cost` |
| 130 | ผู้ใช้กด Ctrl-C |

สิ่งที่ควรสังเกต

- **ตอบไม่แล้วยังได้ 0** exit code บอกว่ารอบจบอย่างไร ไม่ได้บอกว่างานสำเร็จ สคริปต์ที่เรียก `gcode agent`
  ต้องอ่านข้อความด้วยถ้าอยากรู้ว่าคำสั่งถูกปฏิเสธ
- **ไม่มีเทอร์มินัลก็บันทึกว่าผู้ใช้ปฏิเสธ** เมื่อ stdin ไม่ใช่เทอร์มินัล `terminalConfirm` ตอบไม่แทน แต่ `settle` คืนบันทึก
  `decidedBy: user` เหมือนผู้ใช้กดไม่เอง turn จึงจบแบบเดียวกับการปฏิเสธของคน ต่างจาก `--non-interactive` ที่ทำต่อได้
- **hook ของ workspace ไม่รัน** บรรทัดคำสั่งไม่มี editor ที่ยืนยันว่าผู้ใช้เชื่อถือโฟลเดอร์ จึงรันเฉพาะ hook ของผู้ใช้
- **non-interactive ไม่ได้ปฏิเสธทุกอย่าง** คำสั่งที่ไม่อยู่ใน safe list แต่ไม่มีกฎจับ (`unlisted`) รันได้ใน sandbox
  กฎ allow ของ workspace ไม่มีผลในโหมดนี้ และ `--mode` ใช้คู่กับ `--non-interactive` ไม่ได้
- **Auto บนเทอร์มินัล** เมื่อ classifier ตัดสิน เทอร์มินัลพิมพ์ `auto: the classifier allowed it: ...` หรือ `auto: the classifier denied it: ...` พร้อมเหตุผลใต้บรรทัดของ call
  คำปฏิเสธไม่ถามคุณ model ได้เหตุผลแล้วทำต่อ คำถาม y/n ขึ้นเมื่อ classifier ปฏิเสธมาแล้วติดกัน 3 ครั้งหรือรวม 20 ครั้งใน session
  หรือเมื่อ classifier ใช้ไม่ได้เลย ซึ่งถ้าเป็นเพราะตั้งค่าไม่ครบหรือ key ถูกปฏิเสธ เทอร์มินัลบอกทาง stderr ครั้งเดียว
