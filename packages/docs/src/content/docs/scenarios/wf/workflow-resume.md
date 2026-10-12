---
title: resume workflow จาก journal
description: workflow รอบก่อนหยุดกลางทาง ผู้ใช้สั่ง /workflow --resume รอบใหม่อ่าน journal ของรอบเก่า ขั้นที่เสร็จแล้วได้ผลเดิมโดยไม่เรียก model แล้วรันต่อจากขั้นแรกที่ยังไม่เสร็จ
scenario:
  surface: vscode
  given:
    - "workflow `fix-bug` รอบก่อน (session `5f1c...`) หยุดที่ขั้น `fix` เพราะถึงเพดานของขั้น ขั้น `reproduce` เสร็จแล้วและอยู่ใน journal"
    - การปลุกอัตโนมัติเปิดอยู่ ไม่มี turn ทำงานในแชตนี้
  trigger: >-
    ผู้ใช้พิมพ์ `/workflow fix-bug --resume 5f1c...` แล้วกด Enter
  covers: [wf.workflow-resume]
  related: [wf.workflow-run, sub.cut-off-by-engine-stop]
  steps:
    - use: ext-slash-sent
      beat:
        title: คุณพิมพ์ `/workflow fix-bug --resume`
        text: รอบก่อนหยุดที่ขั้น `fix` เพราะถึงเพดาน คุณสั่งให้ทำต่อจากรอบนั้น
        from: you
        to: panel
        sees:
          kind: message
          from: you
          text: /workflow fix-bug --resume 5f1c...

    - id: issued
      beat:
        title: Geno สร้าง call workflow ในนามคุณ
        text: Geno ไม่ถาม model มันสร้าง call ที่บอกให้ resume รอบเก่าเอง
        from: engine
        to: engine
      lane: loop
      at: drive
      do: >-
        `workflowCommandCall` อ่าน `--resume 5f1c...` แล้วสร้าง call `workflow` ในนามผู้ใช้ที่มี `resume` ไม่ได้ใส่ input
        director ส่ง call นี้แทน model
      ref: packages/engine/src/workflows.ts#workflowCommandCall
      emits: [workflow]
      phase: running-tools

    - id: earlier
      beat:
        title: Geno เปิด log ของรอบเก่า
        text: Geno ตรวจว่า id เป็นรอบของ `fix-bug` จริง แล้วอ่าน journal และ input เดิมของรอบนั้น
        from: engine
        to: engine
        ask: id ถูกไหม
      lane: loop
      at: tools
      do: >-
        `prepare` เปิด log ของรอบเก่า ตรวจว่าเป็นรอบของ workflow `fix-bug` จริง (ไม่อย่างนั้นได้ error) อ่าน journal ของมัน
        (`<sessions>/<run>/workflow-journal.jsonl`) และใช้ input ของรอบเก่าเพราะผู้ใช้ไม่ได้ใส่ใหม่
      ref: packages/engine/src/workflows.ts#workflowTools
      fork:
        ask: id ที่ให้มาเป็นอะไร
        options:
          - id: same
            label: รอบของ fix-bug
            then: replay-plan

          - id: other
            label: ไม่ใช่รอบของ workflow นี้
            steps:
              - lane: loop
                beat:
                  title: ไม่ใช่รอบของ fix-bug
                  text: Geno ตอบ error ไม่มีการ์ด ไม่มี session ใหม่ ขั้นของ workflow ขึ้นว่าล้มเหลว และ turn จบโดยไม่เรียก model
                  from: engine
                  to: panel
                  sees:
                    kind: step
                    label: workflow fix-bug --resume ...
                    status: failed
                  end: ไม่มีอะไรรัน
                at: tools
                do: >-
                  `prepare` โยน `ToolError` เช่น "run ... is a run of workflow lint-all, not of fix-bug"
                  หรือ "no run ... to resume" ไม่มีการ์ด ไม่มี session ใหม่
                ref: packages/engine/src/workflows.ts#workflowTools
                emits: [ToolError]
              - lane: panel
                at: rail
                do: ขั้นของ `workflow` ขึ้นเป็นล้มเหลวพร้อมข้อความ error แล้ว turn จบโดยไม่เรียก model
                sees: ขั้น "workflow fix-bug --resume ..." ขึ้นเครื่องหมายล้มเหลว
                ref: packages/extension/src/chat/webview.ts#render
                end: { turn: done, reason: end_turn }

    - id: replay-plan
      beat:
        title: Geno คำนวณขั้นที่ได้ผลเดิม
        text: ขั้นที่อยู่ใน journal ได้ผลเดิมโดยไม่เรียก model Geno หาขั้นแรกที่ต้องรันจริง แล้วขอ permission
        from: engine
        to: panel
      lane: loop
      at: tools
      do: >-
        `startReplay` เตรียม journal และ `replayedBeforeLive` คำนวณว่าขั้นไหนจะได้ผลเดิมก่อนขั้นแรกที่ต้องรันจริง
        ผลนี้ใส่ใน preview เป็น `resume` คำถามของคำขอ ACP กลายเป็น "Resume workflow fix-bug from run 5f1c...: 2 steps, 1 replayed with no model call, ..."
      ref: packages/core/src/workflow.ts#replayedBeforeLive

    - id: card
      beat:
        title: คุณเห็นการ์ด “Run this workflow?”
        text: การ์ดหน้าตาเหมือนการรันใหม่ ไม่บอกว่าเป็นการ resume และราคาคิดจากทุกขั้น รวมขั้นที่จะได้ผลเดิมฟรี
        from: panel
        to: you
        sees: { kind: permission, face: workflow, command: "fix-bug: reproduce · explore · read-only, fix · worker · can edit, Gate", reason: "Each step runs as a subagent in the background, listed in Tasks." }
      lane: panel
      at: card
      do: >-
        การ์ดใช้หน้าตาเดียวกับการรันใหม่ หัวข้อการ์ดคงที่และเนื้อการ์ดไม่อ่านข้อมูล `resume`
        ราคาบนการ์ดคิดจากทุกขั้น รวมขั้นที่จะได้ผลเดิมฟรี
      sees: >-
        การ์ด "Run this workflow?" รายการขั้นและราคาเหมือนรอบใหม่ ไม่มีบรรทัดที่บอกว่าเป็นการ resume หรือขั้นไหนจะไม่เสียเงิน ปุ่ม [Run] [Don't run]
      ref: packages/extension/src/chat/workflow-view.ts#workflowCardBody
      phase: waiting-user

    - id: run
      beat:
        title: คุณกด Run
        text: Geno เปิด session ใหม่ของ workflow ที่จดว่ามัน resume รอบเก่า
        from: you
        to: panel
      lane: user
      do: ผู้ใช้กด Run

    - id: start
      lane: server
      at: sessions
      runs: 1
      do: >-
        `runWorkflow` เปิด session ใหม่ของ workflow ที่จด `resumes` ไว้ใน `session-start` ข้อความแรกบอกว่ารอบนี้ resume รอบเก่า
      ref: packages/engine/src/serve.ts#runWorkflow
      emits: [session-start]
      phase: idle

    - id: replay
      beat:
        title: ขั้นที่เสร็จแล้วได้ผลเดิมฟรี
        text: "`reproduce` ได้ผลเดิมจาก journal Geno ข้ามไปจนเจอขั้นที่ต้องรันจริง แผง Tasks เริ่มที่ขั้นนั้น จากตรงนี้ workflow รันเหมือนรอบปกติ"
        from: engine
        to: model
        sees:
          kind: task
          title: Workflow fix-bug
          status: running
          detail: "Step 2 of 3: fix · $0.00 of $0.50"
        end: รันต่อแบบ workflow ปกติ
      lane: child@workflow
      at: loop
      do: >-
        director เรียก `nextLiveRound`: รอบแรกมี `reproduce` ซึ่งอยู่ใน journal `replayRound` ให้ผลเดิมแบบ `replayed` โดยไม่เรียก model
        แล้วข้ามไปรอบถัดไปจนเจอ call ที่ต้องรันจริง (`fix`) ตั้งแต่ call ที่รันจริงแรก ไม่มีอะไรหลังจากนั้นได้ผลจาก journal อีก
        gate ที่รัน check รันใหม่เสมอ และขั้นที่อยู่ใน lane ไม่ replay
      ref: packages/core/src/workflow.ts#nextLiveRound
      emits: [replayed, agent]

    - id: progress
      lane: panel
      at: tasks
      alongside: true
      do: งานของ workflow ในแผง Tasks เริ่มที่ขั้นที่รันจริง
      sees: >-
        งาน "Workflow fix-bug" บรรทัด "Step 2 of 3: fix · $0.00 of $0.50"
      ref: packages/core/src/workflow-progress.ts#progressLine
      goto: wf.workflow-run
---

journal คือรายการผลของขั้นที่จบแล้วของแต่ละรอบ เก็บข้าง log ของ session ของ workflow
การ resume ไม่ได้ต่อ session เดิม มันเริ่ม session ใหม่ที่ใช้ผลจาก journal แทนการเรียก model ซ้ำ จนถึงขั้นแรกที่ต้องรันจริง
หลังจากนั้นทุกอย่างเหมือน [รัน workflow พร้อมความคืบหน้า](/scenarios/wf/workflow-run/)

สิ่งที่ควรสังเกต

- **การ์ดไม่บอกว่าเป็นการ resume** (อ่านจากโค้ด) engine ใส่ข้อมูล resume ไว้ในคำถามของคำขอ ACP แต่การ์ด workflow ของ VS Code แสดงหัวข้อคงที่
  และวาดเนื้อการ์ดจาก preview โดยไม่อ่าน `resume` ราคาบนการ์ดจึงรวมขั้นที่จะได้ผลเดิมฟรีด้วย
- **ผลเดิมเชื่อได้แค่ก่อน call แรกที่รันจริง** ขั้นหลังจากนั้นอาจพึ่งสิ่งที่ขั้นที่รันใหม่เปลี่ยน จึงรันใหม่ทั้งหมด
- **รายงานบอกว่ากี่ขั้นได้ผลเดิม** รายงานของรอบที่ resume มีบรรทัด "Resumed from run ...: 1 replayed with no model call."
