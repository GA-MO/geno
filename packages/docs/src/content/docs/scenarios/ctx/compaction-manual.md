---
title: "คุณสั่ง /compact ระหว่าง turn"
description: ผู้ใช้สั่งสรุปบริบทเองด้วย /compact หรือปุ่ม Compact engine สรุปโดยไม่เปิด loop และ turn จบแบบ done
scenario:
  surface: vscode
  given:
    - เปิด session ของ Geno เอง (ไม่ใช่ backend ภายนอก) ในแผงแชตของ VS Code
    - ไม่มี turn ทำงานอยู่ และวงแหวน context ในช่องพิมพ์เกิน 80% จึงมีปุ่ม Compact ให้กด
  trigger: >-
    ผู้ใช้พิมพ์ `/compact เก็บรายละเอียดเรื่อง migration ไว้` แล้วกด Enter (กดปุ่ม Compact ก็ส่ง `/compact` แบบเดียวกัน)
  covers: [ctx.compaction-manual]
  related: [ctx.compaction-auto, ext.slash-builtin-engine, ctl.stop-during-compaction]
  steps:
    - use: ext-slash-sent
      beat:
        title: "คุณพิมพ์ /compact พร้อมเรื่องที่ให้เน้น"
        text: >-
          ไม่มี turn ทำงานอยู่ และวงแหวน context เกิน 80% คุณพิมพ์ `/compact เก็บรายละเอียดเรื่อง migration ไว้`
          หรือกดปุ่ม Compact ซึ่งส่งคำสั่งเดียวกัน
        from: you
        to: panel
        sees: { kind: composer, state: idle, text: /compact เก็บรายละเอียดเรื่อง migration ไว้ }

    - id: builtin
      lane: server
      at: turns
      beat:
        title: "Engine ทำ /compact เอง ไม่เปิด loop"
        text: >-
          `/compact` เป็นคำสั่งที่ engine ทำเอง มันจองช่อง turn ของ session ไว้เหมือน turn จริง ปุ่ม Stop จึงหยุดได้ และ
          prompt อื่นเริ่มไม่ได้ระหว่างนี้
        from: engine
        to: engine
      do: >-
        `/compact` เป็นคำสั่ง `builtin` ที่ engine ทำ `runBuiltin` ส่งต่อให้ `compactBetweenTurns` พร้อม focus ที่ผู้ใช้พิมพ์
        ซึ่งลงทะเบียน `AbortController` ไว้ใน `turns` เหมือน turn จริง (Stop จึงหยุดได้ และ prompt อื่นเริ่มไม่ได้)
        แล้วอ่าน log ภายใน lock ของ session
      ref: packages/engine/src/serve.ts#compactBetweenTurns
      emits: [builtin]

    - id: notice
      lane: server
      at: updates
      beat:
        title: "แชตขึ้น Compacting the context"
        text: >-
          engine แจ้งหน้าต่างที่แสดง session นี้อยู่ ใต้ชิป `/compact` ขึ้นแถวประกาศพร้อมไอคอนหมุน
        from: engine
        to: panel
        sees: { kind: notice, text: Compacting the context, tone: info }
      do: >-
        engine ส่ง `notice` "Compacting the context" ผ่าน `viewers.notify` ไปที่หน้าต่างที่แสดง session นี้อยู่ตอนนั้น (มีได้ทีละหนึ่ง)
      ref: "packages/engine/src/serve.ts#\"notify({ sessionUpdate: 'notice', severity: 'info', title: 'Compacting the context' });\""
      emits: [notice, Compacting the context]
      phase: compacting

    - id: shown
      lane: panel
      at: rail
      alongside: true
      do: ใต้ชิป `/compact` ขึ้นแถวประกาศพร้อมไอคอนหมุน
      sees: แถวประกาศ "Compacting the context"
      ref: packages/extension/src/chat/render.ts#turnNotice

    - id: summarize
      lane: server
      at: turns
      beat:
        title: "Geno ให้ model สรุปโดยเน้นเรื่องที่คุณบอก"
        text: >-
          Geno วางจุดตัดแบบเดียวกับ compaction อัตโนมัติ แล้วเรียก model หนึ่งครั้งโดยไม่มี tool
          เรื่องที่คุณพิมพ์ไปกับคำขอ ให้สรุปเน้นเรื่องนั้น
        from: engine
        to: model
        ask: "ผลเป็นอย่างไร"
      do: >-
        `compactContext` (ตัวเดียวกับที่ loop ใช้) วางจุดตัดด้วย `planCompaction` แล้วเรียก model หนึ่งครั้งด้วย `SUMMARY_SYSTEM`
        ไม่มี tool focus ของผู้ใช้ถูกใส่ในคำขอให้สรุปเน้นเรื่องนั้น
      ref: packages/engine/src/compact.ts#compactContext
      fork:
        ask: ผลของการสรุปเป็นอย่างไร
        options:
          - id: compacted
            label: สรุปได้
            steps:
              - lane: model
                beat:
                  title: "Model เขียนสรุปที่เน้น migration"
                  text: >-
                    model สรุปส่วนเก่าของบทสนทนา โดยเก็บรายละเอียดเรื่อง migration ไว้ตามที่คุณขอ
                  from: model
                  to: engine
                do: >-
                  model เขียนสรุปส่วนเก่าของบทสนทนา โดยเน้นเรื่อง migration ตามที่ผู้ใช้ขอ
                ref: packages/core/src/compaction.ts#SUMMARY_SYSTEM
              - lane: server
                at: turns
                beat:
                  title: "Geno บันทึกสรุปลง session"
                  text: >-
                    engine บันทึกสรุปพร้อมเรื่องที่ให้เน้นต่อท้ายบันทึกของ session แล้วแจ้งแชต SessionStart hook ได้รันหลัง
                    compaction และขนาด context ใหม่ถูกส่งไปที่ช่องพิมพ์
                  from: engine
                  to: panel
                do: >-
                  engine ต่อท้าย log ด้วย event `compact` (trigger `manual` พร้อม focus) โดยตรง ไม่ผ่าน `drive`
                ref: "packages/engine/src/serve.ts#\"const event = numbered(outcome.event, log.events);\""
                emits: [compact, manual]
              - lane: server
                at: updates
                do: >-
                  `compactUpdate` ส่ง `agent_message_chunk` ที่มี `COMPACT_META` ไปที่หน้าต่างที่แสดง session นี้อยู่
                ref: packages/engine/src/session-replay.ts#compactUpdate
                emits: [agent_message_chunk, COMPACT_META]
              - lane: policy
                at: hooks
                do: >-
                  SessionStart hook ด้วย source `compact` ได้รัน ถ้ามีผล ข้อความถูกต่อท้าย log เป็น `hook-context`
                ref: packages/engine/src/hooks.ts#HookSessions.sessionStart
                emits: [SessionStart]
              - lane: server
                at: updates
                do: >-
                  `usage_update` บอกขนาด context ใหม่ วงแหวนในช่องพิมพ์ลดลงและปุ่ม Compact หายไป
                ref: packages/engine/src/usage-update.ts#usageUpdate
                emits: [usage_update]
              - lane: panel
                at: rail
                beat:
                  title: "แชตขึ้นเส้นคั่นพร้อม Focus"
                  text: >-
                    แชตวาดเส้นคั่นที่พับได้ เปิดแล้วเห็น Focus สรุป และรายการไฟล์ วงแหวน context ลดลงและปุ่ม Compact หายไป
                  from: panel
                  to: you
                  sees: "เส้นคั่น \"Context compacted · 184,213 → about 31,400 tokens\" และ Focus \"เก็บรายละเอียดเรื่อง migration ไว้\""
                alongside: true
                do: >-
                  `compactStep` วาดเส้นคั่นที่พับได้ เปิดแล้วเห็น Focus สรุป และรายการไฟล์
                  คำตอบของคำสั่งเป็นข้อความว่าง ไม่มีอะไรตามมาในแผง
                sees: >-
                  เส้นคั่น "Context compacted · 184,213 → about 31,400 tokens" และ Focus "เก็บรายละเอียดเรื่อง migration ไว้"
                ref: packages/extension/src/chat/compact-view.ts#compactStep
              - lane: server
                at: turns
                beat:
                  title: "Engine ตอบว่าคำสั่งจบ"
                  text: >-
                    engine ตอบว่างานจบแบบ done ค่าใช้จ่ายของการสรุปไปกับคำตอบนี้ VS Code ส่งต่อให้แผง
                  from: engine
                  to: panel
                do: >-
                  `runTurn` ตอบ `session/prompt` ด้วย `stopReason: end_turn` และงานจบแบบ `done` ค่าใช้จ่ายของการสรุปไปกับคำตอบ
                ref: "packages/engine/src/serve.ts#\"return { end: 'end_turn', response: turnResponse('end_turn', usageOf(spent, undefined)) };\""
                emits: [end_turn]
                phase: ending
              - lane: editor
                at: chat
                do: >-
                  `prompt()` ใช้ `turnEndOf` อ่านได้ `done` แล้วส่ง action `turn-end`
                ref: "packages/extension/src/chat/chat.ts#\"const status = turnEndOf(response);\""
                emits: [turn-end]
              - lane: panel
                at: rail
                beat:
                  title: "แชตขึ้นประกาศทั้งที่สรุปสำเร็จ"
                  text: >-
                    turn ไม่มีข้อความหลังเส้นคั่น แผงจึงถือว่าคำตอบไม่มีข้อความ และขึ้นประกาศพร้อมปุ่ม Continue กับ Retry
                    ทั้งที่การสรุปสำเร็จแล้ว
                  from: panel
                  to: you
                  end: "สรุปสำเร็จ"
                  sees: { kind: notice, text: Geno stopped without a reply, detail: Its last reply had no text., actions: [ Continue, Retry ], tone: warning }
                do: >-
                  หัวข้อเปลี่ยนเป็นเวลาที่ทำงาน แต่ turn ไม่มีข้อความหลังเส้นคั่น `missingReply` จึงถือว่าคำตอบไม่มีข้อความ
                  และแสดงประกาศพร้อมปุ่ม Continue กับ Retry ทั้งที่การสรุปสำเร็จ
                sees: >-
                  หัวข้อ "worked for 9s" และประกาศ "Geno stopped without a reply · Its last reply had no text." [Continue] [Retry]
                ref: packages/extension/src/chat/rail.ts#missingReply
                end: { turn: done, reason: end_turn }

          - id: nothing
            label: ยังไม่มีอะไรให้สรุป
            then: reply
            steps:
              - lane: server
                at: turns
                beat:
                  title: "ยังไม่มีอะไรให้สรุป"
                  text: >-
                    บทสนทนายังสั้น หรือ model ยังไม่เคยตอบ Geno หาจุดตัดไม่ได้ จึงไม่เรียก model
                  from: engine
                  to: engine
                do: >-
                  `planCompaction` หาจุดตัดไม่ได้ เช่นบทสนทนายังสั้นหรือยังไม่มีคำตอบของ model ไม่มีการเรียก model
                  คำตอบของคำสั่งคือ "Nothing to compact yet: the conversation is short enough to keep as it is."
                ref: "packages/engine/src/serve.ts#\"if (outcome.kind === 'nothing') return\""

          - id: stopped
            label: ผู้ใช้กด Stop ระหว่างสรุป
            then: reply
            steps:
              - lane: user
                beat:
                  title: "คุณกด Stop ระหว่างสรุป"
                  text: >-
                    แถว Compacting the context ยังหมุน คุณกด Stop แผงสั่ง engine ให้หยุด
                  from: you
                  to: panel
                do: ผู้ใช้กด Stop ขณะแถว "Compacting the context" ยังหมุน
              - lane: editor
                at: chat
                do: >-
                  `Chat.stop` ส่ง notification ACP `session/cancel`
                ref: packages/extension/src/chat/chat.ts#Chat.stop
                emits: [session/cancel]
              - lane: server
                at: turns
                beat:
                  title: "Geno ยกเลิกการสรุป"
                  text: >-
                    การเรียก model เพื่อสรุปถูกยกเลิก ไม่มีอะไรถูกบันทึก context ยังเหมือนเดิม
                  from: engine
                  to: engine
                do: >-
                  engine abort controller ที่ `/compact` ลงทะเบียนไว้ การเรียก model เพื่อสรุปถูกยกเลิก ไม่มีอะไรถูกบันทึก
                  คำตอบของคำสั่งคือ "Stopped. The context is as it was."
                ref: "packages/engine/src/serve.ts#\"if (outcome.kind === 'failed') return controller.signal.aborted\""

    - id: reply
      lane: server
      at: turns
      beat:
        title: "Engine ส่งคำตอบของคำสั่ง"
        text: >-
          engine ส่งคำตอบของคำสั่งเป็นข้อความ แล้วตอบว่างานจบแบบ done แม้คุณจะกด Stop เพราะคำสั่งที่ engine
          ทำเองตอบแบบนี้เสมอ
        from: engine
        to: panel
      do: >-
        `runTurn` ส่งคำตอบของคำสั่งเป็น `agent_message_chunk` แล้วตอบ `session/prompt` ด้วย `stopReason: end_turn`
        งานจบแบบ `done` แม้ผู้ใช้จะกด Stop เพราะทางของคำสั่ง builtin ตอบ `end_turn` เสมอ
      ref: "packages/engine/src/serve.ts#\"if (reply !== '') await from.client.notify(\""
      emits: [agent_message_chunk, end_turn]
      phase: ending

    - id: turn-end
      lane: editor
      at: chat
      do: >-
        `prompt()` ใช้ `turnEndOf` อ่านได้ `done` แล้วส่ง action `turn-end`
      ref: "packages/extension/src/chat/chat.ts#\"const status = turnEndOf(response);\""
      emits: [turn-end]

    - id: footer
      lane: panel
      at: rail
      beat:
        title: "แชตขึ้นคำตอบของคำสั่ง"
        text: >-
          คำตอบขึ้นเป็นข้อความของ Geno และหัวข้อเป็น worked for แม้ในทางที่คุณกด Stop
        from: panel
        to: you
        end: "ไม่ได้สรุป context เหมือนเดิม"
        sees: { kind: message, from: geno, text: "Nothing to compact yet: the conversation is short enough to keep as it is." }
      do: >-
        คำตอบของคำสั่งขึ้นเป็นข้อความของ Geno หัวข้อเป็น "worked for ..." แม้ในทางที่ผู้ใช้กด Stop
      sees: >-
        "Nothing to compact yet: ..." หรือ "Stopped. The context is as it was." และหัวข้อ "worked for 2s"
      ref: packages/extension/src/chat/rail.ts#headerOf
      end: { turn: done, reason: end_turn }
