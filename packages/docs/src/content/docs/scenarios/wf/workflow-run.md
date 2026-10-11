---
title: รัน workflow พร้อมความคืบหน้า
description: ผู้ใช้พิมพ์ /workflow Geno แสดงการ์ดราคาก่อน แล้วรัน workflow เป็น session เบื้องหลัง ทีละรอบของขั้น แต่ละขั้นเป็นเอเจนต์ลูก เมื่อจบ รายงานปลุกแชตที่เริ่ม
tableOfContents: false
sidebar:
  order: 1
scenario:
  surface: vscode
  given:
    - "workspace มี `.g-code/workflows/fix-bug.json` สามขั้น: `reproduce` (explore), `fix` (worker) และ gate ที่รัน check ของโปรเจกต์ งบรวม $0.50"
    - การปลุกอัตโนมัติเปิดอยู่ ไม่มี turn ทำงานในแชตนี้
  trigger: >-
    ผู้ใช้พิมพ์ `/workflow fix-bug "date parsing fails on leap years"` แล้วกด Enter
  covers: [wf.workflow-run]
  related: [wf.workflow-resume, sub.blocking-report, bg.child-wakes-parent, bg.task-stop-or-list]
  steps:
    - use: ext-slash-sent

    - id: logged
      lane: loop
      at: drive
      do: >-
        `/workflow` เป็นคำสั่งในตัวที่สร้าง turn ข้อความ "Run the workflow fix-bug ..." ถูกบันทึกเป็น event `user` พร้อมชื่อคำสั่ง
        `runAgent` เห็นคำสั่งนี้ จึงให้ `workflowCommandCall` สร้าง call `workflow` ในนามผู้ใช้ โมเดลไม่ถูกเรียกก่อน
      ref: packages/engine/src/workflows.ts#workflowCommandCall
      emits: [user, workflow]

    - id: issued
      lane: loop
      at: step
      do: >-
        ที่ขั้น `call-model` director ส่ง call ที่ผู้ใช้ออกแทนโมเดล `drive` บันทึกเป็น `assistant` ที่มี `issuedBy: user`
        แล้ว `loopStep` ตัดสิน `run-tools`
      ref: "packages/engine/src/drive.ts#\"await record({ kind: 'assistant', seq: nextSeq(events), at: new Date().toISOString(), ...issued, issuedBy: 'user' });\""
      emits: [assistant, run-tools]
      phase: running-tools

    - id: prepare
      lane: loop
      at: tools
      do: >-
        `prepare` อ่าน workflow จากไฟล์ครั้งเดียว ตรวจว่ารันที่นี่ได้ (role มีอยู่จริง ไม่มีขั้นที่แก้ไฟล์ในโหมด Plan)
        แล้ว `workflowPreview` คำนวณราคาแต่ละขั้นและราคารวมที่แย่ที่สุด สิ่งที่การ์ดแสดงคือสิ่งที่จะรัน แม้ไฟล์จะเปลี่ยนระหว่างรอ
      ref: packages/engine/src/workflows.ts#workflowTools

    - id: no-rule
      lane: policy
      at: settle
      do: >-
        การ์ดของ workflow ไม่ผ่าน `settle` ไม่มีโหมด กฎ หรือ classifier ตอบแทนได้ ทุกโหมดรวมถึง Auto จึงถามผู้ใช้เสมอ
      ref: packages/engine/src/tools/workflow.ts#workflowExecutor

    - id: ask
      lane: server
      at: approvals
      do: >-
        `approveWorkflow` ส่งคำขอ ACP `session/request_permission` ที่มี preview ใน `_meta` ใต้ `gcode/workflow`
        ตัวเลือกคือ Run และ Don't run
      ref: packages/engine/src/serve.ts#editorTurn.approveWorkflow
      emits: [requestPermission, gcode/workflow]
      phase: waiting-user

    - id: card
      lane: panel
      at: card
      do: >-
        การ์ด workflow แสดงทีละขั้น: ชื่อ role โมเดล อ่านอย่างเดียวหรือแก้ได้ ราคาประมาณและเพดาน แล้วราคารวม
      sees: >-
        การ์ด "Run this workflow?" รายการขั้น "reproduce · explore · ... · read-only" "fix · worker · ... · can edit" "Gate"
        บรรทัด "About $0.09, at most $0.50. The run stops cleanly at its total cap of $0.50."
        "Each step runs as a subagent in the background, listed in Tasks." และปุ่ม [Run] [Don't run]
      ref: packages/extension/src/chat/workflow-view.ts#workflowCardBody

    - id: answer
      lane: user
      do: ผู้ใช้อ่านราคาแล้วตอบ
      fork:
        ask: ผู้ใช้กดอะไร
        options:
          - id: run
            label: Run
            then: start

          - id: decline
            label: Don't run
            steps:
              - lane: loop
                at: tools
                do: >-
                  `workflowExecutor` โยน `ToolRejected` "The user did not run the workflow. Nothing ran." พร้อมคำสั่งให้หยุดรอผู้ใช้
                ref: packages/engine/src/tools/workflow.ts#workflowExecutor
                emits: [ToolRejected]
              - lane: panel
                at: card
                do: การ์ดย่อเหลือบรรทัดเดียว
                sees: "Not run"
                ref: packages/extension/src/chat/render.ts#permissionCard
              - lane: loop
                at: step
                do: >-
                  call ถูกปฏิเสธโดยผู้ใช้ `loopStep` ตัดสิน `done(end_turn)` ไม่มี session ใหม่ ไม่มีเงินถูกใช้
                ref: packages/core/src/loop.ts#unrunnable
                emits: [end_turn]
                phase: ending
                end: { turn: done, reason: end_turn }

    - id: start
      lane: server
      at: sessions
      do: >-
        `runWorkflow` เปิด session เบื้องหลังชื่อ "Workflow fix-bug" ในโหมดเดียวกับแชตนี้ งบของ session คืองบรวมของ workflow
        director ของ session คือ `workflowDriver` แชตนี้ติดหนี้รายงานหนึ่งฉบับ และตัวปลุกจดว่ารอ workflow นี้
      ref: packages/engine/src/serve.ts#runWorkflow
      emits: [session-start]

    - id: started
      lane: loop
      at: tools
      do: >-
        ผลของ call คือ "Started workflow fix-bug in the background as session ... The user follows it in Tasks."
        แล้ว director ของแชตนี้ไม่มีอะไรออกอีก turn ของแชตจึงจบ `end_turn` โดยไม่เรียกโมเดล
      ref: "packages/engine/src/drive.ts#\"if (issued === undefined) return end('end_turn');\""
      emits: [tool-result, end_turn]
      phase: idle

    - id: round
      lane: child@workflow
      at: loop
      do: >-
        ใน session ของ workflow ทุกขั้น `call-model` ถาม director: `absorbOutcomes` รับผลรอบก่อน `nextRound` เลือกรอบถัดไป
        (ไม่เริ่มรอบที่งบที่เหลือไม่พอให้ทุกขั้นในรอบใช้จนเต็มเพดาน) เขียน journal แล้วคืน turn ที่มี call `agent` ของขั้นในรอบนั้น
      ref: packages/core/src/workflow.ts#nextRound
      emits: [agent]

    - id: progress
      lane: panel
      at: tasks
      alongside: true
      do: >-
        `tasks.workflow` อัปเดตงานของ workflow ในแผง Tasks ทุกครั้งที่ director เปลี่ยนสถานะ
      sees: >-
        งาน "Workflow fix-bug" บรรทัด "Step 1 of 3: reproduce · $0.00 of $0.50"
      ref: packages/core/src/workflow-progress.ts#progressLine

    - id: steps
      lane: child@worker
      at: model
      do: >-
        แต่ละขั้นรันเป็นเอเจนต์ลูกของ session workflow ด้วยเพดาน โมเดล และ lane ที่ workflow กำหนด
        `reproduce` หาเทสต์ที่ล้ม แล้วรอบถัดไป `fix` ได้ผลของ `reproduce` ผ่าน `{{previous}}` แก้โค้ด และรายงาน
      ref: packages/engine/src/subagents.ts#runChild
      emits: [report]

    - id: gate
      lane: child@workflow
      at: loop
      do: >-
        รอบถัดไปเป็น gate ที่รัน check ของโปรเจกต์ check ผ่าน ไม่มีขั้นเหลือ director คืน `closingTurn` ซึ่งเป็นรายงานของ workflow
        แล้วครั้งถัดไปไม่คืนอะไร session ของ workflow จบ ถ้าขั้นใดล้ม gate ไม่ผ่าน หรือถึงงบรวม run หยุดหลังรอบนั้น
      ref: packages/core/src/workflow.ts#closingTurn
      emits: [end_turn]

    - id: report
      lane: server
      at: wakes
      do: >-
        `driver.finish` ปิด run แล้ว `childReport` ห่อรายงานด้วยรั้ว `<subagent_report agent="workflow fix-bug" ...>`
        รายงานเข้ากล่องข้อความของแชตที่เริ่ม เหมือนรายงานของลูกเบื้องหลัง
      ref: packages/core/src/workflow.ts#workflowReport
      emits: [child-report]

    - use: bg-wake-starts
    - use: model-call

    - id: relays
      lane: model
      do: >-
        โมเดลของแชตอ่านรายงาน "Workflow fix-bug finished: 3 steps ran, $0.07 of its $0.50 cap." และรายการขั้น
        แล้วเล่าให้ผู้ใช้ว่าแก้อะไร จบด้วย `stop_reason: end_turn`
      ref: packages/core/src/wake.ts#wakeNotice
      emits: [end_turn]
      phase: calling-model

    - use: bg-woken-ends
---

workflow คือแผนงานหลายขั้นที่ไม่มีโมเดลเป็นคนคุม: director อ่านไฟล์ JSON แล้วออก call `agent` ของแต่ละขั้นเอง
โมเดลของแต่ละขั้นทำงานของขั้นนั้น แต่ลำดับ เพดาน และ gate มาจากไฟล์

สิ่งที่ควรสังเกต

- **ไม่มีโมเดลถูกเรียกก่อนการ์ด** `/workflow` เหมือน `@agent`: ข้อความของผู้ใช้กลายเป็น call ในนามผู้ใช้ทันที
  โมเดลก็เรียกเครื่องมือ `workflow` เองได้ ถ้า editor บอกว่ารองรับ และ turn นั้นไม่ใช่รอบตามตารางเวลา
- **งบถูกจองก่อนรอบ** `nextRound` ไม่เริ่มรอบที่งบที่เหลือไม่พอให้ทุกขั้นใช้จนเต็มเพดาน run จึงหยุดได้ก่อนใช้เงินครบงบ
- **ขั้นของ workflow ส่งข้อความถึงได้** แชตที่เริ่ม workflow ใช้ `message_agent` กับขั้นของมันได้
- **ปิดการปลุกอยู่** รายงานยังเข้ากล่องข้อความของแชต และไปกับ prompt ถัดไปของผู้ใช้แทนการปลุก
