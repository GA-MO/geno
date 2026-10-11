---
title: เอเจนต์ลูกใน worktree แยก
description: โมเดลขอลูก worker แบบ isolation worktree ลูกได้ git worktree ของตัวเองบน branch geno/ แก้ไฟล์ที่นั่น แล้ว lane ถูกเก็บไว้ให้ผู้ใช้ตรวจหรือถูกลบถ้าไม่มีอะไรเปลี่ยน
tableOfContents: false
sidebar:
  order: 6
scenario:
  surface: vscode
  given:
    - ค่า `agentTool` มีโหมดปัจจุบัน workspace เป็น git repository
    - เปิด Geno ในโหมด Auto ผู้ใช้กำลังแก้ไฟล์ใน checkout หลักอยู่
  trigger: >-
    ผู้ใช้ขอให้ลองย้าย `src/log.ts` ไปใช้ pino โดยไม่ยุ่งกับงานที่ทำค้างอยู่ โมเดลขอ `agent` แบบ `isolation: "worktree"`
  covers: [sub.worktree-lane]
  related: [wf.lane-apply, sub.blocking-report, sub.fork, wf.arena-best-of-n]
  steps:
    - id: wants
      lane: model
      do: >-
        โมเดลขอเรียก `agent` ด้วย `agent: "worker"`, `isolation: "worktree"` และ task ที่เขียนให้ครบในตัว
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
      lane: loop
      at: tools
      runs: 1
      do: >-
        `laneWant` เห็น `isolation: "worktree"` จึงขอ lane ของลูกเอง ชื่อ `worker-<8 ตัวแรกของ session id>`
        ลูกที่อยู่ใน lane ของตัวเองไม่แตะ checkout หลัก จึงรันพร้อมลูกอื่นได้ (ช่องขนาน 4 ช่อง) แทนที่จะรอคิว writer
      ref: "packages/engine/src/subagents.ts#\"const laneWant = (agent: AgentDefinition\""

    - id: lane
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
      sees: แถว "worker · <โมเดล> · 0:05" พร้อมไดโนเสาร์ที่ขยับ และปุ่ม [Cancel]
      ref: packages/extension/src/chat/subagent-view.ts#childRow

    - id: works
      lane: child@worker
      at: model
      do: >-
        ลูกเรียกโมเดล อ่านและแก้ `src/log.ts` กับ `package.json` ใน lane แล้วรันเทสต์ใน sandbox ของ lane
        จบด้วยการเรียก `report` ที่สรุปสิ่งที่เปลี่ยน
      ref: packages/engine/src/subagents.ts#reportExecutor
      emits: [report]

    - id: settle
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
            then: fenced
            steps:
              - lane: loop
                at: tools
                do: >-
                  lane มีการเปลี่ยนแปลง จึงถูกเก็บไว้พร้อมรายการไฟล์ที่เปลี่ยน
                  `keptLaneNote` เขียนโน้ตว่างานอยู่ใน lane ไหน บน branch อะไร ที่ path ไหน ยังไม่อยู่ใน checkout ของแม่
                  และผู้ใช้นำกลับมาได้จากแผง Lanes หรือ `gcode lane apply`
                ref: "packages/engine/src/subagents.ts#\"const keptLaneNote = (agent: AgentDefinition\""

          - id: unchanged
            label: ไม่เปลี่ยน
            then: fenced
            steps:
              - lane: loop
                at: tools
                do: >-
                  lane ไม่มีอะไรจะเสีย `removeLane` ลบ worktree และ branch ทิ้ง รายงานไม่มีโน้ตเรื่อง lane
                ref: packages/engine/src/lanes.ts#settleChildLane

    - id: fenced
      lane: loop
      at: tools
      do: >-
        `launch` บันทึก `child-end` ลง log ของแม่ แล้วคืนรายงานในรั้ว `<subagent_report agent="worker" ...>` เป็นผลของ call
        โน้ตของ lane (ถ้ามี) อยู่ในรั้วต่อจากรายงาน
      ref: packages/core/src/subagent.ts#childReport
      emits: [child-end, subagent_report]

    - id: row-done
      lane: server
      at: updates
      alongside: true
      do: >-
        `acpChildHost.ended` ส่ง `subagent_update` สถานะ `idle` แถวของลูกขึ้น Done
      ref: packages/engine/src/subagent-acp.ts#acpChildHost
      emits: [subagent_update, idle]

    - use: tool-result-returns
    - use: model-call

    - id: relays
      lane: model
      do: >-
        โมเดลของแม่เล่าว่า worker ทำอะไรใน lane ไหน และบอกให้ผู้ใช้ตรวจแล้วนำกลับมาจากแผง Lanes
        การแก้ยังไม่เข้า checkout หลักจนกว่าผู้ใช้จะ Apply
      ref: "packages/engine/src/gateway.ts#\"stopReason: message.stop_reason,\""
      emits: [end_turn]
      goto: wf.lane-apply
---

lane คือ git worktree ที่ Geno สร้างและจดไว้ใน `<git common dir>/geno/lanes/<ชื่อ>.json`
ลูกที่อยู่ใน lane แก้ไฟล์ได้โดยไม่ชนกับผู้ใช้หรือกับลูกตัวอื่น เพราะแต่ละตัวมี checkout ของตัวเอง

สิ่งที่ควรสังเกต

- **การแก้ใน lane ไม่ผ่าน review ของ editor** ไฟล์ลงดิสก์ใน lane โดยตรง ผู้ใช้เห็น hunk เมื่อ Apply lane กลับมาที่ checkout หลัก
- **lane ที่ไม่เปลี่ยนหายไปเอง** ลูกที่แค่อ่านใน lane ไม่ทิ้งอะไรไว้
- **ลูกแบบเบื้องหลังที่แก้ไฟล์ต้องอยู่ใน lane** `background: true` กับ `worker` ที่ไม่มี `isolation: "worktree"` ถูกปฏิเสธ
- **setup ของ repo ต้องอนุมัติก่อน** คำสั่ง setup ที่ repo ขอให้รันใน lane ใหม่รันเฉพาะเมื่อผู้ใช้อนุมัติด้วย `gcode lane new --approve-setup` ครั้งหนึ่ง
  ไม่อย่างนั้น engine เขียนลง output channel ว่าไม่ได้รัน