---

`/compact` ไม่ใช่ turn ของเอเจนต์: engine ไม่เรียก `runAgent` ไม่มี checkpoint ไม่มีงานในแผง Tasks
และ prompt `/compact` ไม่ถูกบันทึกเป็น event `user` เมื่อเล่น session ซ้ำ `compactPrompt` สร้างชิป `/compact` ขึ้นจาก event `compact` แทน

สิ่งที่ควรสังเกต

- **ระหว่าง turn ใช้ไม่ได้** ถ้ามี turn ทำงานอยู่ แผงแชตเก็บ `/compact` ไว้ในคิวรอจน turn จบ (ปุ่ม Compact ก็ถูกปิดไว้พร้อมคำอธิบาย)
  ถ้าคำขอมาถึง engine ขณะ turn ทำงาน `runTurn` ปฏิเสธด้วย "a turn is already running" ก่อนจะถึง `compactBetweenTurns`
  ข้อความ "A turn is running. /compact runs between turns..." ใน `compactBetweenTurns` จึงไม่ถูกใช้ในทางนี้
- **ประกาศไปที่หน้าต่างที่แสดง session** ประกาศและเส้นคั่นส่งผ่าน `viewers.notify` ซึ่งมีผู้ดูได้ทีละหน้าต่าง คือหน้าต่างที่แสดง session นี้ล่าสุด
  ไม่จำเป็นต้องเป็นหน้าต่างที่สั่ง ส่วนคำตอบของคำสั่งส่งตรงถึงหน้าต่างที่สั่ง
- **Stop ได้ผลเป็น done** ทางของคำสั่ง builtin ตอบ `end_turn` เสมอ หัวข้อจึงเป็น "worked for" ไม่ใช่ "stopped"
  ข้อความ "Stopped. The context is as it was." เป็นที่เดียวที่บอกว่าหยุดแล้ว
- **สรุปสำเร็จแล้วยังขึ้นประกาศ "Geno stopped without a reply"** คำตอบของคำสั่งที่สรุปสำเร็จเป็นข้อความว่าง
  `missingReply` ไม่ยกเว้น turn ที่มีแต่เส้นคั่น จึงแสดงประกาศพร้อม Continue และ Retry (Retry ส่ง `/compact` ซ้ำ)

ถ้า Geno สรุปเองระหว่าง turn ดู [Compaction อัตโนมัติก่อนเรียก model](/scenarios/ctx/compaction-auto/)
