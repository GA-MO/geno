---
title: "Turn จบโดยไม่มีคำตอบ แล้วคุณกด Continue หรือ Retry"
description: turn ล่าสุดจบโดยไม่มีข้อความตอบ แผงบอกเหตุผลและให้ผู้ใช้กด Continue หรือ Retry ซึ่งเริ่ม turn ใหม่
tableOfContents: false
sidebar:
  order: 1
scenario:
  surface: vscode
  given:
    - turn ล่าสุดของแชตจบแล้วโดยไม่มีข้อความหลังขั้นสุดท้าย ในทัวร์นี้ผู้ใช้กด Stop ก่อน model ตอบ
    - ช่องพิมพ์ไม่มีข้อความรอในคิว
  trigger: >-
    แผงแชตวาด turn ที่จบแล้วโดยไม่มีคำตอบ
  covers: [mstop.no-reply-continue-retry]
  related: [ctl.stop-while-streaming, perm.ask-deny-ends-turn, mstop.limit-max-turns, mstop.empty-answer-nudged]
  steps:
    - id: notice
      lane: panel
      at: rail
      beat:
        title: "แชตบอกว่า Geno หยุดโดยไม่มีคำตอบ"
        text: >-
          turn ที่แล้วจบโดยไม่มีข้อความหลังขั้นสุดท้าย ในทัวร์นี้คุณกด Stop ก่อน model ตอบ แผงเลือกเหตุผลจากวิธีที่ turn
          จบ และใส่ปุ่มให้เพราะนี่คือ turn ล่าสุด
        from: panel
        to: you
        sees: { kind: notice, text: Geno stopped without a reply, detail: You stopped it before it answered., actions: [ Continue, Retry ], tone: warning }
      do: >-
        `missingReply` เห็นว่าไม่มีข้อความหลังขั้นสุดท้ายของ turn และไม่มีบล็อก error จึงเลือกเหตุผลจากวิธีที่ turn จบ
        turn นี้จบแบบ stopped และเพราะเป็น turn ล่าสุดที่ช่องพิมพ์ไม่มีข้อความรอในคิว `noReplyNotice` จึงใส่ปุ่ม Continue และ Retry
      sees: >-
        กล่อง "Geno stopped without a reply" เหตุผล "You stopped it before it answered." และปุ่ม [Continue] [Retry]
      ref: packages/extension/src/chat/render.ts#noReplyNotice
      phase: idle

    - id: choice
      lane: user
      beat:
        title: "คุณเลือกปุ่ม"
        text: >-
          ทั้งสองปุ่มส่งข้อความใหม่เหมือนคุณพิมพ์เอง ต่างกันที่ข้อความ ลองเลือกดู
        from: you
        to: panel
        ask: "กดปุ่มไหน"
      do: ผู้ใช้กดปุ่มหนึ่งในสองปุ่ม
      fork:
        ask: ผู้ใช้กดปุ่มไหน
        options:
          - id: continue
            label: Continue
            then: route
            steps:
              - lane: panel
                at: rail
                beat:
                  title: "คุณกด Continue"
                  text: >-
                    แผงส่งข้อความคงที่ที่บอก model ให้ทำต่อจากที่หยุดแล้วตอบให้จบ
                  from: you
                  to: panel
                  sees: { kind: message, from: you, text: "Continue where you stopped, and finish with your answer." }
                do: >-
                  ปุ่ม Continue โพสต์ `send` ด้วยข้อความคงที่ `CONTINUE_PROMPT` เหมือนผู้ใช้พิมพ์ส่งเอง
                sees: บับเบิลใหม่ "Continue where you stopped, and finish with your answer."
                ref: packages/extension/src/chat/render.ts#CONTINUE_PROMPT
                emits: [send]
          - id: retry
            label: Retry
            then: route
            steps:
              - lane: panel
                at: rail
                beat:
                  title: "คุณกด Retry"
                  text: >-
                    แผงส่งข้อความเดิมของ turn นั้นซ้ำ เฉพาะข้อความ ไฟล์แนบของ turn เดิมไม่ถูกส่งซ้ำ
                  from: you
                  to: panel
                  sees: "บับเบิลใหม่ที่มีข้อความเดียวกับ turn ก่อน"
                do: >-
                  ปุ่ม Retry โพสต์ `send` ด้วยข้อความเดิมของ turn นั้น ส่งเฉพาะข้อความ ไฟล์แนบของ turn เดิมไม่ถูกส่งซ้ำ
                sees: บับเบิลใหม่ที่มีข้อความเดียวกับ turn ก่อน
                ref: "packages/extension/src/chat/render.ts#\"title: 'Send the same message again'\""
                emits: [send]

    - id: route
      lane: editor
      at: chat
      beat:
        title: "VS Code เริ่ม turn ใหม่"
        text: >-
          ปุ่มทั้งสองหายไป เพราะ turn เดิมไม่ใช่ turn ล่าสุดแล้ว VS Code ส่งข้อความใหม่ไปที่ session เดิม
        from: panel
        to: engine
        sees: { kind: composer, state: working, header: working }
      do: >-
        `Chat.send` ส่งต่อให้ `prompt()` ซึ่งส่ง action `turn-start` ทันที ปุ่มทั้งสองหายไปเพราะ turn เดิมไม่ใช่ turn ล่าสุดแล้ว
      ref: packages/extension/src/chat/chat.ts#Chat.prompt
      emits: [turn-start]

    - id: request
      lane: editor
      at: engine-link
      do: >-
        `link()` ได้ session เดิม แล้วส่งคำขอ ACP `session/prompt` คำขอนี้ค้างอยู่จนกว่า turn ใหม่จะจบ
      ref: "packages/extension/src/chat/chat.ts#\"mine.connection.agent.request(acp.methods.agent.session.prompt, {\""

    - id: accept
      lane: server
      at: turns
      beat:
        title: "Geno รับ turn ใหม่พร้อมขีดจำกัดเต็ม"
        text: >-
          engine รับเป็น turn ใหม่ที่มาจากคุณ จำนวนครั้งและค่าใช้จ่ายเริ่มนับใหม่ turn นี้จึงได้ 40 ครั้งและ $0.40 เต็ม
        from: engine
        to: engine
      do: >-
        `runTurn` รับเป็น turn ใหม่ที่มาจากผู้ใช้ และ `drive` เริ่มนับการเรียก model และค่าใช้จ่ายจาก seq ของ prompt ใหม่
        turn นี้จึงได้ 40 ครั้งและ $0.40 เต็ม (`runTurn` ยังล้างงบของงานตามเวลาที่อาจค้างไว้ด้วย)
      ref: "packages/engine/src/drive.ts#\"const run: Run = { firstSeq: limits.countFrom ?? nextSeq(events),\""
      phase: starting

    - id: record
      lane: loop
      at: drive
      beat:
        title: "Geno บันทึกข้อความใหม่"
        text: >-
          Geno บันทึกข้อความใหม่ต่อท้ายบันทึกของ session แล้วตัดสินว่าขั้นต่อไปคือเรียก model
        from: engine
        to: engine
      do: >-
        `drive` บันทึก event `user` ของข้อความใหม่ต่อท้าย log
      ref: "packages/engine/src/drive.ts#\"await record({ kind: 'user', seq: nextSeq(events), at: new Date().toISOString(), content: prompt });\""
      emits: [user]

    - id: decide
      lane: loop
      at: step
      do: >-
        `loopStep` เห็น event `user` ใหม่เป็น event ล่าสุดของบทสนทนา จึงตัดสิน `call-model`
      ref: packages/core/src/loop.ts#loopStep
      emits: [call-model]
      phase: calling-model

    - id: message
      lane: loop
      at: model-call
      beat:
        title: "Geno รวม prompt เดิม โน้ต และข้อความใหม่"
        text: >-
          prompt เดิมยังไม่ได้คำตอบ Geno จึงรวมมันกับโน้ตที่บอกว่าคุณหยุด turn ที่แล้ว และข้อความใหม่ เป็นข้อความ user
          เดียว กด Continue model เห็นว่าคุณอนุญาตให้ทำต่อ กด Retry model เห็น prompt เดิมสองครั้ง
        from: engine
        to: engine
      do: >-
        `replayMessages` รวม prompt ที่ยังไม่ได้คำตอบ โน้ต `STOPPED_TURN_NOTE` และข้อความใหม่เป็นข้อความ user เดียว
        กด Retry model จึงเห็น prompt เดิมสองครั้งโดยมีโน้ตคั่น กด Continue model เห็น prompt เดิม โน้ต แล้ว `CONTINUE_PROMPT`
      ref: "packages/core/src/session.ts#\"if (stopped && event.from === undefined && event.steer !== true) prompts.push({ type: 'text', text: STOPPED_TURN_NOTE });\""
      emits: [STOPPED_TURN_NOTE]

    - id: sent
      lane: loop
      at: gateway
      beat:
        title: "Geno ส่งคำขอของ turn ใหม่"
        text: >-
          คำขอออกไปหา model จากตรงนี้ turn ใหม่เดินเหมือน turn ปกติ
        from: engine
        to: model
        end: "turn ใหม่เริ่ม"
      do: >-
        gateway ส่งคำขอ turn ใหม่ดำเนินต่อเหมือน turn ปกติ
      ref: packages/engine/src/gateway.ts#gatewayFor.turn
      end: { turn: continues, reason: call-model }
