---
title: "รายงานของ subagent มาถึงขณะ turn ยังทำงาน"
description: ลูกเบื้องหลังรายงานระหว่างที่ turn ของแม่ยังรันเครื่องมืออยู่ รายงานรอที่จุดปลอดภัยถัดไป แล้วเข้า log ก่อนเรียกโมเดลครั้งต่อไป ไม่ต้องปลุก
tableOfContents: false
sidebar:
  order: 8
scenario:
  surface: vscode
  given:
    - ใน turn นี้โมเดลเริ่ม `explore` แบบเบื้องหลังให้หาที่ใช้ API เก่า แล้วทำงานอื่นต่อ
    - ตอนนี้โมเดลกำลังรัน `pnpm build` ด้วย `bash` ใน turn เดิม
  trigger: >-
    explore ค้นเสร็จและเรียก `report` ขณะที่ `pnpm build` ยังรันอยู่
  covers: [bg.arrives-mid-turn]
  related: [bg.child-wakes-parent, bg.cli-holds-turn, ctl.steer-delivered, sub.message-running-child]
  steps:
    - id: report
      beat:
        title: explore ส่งรายงานแล้วจบ
        text: explore ที่ model เริ่มไว้เบื้องหลังค้นเสร็จ มันส่งรายการไฟล์ที่ใช้ API เก่า แถวของมันในแชตหยุดหมุนทันที
        from: model
        to: engine
        sees:
          kind: task
          title: explore
          status: done
          detail: 41s
      lane: child@explore
      at: model
      do: >-
        ลูกเรียก `report` พร้อมรายการไฟล์ที่ใช้ API เก่า ลูกจบแบบ `done`
      ref: packages/engine/src/subagents.ts#reportExecutor
      emits: [report]
      phase: running-tools

    - id: row-done
      lane: server
      at: updates
      do: >-
        `acpChildHost.ended` ส่ง `subagent_update` สถานะ `idle` ทันที
      ref: packages/engine/src/subagent-acp.ts#acpChildHost
      emits: [subagent_update, idle]

    - id: row
      lane: panel
      at: rail
      alongside: true
      do: แถวของลูกหยุดหมุน
      sees: แถว "✓ explore · <โมเดล> · 41s · <ค่าใช้จ่าย>"
      ref: packages/extension/src/chat/subagent-view.ts#childRow

    - id: put
      beat:
        title: Geno เก็บรายงานไว้ในกล่องของแม่
        text: turn ของแม่ยังทำงานอยู่ Geno จึงไม่ต้องปลุกใคร มันจดว่า explore จบ แล้วใส่รายงานในรั้วลงกล่องข้อความของแม่
        from: engine
        to: engine
      lane: loop
      at: tools
      do: >-
        `launch` เห็นว่ารอบของแม่ยังรันอยู่ (ยังไม่ `detach`) จึงบันทึก `child-end` ลง log ของแม่ผ่าน `logNote` ทันที
        แล้วใส่รายงานในรั้วลงกล่องข้อความของแม่ (`child-report`) ล้างหนี้รายงานและการรอใน Tasks
      ref: "packages/engine/src/subagents.ts#\"const report = async (text: string, ended: ChildEndNote | undefined) => {\""
      emits: [child-end, child-report]

    - id: holds
      beat:
        title: รายงานรอจน `pnpm build` จบ
        text: รายงานไม่แทรกกลางชุด tool ที่กำลังรัน มันรอในกล่องจนกว่า `pnpm build` จะจบ
        from: engine
        to: engine
      lane: loop
      at: tools
      do: >-
        รายงานไม่แทรกกลาง batch: ระหว่างที่ `pnpm build` รัน ขั้นของลูปคือ `run-tools` ซึ่ง `STEER_AT` ให้ถือไว้ก่อน
        รายงานรออยู่ในกล่องจนกว่าเครื่องมือชุดนี้จะจบ
      ref: packages/core/src/steer.ts#STEER_AT

    - id: build-done
      beat:
        title: "`pnpm build` จบ"
        text: build ผ่าน ผลของมันขึ้นใต้ขั้นในแชต
        from: machine
        to: engine
        sees:
          kind: step
          label: pnpm build
          status: done
      lane: tool
      at: shell
      do: >-
        `pnpm build` จบด้วย exit 0
      ref: "packages/engine/src/tools/agent.ts#\"tools.sandbox.run(command\""

    - use: tool-result-returns

    - id: decide
      beat:
        title: Geno ใส่รายงานต่อท้ายผลของ build
        text: ที่จุดปลอดภัยก่อนเรียก model Geno หยิบรายงานจากกล่อง แล้วบันทึกต่อท้ายผลของ build ส่วนต้นของบทสนทนาที่ cache ไว้จึงไม่เปลี่ยน
        from: engine
        to: engine
      lane: loop
      at: step
      do: >-
        `loopStep` ตัดสิน `call-model`
      ref: packages/core/src/loop.ts#loopStep
      emits: [call-model]
      phase: calling-model

    - id: deliver
      lane: loop
      at: drive
      do: >-
        จุดปลอดภัย `deliver()` หยิบสิ่งที่มาถึง: รายงานของลูกกลายเป็น event `user` แบบ steer `from: 'child'` ต่อท้ายผลของ `pnpm build`
        การต่อท้ายตรงนี้ไม่ทำให้ prefix ที่ cache ไว้เปลี่ยน
      ref: packages/engine/src/drive.ts#deliver
      emits: [user]

    - id: shown
      beat:
        title: แชตขึ้นบรรทัดว่า explore รายงานแล้ว
        text: แชตวาดบรรทัดสั้นตรงที่รายงานลง ไม่แสดงเนื้อรายงาน คุณอ่านมันได้จากแถวของ explore
        from: panel
        to: you
        sees: บรรทัด "explore reported back"
      lane: server
      at: updates
      do: >-
        `steerUpdate` ส่ง `user_message_chunk` ที่มี `STEER_META` (`from: child`) บน session ของแม่
      ref: packages/engine/src/session-replay.ts#steerUpdate
      emits: [user_message_chunk, STEER_META]

    - id: note
      lane: panel
      at: rail
      alongside: true
      do: >-
        `steerStep` วาดบรรทัดสั้นตรงที่รายงานลง ไม่แสดงเนื้อรายงาน (อ่านได้จากแถวของลูก)
      sees: บรรทัด "explore reported back"
      ref: packages/extension/src/chat/steer-view.ts#steerStep

    - id: request
      beat:
        title: Geno ส่งทั้งสองอย่างให้ model
        text: รายงานขึ้นต้นด้วยบรรทัดว่าไม่ใช่ข้อความของคุณ ตามด้วยรั้ว `<subagent_report>`
        from: engine
        to: model
      lane: loop
      at: model-call
      do: >-
        `buildRequest` ประกอบคำขอจาก log `replayMessages` ห่อ steer ที่มาจากลูกด้วย `arrivalText`: บรรทัดแรกบอกว่าข้อความนี้ไม่ใช่ของผู้ใช้ ตามด้วยรั้ว `<subagent_report ...>`
      ref: packages/core/src/fence.ts#arrivalText

    - id: reads
      beat:
        title: Model อ่านผล build และรายงานพร้อมกัน
        text: model อ่านทั้งสองอย่างในคำขอเดียว แล้วทำงานต่อใน turn เดิม ไม่มีการปลุก
        from: model
        to: engine
        end: Turn ทำต่อ
      lane: model
      do: >-
        โมเดลอ่านทั้งผลของ `pnpm build` และรายงานของ explore ในคำขอเดียว แล้วทำงานต่อใน turn เดิม
      ref: "packages/engine/src/gateway.ts#\"stopReason: message.stop_reason,\""
      emits: [tool_use]
      end: { turn: continues, reason: call-model }
---

รายงานของลูกเบื้องหลังไปที่ session ไม่ใช่ที่รอบใดรอบหนึ่ง จึงมีสองทาง:
ถ้า turn ของแม่ยังรัน รายงานเข้าที่จุดปลอดภัยถัดไปของ turn นั้น (หน้านี้)
ถ้า turn จบไปแล้ว รายงานถูกบันทึกลง log ทันทีและอาจปลุก session ([ลูกเบื้องหลังรายงานแล้วปลุกเซสชัน](/scenarios/bg/child-wakes-parent/))

สิ่งที่ควรสังเกต

- **ไม่มี turn ที่ถูกปลุก** รายงานที่เข้า turn ที่รันอยู่ไม่ปลุกอะไร และไม่นับในเพดานการปลุก 12 ครั้งต่อชั่วโมง
- **ที่เดียวที่รายงานเข้า** คือ `deliver()` ก่อนเรียกโมเดล ไม่เคยเข้ากลาง stream หรือระหว่าง `tool_use` กับผลของมัน
- **`child-end` เข้า log ก่อนรายงาน** event นี้ไม่ใช่ส่วนของบทสนทนา มันมีไว้ให้ `list_agents` และแผงแชตรู้ว่าลูกจบแล้ว
