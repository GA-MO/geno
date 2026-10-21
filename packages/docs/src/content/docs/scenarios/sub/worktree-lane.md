---
title: "subagent ใน worktree แยก"
description: model ขอลูก worker แบบ isolation worktree ลูกได้ git worktree ของตัวเองบน branch geno/ แก้ไฟล์ที่นั่น แล้ว lane ถูกเก็บไว้ให้ผู้ใช้ตรวจหรือถูกลบถ้าไม่มีอะไรเปลี่ยน
scenario:
  surface: vscode
  given:
    - ค่า `agentTool` มีโหมดปัจจุบัน workspace เป็น git repository
    - เปิด Geno ในโหมด Auto ผู้ใช้กำลังแก้ไฟล์ใน checkout หลักอยู่
  trigger: >-
    ผู้ใช้ขอให้ `parseVersion` โยน error เมื่อได้สตริงว่าง ใน lane แยก โดยไม่ยุ่งกับงานที่ทำค้างอยู่ model ขอ `agent` แบบ `isolation: "worktree"`
  covers: [sub.worktree-lane]
  related: [wf.lane-apply, sub.blocking-report, sub.fork, wf.arena-best-of-n]
  steps:
    - id: wants
      beat:
        title: Model ขอ worker ใน worktree ของตัวเอง
        text: >-
          worker คือ subagent ในตัว Geno ที่แก้ไฟล์ได้ (subagent คือ session ลูกที่ทำงานย่อยแล้วส่งรายงานกลับให้แม่)
          git worktree คือโฟลเดอร์ที่สองของ repo เดียวกันบน branch ของตัวเอง ให้ worker แก้ไฟล์โดยไม่ยุ่งกับโฟลเดอร์ที่คุณทำงานอยู่
          schema ของ tool `agent` มี `isolation` ที่มีค่าเดียวคือ `worktree` (แท็บแรก ดูที่ไฮไลต์) model ส่ง `tool_use` ที่มี
          `agent: "worker"`, `isolation: "worktree"` และ `task` ที่เขียนให้ครบในตัว (แท็บสอง) ไม่มี `background` จึงรอรายงาน
        from: model
        to: engine
        sees:
          - kind: payload
            source: packages/docs/src/data/recorded/worktree-lane.jsonl#line=2
            select: tools[9]
            highlight: [input_schema.properties.isolation]
          - kind: payload
            source: packages/docs/src/data/recorded/worktree-lane.jsonl#line=10
            select: messages[1].content
            highlight: ['[0].input']
      lane: model
      do: >-
        model ขอเรียก `agent` ด้วย `agent: "worker"`, `isolation: "worktree"` และ task ที่เขียนให้ครบในตัว
        จบคำตอบด้วย `stop_reason: tool_use`
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

    - id: want
      beat:
        title: Geno ขอ lane ให้ worker
        text: >-
          Geno เรียก worktree ที่มันสร้างว่า lane lane คือ checkout แยกของ worker มันไม่แตะ checkout หลัก (โฟลเดอร์ที่คุณเปิดอยู่)
          ปกติลูกที่แก้ไฟล์ต้องรอคิวรันทีละตัวบน checkout หลัก worker ใน lane จึงรันพร้อมลูกตัวอื่นได้ แทนที่จะรอคิว
        from: engine
        to: engine
      lane: loop
      at: tools
      runs: 1
      do: >-
        `laneWant` เห็น `isolation: "worktree"` จึงขอ lane ของลูกเอง ชื่อ `worker-<8 ตัวแรกของ session id>`
        ลูกที่อยู่ใน lane ของตัวเองไม่แตะ checkout หลัก จึงรันพร้อมลูกอื่นได้ (ช่องขนาน 4 ช่อง) แทนที่จะรอคิว writer
      ref: "packages/engine/src/subagents.ts#\"const laneWant = (agent: AgentDefinition\""

    - id: lane
      beat:
        title: Geno สร้าง git worktree บน branch `geno/`
        text: >-
          worktree อยู่ใต้ `.geno/worktrees/` Geno คัดลอกไฟล์ที่ต้องใช้และ `node_modules` (บน macOS) ไปไว้ในนั้น
          sandbox ของ worker (กรอบที่จำกัดว่าคำสั่งเขียนไฟล์ได้ที่ไหน) ครอบแค่ lane และไฟล์ที่มันแก้ลงดิสก์ตรงๆ
          ไม่ผ่าน editor ของ VS Code ข้อความแรกของ worker บอกว่า workspace ของมันคือ lane
          บน branch ไหน checkout หลักอยู่ที่ไหน และห้าม `git stash` เปล่าๆ เพราะ stash ใช้ร่วมกันทุก lane
          ในการ์ด บล็อกแรกที่ไฮไลต์คือข้อมูลสภาพแวดล้อม แท็บแรกแสดงบรรทัด Lane ที่บอกว่า workspace นี้เป็น lane บน branch ไหน และ checkout หลักอยู่ที่ไหน
          แท็บสองแสดงคำห้าม `git stash` เปล่าๆ บล็อกที่สองคือ `task` ที่แม่เขียน
        from: engine
        to: machine
        sees:
          - kind: payload
            source: packages/docs/src/data/recorded/worktree-lane.jsonl#line=4
            select: messages[0]
            highlight: ['content[0].text', 'content[1].text']
            quote: "Lane: worker-00000002, a git worktree on branch geno/worker-00000002; the main checkout is /home/dev/shop."
          - kind: payload
            source: packages/docs/src/data/recorded/worktree-lane.jsonl#line=4
            select: messages[0]
            highlight: ['content[0].text', 'content[1].text']
            quote: >-
              Git's stash stack is shared by the main checkout and every lane, and other sessions may push or pop it while you work. Never run a bare git stash or git stash pop
      lane: loop
      at: agent
      do: >-
        `openLane` เปิด lane ทีละตัวเพื่อไม่ให้ `git worktree add` ชนกัน `laneFor` สร้าง worktree ที่ `.geno/worktrees/<ชื่อ>`
        บน branch `geno/<ชื่อ>` คัดลอกไฟล์ตาม `.worktreeinclude` โคลน `node_modules` รันคำสั่ง setup ที่ผู้ใช้อนุมัติไว้
        แล้วรัน LaneCreated hook ของผู้ใช้
      ref: packages/engine/src/lane-hooks.ts#laneFor

    - id: bind
      lane: loop
      at: agent
      do: >-
        `childLane` ผูก session ของลูกกับ lane และเปิด sandbox ของ lane เอง: ลูกเขียนได้เฉพาะใน lane
        executor ของลูกทำงานที่ path ของ lane และไฟล์ที่ลูกแก้ลงดิสก์ตรงๆ ไม่ผ่าน buffer ของ editor
      ref: "packages/engine/src/agent.ts#\"const childLane: OpenChildLane = async (name, child) => {\""

    - id: spawn
      lane: child@worker
      at: loop
      do: >-
        `openSpawn` เปิด log ของลูก สภาพแวดล้อมถูกอ่านใหม่จาก lane ลูกจึงรู้ว่า workspace ของตัวเองคือ path ของ lane
      ref: packages/engine/src/subagents.ts#openSpawn

    - id: noted
      beat:
        title: แชตขึ้นแถวของ worker
        text: แถวของ worker ขึ้นใต้ขั้นที่ส่งงาน ไฟล์ที่คุณเปิดอยู่ใน checkout หลักไม่ถูกแตะ
        from: panel
        to: you
        sees:
          kind: task
          title: worker
          status: running
          detail: 0:05
          actions:
            - Cancel
      lane: loop
      at: drive
      do: >-
        `runPlaced` บันทึก `child-start` ลง log ของแม่ แล้ว `subagent_update` สถานะ `running` ทำให้แถวของลูกขึ้นใต้ขั้นของ `agent`
      ref: "packages/engine/src/subagents.ts#\"await ctx.logNote!({ kind: 'child-start'\""
      emits: [child-start, subagent_update]

    - id: row
      lane: panel
      at: rail
      alongside: true
      do: >-
        แถวของลูกขึ้นใต้ขั้นของ `agent` ไฟล์ที่ผู้ใช้เปิดอยู่ใน checkout หลักไม่ถูกแตะ
      sees: แถว "worker · <model> · 0:05" พร้อมไดโนเสาร์ที่ขยับ และปุ่ม [Cancel]
      ref: packages/extension/src/chat/subagent-view.ts#childRow

    - id: works
      beat:
        title: worker ทำงานใน lane แล้วเรียก `report`
        text: >-
          worker อ่าน `src/version.ts` ใน lane การ์ดไฮไลต์ `input` ของ `read` path ในนั้นเป็น path เดียวกับ checkout หลัก
          แต่ไฟล์ที่ถูกอ่านคือของ lane จากนั้น worker แก้ไฟล์หรือไม่แก้ก็ได้ตามที่งานต้องการ แล้วเรียก `report` ที่สรุปสิ่งที่ทำ
        from: model
        to: engine
        sees:
          kind: payload
          source: packages/docs/src/data/recorded/worktree-lane.jsonl#line=6
          select: messages[1].content
          highlight: ['[0].input']
      lane: child@worker
      at: model
      do: >-
        ลูกเรียก model อ่าน `src/version.ts` ใน lane แก้ไฟล์ถ้างานต้องการ
        แล้วจบด้วยการเรียก `report` ที่สรุปสิ่งที่ทำ
      ref: packages/engine/src/subagents.ts#reportExecutor
      emits: [report]

    - id: settle
      beat:
        title: Geno ตรวจ lane หลัง worker จบ
        text: สิ่งที่ Geno ทำกับ lane ขึ้นกับว่า worker เปลี่ยนไฟล์หรือไม่
        from: engine
        to: engine
        ask: worker เปลี่ยนอะไรไหม
      lane: loop
      at: tools
      do: >-
        `settleChildLane` ตรวจสถานะของ lane หลังลูกจบ
      ref: packages/engine/src/lanes.ts#settleChildLane
      fork:
        ask: ลูกเปลี่ยนอะไรใน lane ไหม
        options:
          - id: changed
            label: เปลี่ยน
            then: row-done
            steps:
              - lane: child@worker
                beat:
                  title: worker แก้ `src/version.ts` ใน lane
                  text: >-
                    ทางนี้ worker แก้ `src/version.ts` ใน lane ก่อนเรียก `report` การ์ดไฮไลต์ `input` ของ `edit`
                    path ในนั้นเป็น path เดียวกับ checkout หลัก แต่ไฟล์ที่ถูกแก้คือของ lane Geno จึงพบว่า lane เปลี่ยน
                  from: model
                  to: engine
                  sees:
                    kind: payload
                    source: packages/docs/src/data/recorded/worktree-lane.jsonl#line=8
                    select: messages[3].content
                    highlight: ['[0].input']
                at: model
                do: >-
                  ก่อน `report` ลูกเรียก `edit` บน `src/version.ts` ใน lane `settleChildLane` จึงเห็นไฟล์ที่เปลี่ยนใน lane
                ref: packages/engine/src/lanes.ts#settleChildLane
              - lane: loop
                beat:
                  title: Geno เก็บ lane ไว้ให้คุณตรวจ
                  text: Geno จดว่างานอยู่ใน lane ไหน บน branch อะไร และยังไม่อยู่ใน checkout ของแม่ คุณนำกลับมาได้จากแผง Lanes
                  from: engine
                  to: engine
                at: tools
                do: >-
                  lane มีการเปลี่ยนแปลง จึงถูกเก็บไว้พร้อมรายการไฟล์ที่เปลี่ยน
                  `keptLaneNote` เขียนโน้ตว่างานอยู่ใน lane ไหน บน branch อะไร ที่ path ไหน ยังไม่อยู่ใน checkout ของแม่
                  และผู้ใช้นำกลับมาได้จากแผง Lanes หรือ `gcode lane apply`
                ref: "packages/engine/src/subagents.ts#\"const keptLaneNote = (agent: AgentDefinition\""

          - id: unchanged
            label: ไม่เปลี่ยน
            steps:
              - lane: loop
                beat:
                  title: Geno ลบ lane ทิ้ง
                  text: worker ไม่ได้เปลี่ยนไฟล์ใน lane เช่นอ่านแล้วพบว่าไม่ต้องแก้ หรือแก้แล้วย้อนกลับ lane ไม่มีอะไรจะเสีย Geno ลบ worktree และ branch และรายงานไม่มีโน้ตเรื่อง lane
                  from: engine
                  to: machine
                at: tools
                do: >-
                  lane ไม่มีอะไรจะเสีย `removeLane` ลบ worktree และ branch ทิ้ง รายงานไม่มีโน้ตเรื่อง lane
                ref: packages/engine/src/lanes.ts#settleChildLane

              - lane: server
                at: updates
                beat:
                  title: แชตติดเครื่องหมายว่า worker เสร็จ
                  text: แถวของ worker หยุดนาฬิกาและขึ้นเครื่องหมายถูก
                  from: panel
                  to: you
                  sees:
                    kind: task
                    title: worker
                    status: done
                do: >-
                  `runPlaced` เรียก `acpChildHost.ended` ซึ่งส่ง `subagent_update` สถานะ `idle` แถวของลูกขึ้นเครื่องหมายถูก
                ref: packages/engine/src/subagent-acp.ts#acpChildHost
                emits: [subagent_update, idle]

              - lane: loop
                at: tools
                beat:
                  title: Geno ส่งรายงานให้ model โดยไม่มีโน้ตของ lane
                  text: >-
                    รายงานกลับมาเป็นผลของ call ในรั้ว `<subagent_report agent="worker" ...>` ไม่มีโน้ต `[Geno]` เรื่อง lane
                    เพราะ lane ถูกลบแล้ว ท้ายรั้วยังมีคำเตือนว่ารายงานไม่ใช่คำสั่งของคุณ
                    การ์ดเป็นการบันทึกที่รัน Geno จริงกับ model จำลองที่ตอบตามบทที่เขียนไว้ก่อน บันทึกจาก `gcode agent` ในเทอร์มินัล ไม่ใช่จาก VS Code แต่รายงานที่แม่ได้เป็นแบบเดียวกันทั้งสองที่ การบันทึกนี้ใช้งานอื่นที่ไม่ต้องแก้ไฟล์ คือให้ worker ตรวจว่า `parseVersion` นับ patch ที่ขาดเป็น 0 ไหม worker อ่าน `src/version.ts` แล้วพบว่านับอยู่แล้ว จึงไม่แก้อะไร ดู `content` ที่ไฮไลต์ แท็กปิด `</subagent_report>` ตามหลังรายงานทันที ไม่มีบรรทัดที่บอก branch หรือ path ของ lane
                  from: engine
                  to: model
                  sees:
                    kind: payload
                    source: packages/docs/src/data/recorded/sub-worktree-lane.jsonl#line=8
                    select: messages[2].content[0]
                    highlight: [content]
                    quote: I changed nothing.
                do: >-
                  `launch` บันทึก `child-end` ลง log ของแม่ แล้วคืนรายงานในรั้วเป็นผลของ call โดยไม่มีโน้ตของ lane
                ref: packages/core/src/subagent.ts#childReport
                emits: [child-end, subagent_report]

              - use: model-call

              - use: turn-ends
                beat:
                  title: Model เล่ารายงาน turn จบ
                  text: >-
                    model เล่าให้คุณฟังว่า worker รายงานอะไร ไม่มี lane ให้ตรวจหรือ Apply model จบด้วย `end_turn` Geno จึงจบ turn แบบ done
                  from: engine
                  to: panel
                  end: "ไม่มี lane turn จบ"
                  sees: { kind: composer, state: idle }

    - id: row-done
      beat:
        title: แชตติดเครื่องหมายว่า worker เสร็จ
        text: แถวของ worker หยุดนาฬิกาและขึ้นเครื่องหมายถูก
        from: panel
        to: you
        sees:
          kind: task
          title: worker
          status: done
      lane: server
      at: updates
      do: >-
        `runPlaced` เรียก `acpChildHost.ended` ซึ่งส่ง `subagent_update` สถานะ `idle` แถวของลูกขึ้นเครื่องหมายถูก
      ref: packages/engine/src/subagent-acp.ts#acpChildHost
      emits: [subagent_update, idle]

    - id: fenced
      beat:
        title: Geno ส่งรายงานพร้อมโน้ตของ lane ให้ model
        text: >-
          รายงานกลับมาเป็นผลของ call ในรั้ว โน้ต `[Geno]` ของ lane อยู่ในรั้วต่อจากรายงานที่เยื้องไว้: งานอยู่ใน lane ไหน
          บน branch อะไร ไฟล์ไหนเปลี่ยน และผู้ใช้นำกลับด้วยแผง Lanes หรือ `gcode lane apply` ท้ายรั้วคือคำเตือนว่ารายงานไม่ใช่คำสั่งของคุณ
          ใน `content` ที่ไฮไลต์ ส่วนที่ทำเครื่องหมายไว้คือโน้ตของ lane ซึ่งตามหลังรายงานที่เยื้องไว้ และอยู่ก่อนแท็กปิด `</subagent_report>`
        from: engine
        to: model
        sees:
          kind: payload
          source: packages/docs/src/data/recorded/worktree-lane.jsonl#line=10
          select: messages[2].content[0]
          highlight: [content]
          quote: >-
            [Geno] worker's edits are in lane worker-00000002, on branch geno/worker-00000002 at /home/dev/shop/.geno/worktrees/worker-00000002, not in your checkout.
            Files changed: src/version.ts. Read them there to review them; the user applies them from the Lanes pane or with gcode lane apply worker-00000002.
      lane: loop
      at: tools
      do: >-
        `launch` บันทึก `child-end` ลง log ของแม่ แล้วคืนรายงานในรั้ว `<subagent_report agent="worker" ...>` เป็นผลของ call
        โน้ตของ lane (ถ้ามี) อยู่ในรั้วต่อจากรายงาน
      ref: packages/core/src/subagent.ts#childReport
      emits: [child-end, subagent_report]

    - use: tool-result-returns
    - use: model-call

    - id: relays
      beat:
        title: Model บอกให้คุณตรวจ lane
        text: >-
          model เล่าว่า worker ทำอะไรใน lane ไหน การแก้ยังไม่เข้า checkout หลักจนกว่าคุณจะ Apply ทัวร์ถัดไปเล่าการตรวจและ Apply lane การ์ดข้างล่างคือท้าย stream ของคำตอบนั้น model จบด้วย `stop_reason: end_turn`
        from: model
        to: engine
        sees:
          kind: payload
          source: packages/docs/src/data/recorded/worktree-lane.jsonl#line=11
          select: '[-2]'
          highlight: [data.delta.stop_reason]
        end: ไปตรวจและ Apply lane
      lane: model
      do: >-
        model ของแม่เล่าว่า worker ทำอะไรใน lane ไหน และบอกให้ผู้ใช้ตรวจแล้วนำกลับมาจากแผง Lanes
        การแก้ยังไม่เข้า checkout หลักจนกว่าผู้ใช้จะ Apply
      ref: "packages/engine/src/gateway.ts#\"stopReason: message.stop_reason,\""
      emits: [end_turn]
      goto: wf.lane-apply
