---
title: "subagent เบื้องหลังรายงานแล้วปลุก session"
description: model เริ่ม explore แบบเบื้องหลังแล้วจบ turn ลูกทำงานต่อ เมื่อรายงานมาถึง engine บันทึกลง log แล้วเปิด turn ใหม่เองให้ model เล่าผล
tableOfContents: false
sidebar:
  order: 1
scenario:
  surface: vscode
  given:
    - ค่า `agentTool` มีโหมดปัจจุบัน และการปลุกอัตโนมัติ (`gcode.wake.auto`) เปิดอยู่ตามค่าเริ่มต้น
    - หน้าต่าง VS Code ที่แสดง session นี้ยังเปิดอยู่
  trigger: >-
    ผู้ใช้ขอให้หาว่า `parseVersion` ถูกเรียกที่ไหน model เริ่ม `explore` แบบเบื้องหลัง
  covers: [bg.child-wakes-parent]
  related: [bg.command-ends-wakes, bg.task-attention, bg.wake-held-or-paused, bg.arrives-mid-turn, sub.blocking-report]
  steps:
    - id: wants
      beat:
        title: Model เริ่ม explore แบบเบื้องหลัง
        text: >-
          คำอธิบายของ `background` ใน schema ของ tool `agent` บอกว่า call จะกลับทันทีพร้อม session id
          และรายงานจะมาเป็นข้อความทีหลัง (แท็บแรก) model ส่ง `tool_use` ที่มี `agent: "explore"`, `task` และ
          `background: true` (แท็บสอง) มันจะไม่รอรายงาน
        from: model
        to: engine
        sees:
          - kind: payload
            source: packages/docs/src/data/recorded/background-wake.jsonl#line=2
            select: tools[9]
            highlight: [input_schema.properties.background]
          - kind: payload
            source: packages/docs/src/data/recorded/background-wake.jsonl#line=6
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
        `loopStep` ตัดสินว่า `run-tools`
      ref: packages/core/src/loop.ts#loopStep
      emits: [run-tools]
      phase: running-tools

    - use: sub-child-starts
      beat:
        title: Geno เปิด session ให้ explore
        text: >-
          แชตขึ้นแถวของ explore ใต้ขั้นที่ส่งงาน request แรกของ explore เหมือนลูกแบบรอทุกอย่าง: system prompt ของ explore
          และข้อความแรกที่มีแค่ environment กับ `task` explore ไม่รู้ว่าตัวเองรันเบื้องหลัง และยังต้องจบด้วย `report`
        from: engine
        to: model
        sees:
          - kind: task
            title: explore
            status: running
            detail: 0:02
            actions:
              - Cancel
          - kind: payload
            source: packages/docs/src/data/recorded/background-wake.jsonl#line=4
            select: messages[0]
            highlight: ['content[1].text']

    - id: owed
      beat:
        title: Geno ไม่รอ explore
        text: >-
          Geno จดว่า session นี้ค้างรายงานหนึ่งฉบับ แล้วตอบ model ทันที ผลของ call บอก session id ของ explore
          บอกว่ารายงานจะมาเป็นข้อความจาก Geno ห้ามเดาผลก่อนนั้น และห้ามทำงานซ้ำกับมัน model บอกคุณว่า explore กำลังค้น
        from: engine
        to: model
        sees:
          kind: payload
          source: packages/docs/src/data/recorded/background-wake.jsonl#line=6
          select: messages[2].content[0]
          highlight: [content]
      lane: loop
      at: tools
      do: >-
        `launch` ไม่รอลูก: session ของแม่ติดหนี้รายงานหนึ่งฉบับ (`owe()`) และ `waits.child` ลงทะเบียนการรอ
        แล้วคืนผลทันทีว่าเริ่ม explore แล้ว รายงานจะมาเป็นข้อความจาก Geno และห้ามเดาผลก่อนรายงานมาถึง
      ref: "packages/engine/src/subagents.ts#\"const paid = parentInbox!.owe();\""
      emits: [Started]

    - id: waits
      lane: server
      at: tasks
      alongside: true
      do: >-
        งานของ session ในแผง Tasks จดว่ารอ explore อยู่ ระหว่างที่ turn ยังรัน แถวยังไม่บอกเรื่องนี้ (`wakesOf` ข้ามงานที่ยังรัน)
        เมื่อ turn จบ แถวจึงบอกว่ารออะไร
      sees: หลัง turn จบ แถวของ session ในแผง Tasks บอก "Wakes on explore"
      ref: packages/core/src/wake.ts#waitsForText

    - use: tool-result-returns
    - use: model-call

    - id: says
      lane: model
      do: >-
        model ตอบผู้ใช้ว่า explore กำลังสำรวจอยู่และจะเล่าเมื่อรายงานมาถึง แล้วจบด้วย `stop_reason: end_turn`
      ref: "packages/engine/src/gateway.ts#\"stopReason: message.stop_reason,\""
      emits: [end_turn]

    - id: lets-go
      beat:
        title: Turn จบ แต่ explore ทำงานต่อ
        text: Geno ปลุก session ได้ทีหลัง จึงไม่ถือ turn ไว้ แชตปิดทุกอย่างของ turn แถวของ explore จึงขึ้นว่า Cancelled ทั้งที่มันยังทำงาน
        from: engine
        to: panel
        sees:
          kind: composer
          state: idle
          header: worked for 12s
      lane: loop
      at: agent
      do: >-
        `loopStep` ตัดสิน `done(end_turn)` และ turn ไม่ถูกถือไว้เพราะ engine ปลุก session ได้ (`wakeLater`)
        ใน `finally` ของ `runAgent` turn จบด้วย `end_turn` จึง `detach()` ลูกเบื้องหลังให้ทำงานต่อหลังรอบนี้จบ
      ref: "packages/engine/src/agent.ts#\"if (wakeLater) children?.detach();\""
      phase: ending

    - id: turn-over
      lane: panel
      at: rail
      do: >-
        turn จบแบบ done `turn-end` ปิดทุกอย่างที่ยังรันอยู่ใน turn นั้น รวมถึงแถวของลูกเบื้องหลัง ซึ่งขึ้นเป็น Cancelled ทั้งที่ลูกยังทำงานอยู่
      sees: หัวข้อ "worked for 12s" คำตอบของ model และแถว explore ที่ขึ้นไอคอน cancelled
      ref: "packages/extension/src/chat/transcript.ts#\"const children = Object.keys(settled.children\""
      phase: idle

    - id: report
      beat:
        title: explore ส่งรายงาน แล้ว Geno บันทึกไว้
        text: explore ค้นเสร็จแล้วรายงาน แถวของมันเปลี่ยนจาก Cancelled เป็น Done ไม่มี turn รันอยู่ Geno จึงบันทึกรายงานลง log ทันที
        from: model
        to: engine
        sees:
          kind: task
          title: explore
          status: done
      lane: child@explore
      at: model
      do: >-
        ลูกค้นต่อจนเสร็จ แล้วเรียก `report` พร้อมรายการที่เรียก `parseVersion` ลูกจบแบบ `done`
      ref: packages/engine/src/subagents.ts#reportExecutor
      emits: [report]

    - id: row-done
      lane: server
      at: updates
      do: >-
        `acpChildHost.ended` ส่ง `subagent_update` สถานะ `idle` แผงแชตเปลี่ยนแถวของลูกจาก Cancelled เป็น Done
      ref: packages/engine/src/subagent-acp.ts#acpChildHost
      emits: [subagent_update, idle]

    - id: inbox
      lane: server
      at: wakes
      do: >-
        รอบของแม่จบไปแล้ว `launch` จึงใส่ทั้ง `child-end` และรายงานในรั้วลงกล่องข้อความของ session แล้วล้างหนี้กับการรอ
        `inbox.arrived` บันทึกสิ่งที่มาถึงลง log ทันที (`logArrivals`): `child-end` และข้อความ `user` จากลูก (`from: 'child'`)
      ref: packages/engine/src/background-hooks.ts#logArrivals
      emits: [child-report, child-end]

    - id: gate
      beat:
        title: Geno ดูว่าปลุกได้ไหม
        text: Geno รอ 2 วินาทีให้สิ่งที่มาใกล้กันรวมเป็นชุดเดียว และตรวจว่ามีการ์ดค้าง หรือคุณกำลังพิมพ์ไหม
        from: engine
        to: engine
        ask: คุณทำอะไรอยู่
      lane: server
      at: wakes
      do: >-
        `WakeDriver.look` ถาม `wakeGate`: มีสิ่งที่ยังไม่ได้ปลุกไหม การปลุกเปิดอยู่ไหม มี turn รัน การ์ดค้าง หรือผู้ใช้กำลังพิมพ์ไหม
        และรอ 2 วินาทีให้สิ่งที่มาใกล้กันรวมเป็นชุดเดียว
      ref: packages/core/src/wake.ts#wakeGate
      fork:
        ask: ผู้ใช้กำลังทำอะไรตอนรายงานมาถึง
        options:
          - id: idle
            label: ไม่ได้ทำอะไร
            then: wake

          - id: typing
            label: กำลังพิมพ์ในช่องพิมพ์ของ session นี้
            then: wake
            steps:
              - lane: server
                beat:
                  title: Geno รอจนคุณลบร่าง
                  text: ช่องพิมพ์ที่มีร่างบอก engine ว่าคุณกำลังพิมพ์ Geno ไม่ปลุกทับ เมื่อคุณลบร่างจนว่าง Geno รออีก 2 วินาทีแล้วจึงปลุก
                  from: engine
                  to: engine
                at: wakes
                do: >-
                  ช่องพิมพ์ที่มีร่างข้อความบอก engine ผ่าน `_gcode/draft` ประตูตอบ `hold` (`typing`)
                  เมื่อผู้ใช้ลบร่างจนว่าง ประตูรออีก 2 วินาทีแล้วจึงปลุก
                ref: packages/engine/src/wake-hooks.ts#WakeDriver.draft

          - id: sends
            label: ส่ง prompt ใหม่ก่อน
            steps:
              - lane: user
                beat:
                  title: คุณส่ง prompt ใหม่ก่อน
                  text: turn ของคุณเริ่มก่อน และพารายงานที่บันทึกไว้ไปด้วย เมื่อ Geno ดูอีกครั้ง ไม่มีอะไรใหม่ให้ปลุก
                  from: you
                  to: panel
                  end: Turn ของคุณอ่านรายงาน
                do: ผู้ใช้ส่งคำถามใหม่ก่อนประตูจะปลุก
              - lane: server
                at: turns
                do: >-
                  turn ของ prompt นี้เริ่มก่อน และการดูประตูต่อคิวหลังงานของ turn นี้ เมื่อ event `user` ของ prompt ถูกบันทึกแล้ว
                  ไม่มีอะไรมาถึงหลังจุดนั้น ประตูจึงตอบ `none` (ถ้าดูในช่วงสั้นๆ ก่อนนั้นจะได้ `hold` (`turn`))
                  รายงานที่บันทึกลง log แล้วไปกับ prompt นี้ในคำขอแรก ไม่มี turn ที่ถูกปลุก
                ref: packages/engine/src/serve.ts#runTurn
                phase: starting
                end: { turn: continues }

    - id: wake
      beat:
        title: Geno เปิด turn ใหม่เอง
        text: แชตเปิด turn ที่ไม่มีข้อความของคุณ หัวของมันมีกระดิ่งกับเหตุที่ปลุก ปุ่ม Stop ใช้ได้ตามปกติ
        from: engine
        to: panel
        sees: 'กระดิ่งกับ "woke: 1 task finished" หัวข้อ "working" และปุ่ม Stop'
      lane: server
      at: wakes
      do: >-
        ประตูตอบ `wake` `WakeDriver` เลือกหน้าต่างที่แสดง session นี้ (หรือหน้าต่างแรกที่ต่ออยู่) ให้รัน `wakeTurn` ซึ่งเรียก `runTurn` แบบ `wake`
        `logWake` บันทึกข้อความแรกของ turn จาก engine เป็น event `user` ที่มี `from: 'wake'` (ไม่มี event `wake` เพราะสิ่งที่มาคือรายงานของลูก)
        แล้ว `runTurn` ส่งข้อความนั้นเป็น `user_message_chunk` พร้อม `WAKE_META` ขีดจำกัดของ turn นับต่อจาก prompt ล่าสุดของผู้ใช้
      ref: packages/engine/src/serve.ts#logWake
      emits: [user, user_message_chunk, WAKE_META]
      phase: starting

    - id: adopt
      lane: editor
      at: chat
      do: >-
        `user_message_chunk` ที่มี `WAKE_META` ทำให้ `woken` เปิด turn ใหม่ในแผงโดยไม่มีข้อความของผู้ใช้ และรับ turn นี้เป็นของตัว
        ปุ่ม Stop ใช้ได้เหมือน turn ที่ผู้ใช้ส่งเอง
      ref: packages/extension/src/chat/chat.ts#Chat.woken
      emits: [turn-start]

    - id: head
      lane: panel
      at: rail
      alongside: true
      do: หัวของ turn ใหม่มีไอคอนกระดิ่งกับเหตุที่ปลุกแทนข้อความของผู้ใช้
      sees: >-
        กระดิ่งกับ "woke: 1 task finished" หัวข้อเป็น "working" และปุ่ม Stop
      ref: packages/extension/src/chat/render.ts#turnHead

    - use: model-call

    - id: relays
      beat:
        title: Model เล่าผลของ explore
        text: >-
          request ของ turn ที่ถูกปลุกจบด้วยโน้ตของ Geno สองอัน อันแรกคือรายงานในรั้ว `<subagent_report>` พร้อมคำเตือน
          อันที่สองบอกว่า Geno เริ่ม turn นี้เอง (woke: 1 task finished) ทั้งสองขึ้นต้นด้วยบรรทัดว่าไม่ใช่ข้อความของผู้ใช้
          model อ่านแล้วเล่าผลให้คุณ การปลุกนับรวมไม่เกิน 12 ครั้งนับจาก prompt ล่าสุดของคุณ
        from: model
        to: panel
        sees:
          kind: payload
          source: packages/docs/src/data/recorded/background-wake.jsonl#line=10
          select: messages[4]
          highlight: ['content[0].text', 'content[1].text']
        end: Turn ที่ถูกปลุกจบ
      lane: model
      do: >-
        model อ่านรายงานที่ขึ้นต้นด้วยบรรทัดว่าไม่ใช่ข้อความของผู้ใช้ ตามด้วยข้อความ "Geno started this turn by itself (woke: 1 task finished)..."
        แล้วเล่าผลของ explore ให้ผู้ใช้ จบด้วย `stop_reason: end_turn`
      ref: packages/core/src/wake.ts#wakeNotice
      emits: [end_turn]
      phase: calling-model

    - id: woken-ends
      lane: loop
      at: step
      do: >-
        `loopStep` ตัดสิน `done(end_turn)` turn ที่ถูกปลุกจบแบบ `done` และนับเป็นหนึ่งในการปลุกของชั่วโมงนี้ (ไม่เกิน 12 ครั้งนับจาก prompt ล่าสุดของผู้ใช้)
      ref: packages/core/src/loop.ts#AFTER_STOP
      emits: [end_turn]
      phase: ending

    - id: ended
      lane: editor
      at: chat
      do: >-
        แผงไม่มีคำขอ `session/prompt` ของ turn นี้ `adoptedEnded` ใน extension host อ่านการจบจากงานในแผง Tasks แทน
        แล้วส่ง action `turn-end` ให้แผงแสดงท้าย turn ตามปกติ
      sees: หัวข้อ "worked for 7s" และคำตอบที่เล่าผลของ explore
      ref: packages/extension/src/chat/chat.ts#Chat.adoptedEnded
      emits: [turn-end]
      end: { turn: done, reason: end_turn }