---

ประกาศ "Geno stopped without a reply" มาจากแผงล้วนๆ engine ไม่ได้ส่งมา `missingReply` อ่าน turn ที่จบแล้ว
และให้เหตุผลตามวิธีที่จบ

| turn จบอย่างไร | เหตุผลที่แผงแสดง |
| --- | --- |
| ถึงขีดจำกัดจำนวนครั้งหรือค่าใช้จ่าย | It reached its limit before it answered. |
| มี error อื่น | ไม่แสดงประกาศ บล็อก error บอกเหตุผลแล้ว |
| ผู้ใช้กด Stop | You stopped it before it answered. |
| ขั้นสุดท้ายถูกปฏิเสธ | It stopped at the call that was denied. |
| อย่างอื่น เช่นคำตอบว่าง | Its last reply had no text. |

สิ่งที่ควรสังเกต

- **ปุ่มมีเฉพาะ turn ล่าสุด** และเฉพาะตอนที่ช่องพิมพ์ไม่มีข้อความรอในคิว turn เก่าแสดงแค่ประกาศ
- **Continue กับ Retry เป็นข้อความธรรมดา** ทั้งสองปุ่มโพสต์ `send` เหมือนผู้ใช้พิมพ์เอง และ turn ใหม่ได้ขีดจำกัดเต็ม
  ต่างจาก "Retry now" ในช่องพิมพ์ ซึ่งเร่งการเรียก model ที่กำลังรอ backoff ใน turn เดิม
- **หลัง Stop โน้ตเป็นตัวกำหนดน้ำเสียง** `STOPPED_TURN_NOTE` บอก model ว่าผู้ใช้หยุด turn ที่แล้ว ให้ตอบคำถามก่อนแล้วถามว่าจะทำต่อหรือไม่
  ข้อความ Continue ที่ตามมาจึงเป็นคำอนุญาตให้ทำต่อ

ทัวร์นี้เริ่มหลังคุณกด Stop ทางที่ไปถึงจุดนั้นอยู่ใน [กด Stop ขณะ model กำลังเขียน](/scenarios/ctl/stop-while-streaming/)
