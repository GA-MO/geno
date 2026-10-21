---
title: "engine หยุดขณะ subagent ทำงาน แล้ว Resume"
description: engine ตายระหว่างที่ worker กำลังทำงาน engine ตัวใหม่ปิดงานที่ค้างใน log บอก session ว่าลูกถูกตัด แล้วผู้ใช้กด Resume ในแผง Tasks ให้ลูกทำต่อจาก transcript ของตัวเอง
scenario:
  surface: vscode
  given:
    - turn ของแม่รอรายงานจาก `worker` แบบรอ (ไม่ใช่เบื้องหลัง) worker แก้ไปสองไฟล์และกำลังรัน `pnpm test`
    - หน้าต่าง VS Code ยังเปิดอยู่
  trigger: >-
    process ของ engine จบลงกลางทาง เช่นถูก kill หรือ crash
  covers: [sub.cut-off-by-engine-stop]
  related: [sub.message-finished-resume, err.engine-crash-restart, sess.reload-while-running, bg.task-attention]
  steps:
    - id: dies
      beat:
        title: engine หยุดกลางทาง
        text: >-
          worker คือ subagent (session ลูกที่แม่ส่งงานย่อยให้ทำ) แม่รอรายงานของมันอยู่ใน call `agent`
          process ของ engine ถูก kill หรือ crash ขณะ worker กำลังรัน `pnpm test` ลูกทำงานอยู่ใน process เดียวกันจึงหยุดไปด้วย
          log ของแม่จดว่า worker เริ่มแล้ว แต่ไม่มีบันทึกว่าจบ
        from: engine
        to: engine
      lane: server
      at: turns
      do: >-
        engine หยุดทันที ไม่มีใครเขียนอะไรต่อ log ของแม่มี `child-start` ที่จด pid และโฟลเดอร์ของ engine (`by`) แต่ไม่มี `child-end`
        call ที่ลูกค้างไว้ไม่มีผล และ call `agent` ของแม่ก็ไม่มีผล
      ref: packages/core/src/interrupted.ts#openRunsOf
      phase: running-tools

    - id: closed
      beat:
        title: แชตขึ้นว่า turn ล้มเหลว
        text: การเชื่อมต่อระหว่าง VS Code กับ engine ขาด คำขอของ turn ล้มเหลว แชตขึ้นแถบ error และแถวของ worker ถูกปิดไปพร้อม turn
        from: panel
        to: you
        sees:
          kind: composer
          state: idle
          header: failed after 2m 10s
      lane: editor
      at: engine-link
      do: >-
        socket ปิด extension เขียน "engine: connection closed" ลง output channel แล้วตั้งเวลาต่อใหม่
        คำขอ `session/prompt` ที่ค้างอยู่ล้มเหลว `prompt()` จึงส่ง action `error` และ `turn-end` สถานะ `failed`
      ref: "packages/extension/src/chat/chat.ts#\"this.dispatch({ type: 'turn-end', at: Date.now(), status: 'failed', usage: undefined });\""
      emits: [error, turn-end]

    - id: failed
      lane: panel
      at: rail
      alongside: true
      do: >-
        turn ขึ้นแถบ error กับหัวข้อ "failed after ..." แถวของ worker ถูกปิดเป็น Cancelled ไปพร้อม turn
      sees: แถบ error สีแดงพร้อมข้อความ error ของคำขอที่ล้มเหลว หัวข้อ "failed after 2m 10s" และแถว worker ขึ้นไอคอน cancelled (คำว่า Cancelled อยู่ใน tooltip)
      ref: packages/extension/src/chat/render.ts#errorBlock
      phase: idle

    - id: relaunch
      beat:
        title: VS Code เปิด engine ตัวใหม่
        text: หลังรอครู่หนึ่ง ส่วนขยายต่อใหม่ ไม่มี engine ฟังอยู่ จึงเปิดตัวใหม่
        from: panel
        to: engine
      lane: editor
      at: engine-link
      do: >-
        หลังรอครู่หนึ่ง `restart` ต่อ socket ใหม่ ไม่มี engine ฟังอยู่ `launch` จึงเปิด `gcode serve` ตัวใหม่แล้วส่ง `initialize`
      ref: packages/extension/src/chat/engine.ts#Engine.launch
      emits: [initialize]

    - id: recover
      beat:
        title: engine ตัวใหม่หางานที่ค้าง
        text: >-
          การเชื่อมต่อแรกของ engine ตัวนี้อ่าน log หา subagent ที่ค้าง คือมีบันทึกว่าเริ่มแต่ไม่มีบันทึกว่าจบ
          และ engine ที่เปิดมันไม่อยู่แล้ว
        from: engine
        to: engine
      lane: server
      at: sessions
      do: >-
        การเชื่อมต่อแรกของ process นี้เรียก `takeUpWaits` ซึ่งเริ่มจาก `recoverInterrupted`: ถือ lock ของโฟลเดอร์ sessions
        หา run ของลูกที่เปิดค้างโดย engine ที่ pid ไม่อยู่แล้วและทำงานในโฟลเดอร์เดียวกัน
      ref: packages/engine/src/interrupted.ts#recoverInterrupted

    - id: child-answered
      beat:
        title: Geno ปิด call ที่ค้างทั้งของลูกและแม่
        text: >-
          Geno เขียนผลให้ทุก call ที่ค้าง `pnpm test` ของ worker ได้ผลว่า Geno หยุดระหว่างที่มันรัน ผลอาจหายไป
          call `agent` ของแม่ได้ผลแบบเดียวกัน พร้อมโน้ตว่า worker ถูกตัดและทำต่อได้อย่างไร
          โน้ตนี้รอไปกับ turn ถัดไป มันไม่เริ่ม turn ใหม่เอง
        from: engine
        to: engine
      lane: child@worker
      at: loop
      do: >-
        ใน log ของลูก call ที่ค้าง (`pnpm test`) ได้ผลว่า "[Geno stopped] Geno stopped while this call ran, so it may have partly run and its result is lost."
      ref: packages/core/src/interrupted.ts#INTERRUPTED_CALL
      emits: [tool-result]

    - id: parent-told
      lane: loop
      at: drive
      do: >-
        ใน log ของแม่ call `agent` ได้ผลแบบเดียวกัน ตามด้วยโน้ต `wake` ชนิด `interrupted` ครั้งเดียวต่อ run:
        ลูกตัวไหนถูกตัด รายงานเท่าที่มี และวิธีทำต่อด้วย `message_agent` โน้ตนี้ไปกับ turn ถัดไป ไม่ปลุก session
        แล้วจึงบันทึก `child-end` แบบ `interrupted`
      ref: packages/core/src/interrupted.ts#interruptedText
      emits: [wake, interrupted, child-end]

    - id: task-row
      beat:
        title: Tasks บอกว่า worker ถูกตัด
        text: >-
          ในแผง Tasks (แผงที่รวมงานของแต่ละ session) งานของ session นี้ขึ้นป้าย Cut off พร้อมสิ่งที่ worker ทำไปแล้ว
          ช่องข้อความ และปุ่ม Resume ปุ่มขึ้นเฉพาะตอนที่ session ไม่มี turn ทำงาน
        from: panel
        to: you
        sees:
          kind: task
          title: worker
          status: needs-input
          detail: Cut off
          actions:
            - Resume
      lane: server
      at: tasks
      do: >-
        `tasks.interrupted` ใส่รายชื่อลูกที่ถูกตัดไว้ในงานของ session นี้ และ engine เขียนลง output channel ว่า
        session นี้มี subagent 1 ตัวถูกตัดเมื่อ engine ตัวก่อนหยุด
      ref: packages/engine/src/tasks.ts#Tasks.interrupted
      emits: [_gcode/taskUpdate]

    - id: shown
      lane: panel
      at: tasks
      do: >-
        แผง Tasks แสดงงานของ session พร้อมรายการลูกที่ถูกตัด แต่ละตัวมีข้อความล่าสุดของมัน ช่องข้อความ และปุ่ม Resume
        ปุ่มขึ้นเฉพาะตอนที่ session ไม่มี turn ทำงาน
      sees: >-
        ป้าย "Cut off" ใต้งาน แถว "worker: <สรุปสิ่งที่ทำไปแล้ว>" ช่องข้อความที่มีค่า "Continue where you stopped." และปุ่ม [Resume]
      ref: "packages/extension/src/chat/lanes-panel.ts#\"function interruptedItem(\""

    - id: resume
      beat:
        title: คุณกด Resume
        text: คุณไม่แก้ข้อความ "Continue where you stopped." แชตเปิด session นั้นแล้วส่งข้อความถึง worker
        from: you
        to: panel
      lane: user
      do: ผู้ใช้อ่านแล้วกด Resume โดยไม่แก้ข้อความ

    - id: ask
      lane: editor
      at: chat
      do: >-
        `task-resume` เปิดแชตของ session นั้น แล้ว `resumeAgent` ส่ง `session/prompt` ที่ข้อความคือ "Continue where you stopped."
        และ `_meta` `gcode/resumeAgent` คือ session id ของ worker
      ref: "packages/extension/src/chat/chat.ts#\"async resumeAgent(child: string, text: string)\""
      emits: [session/prompt, gcode/resumeAgent]

    - id: issued
      beat:
        title: Geno ส่งข้อความถึง worker ในนามคุณ
        text: >-
          Geno สร้าง call `message_agent` (tool ที่ส่งข้อความถึงลูกตัวเดิม) เองในนามคุณ ไม่ถาม model ของแม่ก่อน
        from: engine
        to: engine
      lane: loop
      at: agent
      do: >-
        `runTurn` ส่ง id นี้ให้ `runAgent` ซึ่งใช้ `resumeCall` สร้าง call `message_agent` ในนามผู้ใช้ (`issuedBy: user`)
        turn นี้จึงไม่เรียก model ของแม่ก่อนรัน call
      ref: packages/engine/src/subagents.ts#resumeCall
      emits: [message_agent]
      phase: running-tools

    - id: reopen
      beat:
        title: worker ทำต่อจาก transcript ของตัวเอง
        text: Geno ต่อบันทึกของ worker ด้วยข้อความของคุณและหมายเหตุว่ามันถูกตัด worker ได้งบชุดใหม่ แถวของมันกลับมาหมุน และป้าย Cut off หายไป
        from: engine
        to: model
        sees:
          kind: task
          title: worker
          status: running
          detail: 0:01
      lane: child@worker
      at: loop
      runs: 1
      do: >-
        `resumable` เห็นว่า run ล่าสุดของลูกจบแบบ `interrupted` จึงต่อ log ของลูกด้วยข้อความจากแม่ที่มีหมายเหตุว่า
        Geno หยุดระหว่างที่ลูกทำงาน call ที่ค้างไม่มีผล ให้ทำต่อจากที่ transcript จบ ลูกได้เพดานชุดใหม่
      ref: packages/core/src/steer.ts#resumeEvent
      emits: [user]

    - id: row
      lane: panel
      at: rail
      do: >-
        แถวของ worker ขึ้นใหม่ใต้ขั้นของ `message_agent` และป้าย Cut off ของแผง Tasks หายไปเพราะลูกเริ่มรันอีกครั้ง
      sees: แถว "worker · <model> · 0:01" พร้อมไดโนเสาร์ที่ขยับ
      ref: packages/extension/src/chat/subagent-view.ts#childRow

    - id: works
      beat:
        title: worker รันเทสต์ใหม่แล้วรายงาน
        text: worker เห็นว่า `pnpm test` ไม่มีผล จึงรันใหม่ แล้วส่งรายงาน รายงานกลับมาเป็นผลของ call ที่ส่งข้อความ
        from: model
        to: engine
      lane: child@worker
      at: model
      do: >-
        ลูกอ่าน transcript ของตัวเอง เห็นว่า `pnpm test` ไม่มีผล จึงรันใหม่ แล้วเรียก `report`
      ref: packages/engine/src/subagents.ts#reportExecutor
      emits: [report]

    - id: result
      lane: loop
      at: tools
      do: >-
        worker เดิมเป็นลูกแบบรอ call `message_agent` จึงรอและได้รายงานใหม่ในรั้วเป็นผล แล้วบันทึก `child-end`
      ref: packages/core/src/subagent.ts#childReport
      emits: [tool-result, child-end]

    - id: ends
      beat:
        title: Turn จบโดยไม่เรียก model ของแม่
        text: >-
          รายงานและโน้ตเรื่องการถูกตัดรออยู่ใน log ให้ model อ่านใน turn ถัดไปของคุณ คุณอ่านรายงานได้จากผลของขั้น message_agent
          turn นี้จบที่ขั้น message_agent โดยไม่มีข้อความของ Geno ตามหลัง แชตจึงขึ้นประกาศ Geno stopped without a reply
          พร้อมปุ่ม Continue กับ Retry เหมือนหลัง `@agent` ทุกครั้ง กด Continue แล้ว model ของแม่จะอ่านรายงานและตอบคุณ
        from: engine
        to: panel
        sees:
          - { kind: notice, text: Geno stopped without a reply, detail: Its last reply had no text., actions: [ Continue, Retry ], tone: warning }
          - kind: composer
            state: idle
            header: worked for 1m 4s
        end: Turn จบ รายงานรอ turn ถัดไป
      lane: loop
      at: step
      do: >-
        `loopStep` ตัดสิน `call-model` แต่ director ที่ออก call นี้ไม่มีอะไรจะออกอีก run จึงจบ `end_turn` โดยไม่เรียก model ของแม่
        รายงานกับโน้ต `interrupted` รออยู่ใน log ให้ model อ่านใน turn ถัดไปของผู้ใช้
      ref: "packages/engine/src/drive.ts#\"if (issued === undefined) return end('end_turn');\""
      emits: [end_turn]
      phase: ending

    - id: footer
      lane: panel
      at: rail
      do: >-
        turn จบแบบ done ผู้ใช้อ่านรายงานของ worker ได้จากผลของขั้น `message_agent` ไม่มีข้อความหลังขั้นสุดท้าย
        `missingReply` จึงคืน "Its last reply had no text." และแชตแสดงประกาศพร้อม Continue กับ Retry
      sees: หัวข้อ "worked for 1m 4s" ขั้น "message_agent ..." แถว worker ขึ้นเครื่องหมายถูก และประกาศ "Geno stopped without a reply · Its last reply had no text." [Continue] [Retry]
      ref: packages/extension/src/chat/rail.ts#headerOf
      end: { turn: done, reason: end_turn }