---

turn ที่ถูกปลุกคือ turn ปกติที่ engine เริ่มเอง ไม่มี prompt ของผู้ใช้: ข้อความแรกมาจาก `logWake`
และสิ่งที่มาถึงอยู่ใน log ก่อนหน้านั้นแล้ว

สิ่งที่ควรสังเกต

- **ปลุกได้เมื่อมีหน้าต่าง** ถ้าไม่มี VS Code ที่เชื่อมกับ engine ประตูตอบ `hold` (`window`) จนกว่าหน้าต่างจะเชื่อมมา
- **ปลุกถูกพักหลัง error** turn ที่จบด้วย Stop ขีดจำกัด หรือ error พักการปลุกจนผู้ใช้ส่ง prompt ใหม่ และครบ 12 ครั้งต่อชั่วโมงก็พักเช่นกัน
- **งบใช้ร่วมกับ prompt ของผู้ใช้** turn ที่ถูกปลุกนับขีดจำกัด 40 ครั้งและ $0.40 ต่อจาก prompt ล่าสุดของผู้ใช้ ไม่ได้เริ่มใหม่
- **ลูกไม่ถูกปลุก** session ของลูกไม่มีวันถูกปลุก รายงานของลูกไปที่แม่เสมอ
- **แถวของลูกขึ้น Cancelled ระหว่างที่ยังรัน** (อ่านจากโค้ด) `turn-end` ปิดลูกทุกตัวที่ยังรันเป็น cancelled
  โดยไม่แยกลูกเบื้องหลังที่ถูก `detach()` ไว้ แถวจะกลับเป็น Done เมื่อ `child-end` มาถึง
  แต่การอัปเดตนั้นใช้กับ turn ล่าสุดในแผง (`onLast`) ถ้าผู้ใช้ส่ง prompt ใหม่ไปก่อน แถวเดิมจะค้างเป็น Cancelled