---

lane คือ git worktree ที่ Geno สร้างและจดไว้ใน `<git common dir>/geno/lanes/<ชื่อ>.json`
ลูกที่อยู่ใน lane แก้ไฟล์ได้โดยไม่ชนกับผู้ใช้หรือกับลูกตัวอื่น เพราะแต่ละตัวมี checkout ของตัวเอง

สิ่งที่ควรสังเกต

- **การแก้ใน lane ไม่ผ่าน review ของ editor** ไฟล์ลงดิสก์ใน lane โดยตรง ผู้ใช้เห็น [hunk](/start/glossary/) เมื่อ Apply lane กลับมาที่ checkout หลัก
- **lane ที่ไม่เปลี่ยนหายไปเอง** ลูกที่แค่อ่านใน lane ไม่ทิ้งอะไรไว้
- **ลูกแบบเบื้องหลังที่แก้ไฟล์ต้องอยู่ใน lane** `background: true` กับ `worker` ที่ไม่มี `isolation: "worktree"` ถูกปฏิเสธ
- **setup ของ repo ต้องอนุมัติก่อน** คำสั่ง setup ที่ repo ขอให้รันใน lane ใหม่รันเฉพาะเมื่อผู้ใช้อนุมัติด้วย `gcode lane new --approve-setup` ครั้งหนึ่ง
  ไม่อย่างนั้น engine เขียนลง output channel ว่าไม่ได้รัน