---

engine เก็บสถานะของลูกที่กำลังรันไว้ในหน่วยความจำ เมื่อ process ตาย สิ่งที่เหลือคือ log
engine ตัวถัดไปอ่าน log แล้วปิดสิ่งที่ค้างให้ครบ ทุก call มีผล ทุก run มีจุดจบ แต่ไม่รันอะไรแทนผู้ใช้

สิ่งที่ควรสังเกต

- **ไม่มีอะไรทำต่อเอง** โน้ต `interrupted` ไม่ปลุก session ผู้ใช้ต้องกด Resume หรือ model ต้องเรียก `message_agent` เอง
- **บอกครั้งเดียว** engine สองตัวที่เริ่มพร้อมกันแย่งกันด้วย lock และ run ที่อยู่ในโน้ตแล้วไม่ถูกบอกซ้ำ ถ้า engine ตายกลางการปิด รอบถัดไปปิดต่อได้
- **ลูกของ workflow** ถ้าลูกที่ถูกตัดเป็นขั้นของ [workflow](/start/glossary/) (ไฟล์ที่รัน subagent ตามลำดับตายตัว) โน้ตไปที่ session ที่เริ่ม workflow และบอกว่ารายงานของ workflow จะไม่มา
- **Resume ไม่เรียก model ของแม่** turn ที่ Resume สร้างจบทันทีหลังลูกรายงาน แชตจึงขึ้นประกาศ "Geno stopped without a reply" ถ้าอยากให้แม่สรุป ผู้ใช้กด Continue หรือส่งข้อความต่อ
