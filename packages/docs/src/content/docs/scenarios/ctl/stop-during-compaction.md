---
title: "กด Stop ขณะ Geno ทำ compaction"
description: ผู้ใช้กด Stop ระหว่างที่ loop สรุปบริบทอัตโนมัติก่อนเรียกโมเดล การสรุปถูกยกเลิกโดยไม่บันทึกอะไร การเรียกที่ตามมาจบทันที และ turn จบแบบ stopped
tableOfContents: false
sidebar:
  order: 7
scenario:
  surface: vscode
  given:
    - turn ทำงานมานาน context ถึงเกณฑ์การสรุปอัตโนมัติ (80% ของหน้าต่างโมเดล)
    - ผลของเครื่องมือชุดล่าสุดถูกบันทึกแล้ว และ `callModel` เริ่มสรุปบริบทก่อนเรียกโมเดล
  trigger: >-
    ผู้ใช้กด Stop ขณะแถว "Compacting the context" ยังหมุนอยู่
  covers: [ctl.stop-during-compaction]
  related: [ctx.compaction-auto, ctx.compaction-manual, ctl.stop-while-streaming, ctl.stop-while-waiting]
  steps:
    - id: summarizing
      lane: model
      beat:
        title: "Geno ให้ model สรุปบทสนทนาเก่า"
        text: >-
          context ถึง 80% ของหน้าต่าง Geno จึงส่งส่วนเก่าของบทสนทนาให้โมเดลสรุปก่อนเรียกรอบถัดไป แชตขึ้นแถว Compacting
          the context พร้อมไอคอนหมุน
        from: engine
        to: model
        sees: { kind: notice, text: Compacting the context, tone: info }
      do: >-
        `compactContext` ส่งส่วนเก่าของบทสนทนาไปให้โมเดลสรุป การเรียกนี้ใช้ signal เดียวกับ turn
      ref: packages/engine/src/compact.ts#compactContext
      sees: แถวประกาศ "Compacting the context" พร้อมไอคอนหมุนท้าย turn
      phase: compacting

    - id: press
      lane: user
      beat:
        title: "คุณกด Stop"
        text: >-
          คุณกด Stop ขณะแถวยังหมุนอยู่ แผงสั่ง engine ให้หยุด turn
        from: you
        to: engine
        sees: { kind: composer, state: working, header: working }
      do: ผู้ใช้กด Stop

    - id: cancel
      lane: editor
      at: chat
      do: >-
        `Chat.stop` ส่ง notification ACP `session/cancel`
      ref: packages/extension/src/chat/chat.ts#Chat.stop

    - id: abort
      lane: server
      at: turns
      beat:
        title: "Geno ยกเลิกการสรุป"
        text: >-
          engine ยกเลิก turn การเรียกเพื่อสรุปใช้สัญญาณเดียวกับ turn จึงจบทันที ไม่มีอะไรถูกบันทึก context
          ยังเหมือนเดิมทุกอย่าง
        from: engine
        to: engine
      do: >-
        engine หา `AbortController` ของ turn ใน `turns` แล้ว abort
      ref: "packages/engine/src/serve.ts#\"turns.get(params.sessionId)?.abort();\""

    - id: summary-aborted
      lane: loop
      at: model-call
      do: >-
        การเรียกเพื่อสรุปได้ผล `abort` `compactContext` จึงคืน `failed` ไม่มี event `compact` ถูกบันทึก
        และเพราะ signal ถูก abort `compact()` ไม่เขียนอะไรลง stderr ด้วย context ยังเหมือนเดิมทุกอย่าง
      ref: "packages/engine/src/drive.ts#\"if (outcome.kind === 'failed' && !signal.aborted) io.err(`compact: ${outcome.message}`);\""
      phase: calling-model

    - id: checkpoint
      lane: loop
      at: model-call
      beat:
        title: "Geno ยังเตรียมการเรียกถัดไป"
        text: >-
          ระหว่างทาง Geno ไม่ได้ดูสัญญาณหยุด มันยังบันทึก checkpoint ของ workspace ตามปกติ แล้วส่งคำขอต่อ
        from: engine
        to: engine
      do: >-
        `callModel` ไม่ได้ตรวจ signal ระหว่างทาง มันยังบันทึก `checkpoint` ของ workspace ตามปกติ
        แล้วส่งคำขอให้ gateway
      ref: "packages/engine/src/drive.ts#\"if (mode.beforeCall !== undefined) await record(await mode.beforeCall(events));\""
      emits: [checkpoint]

    - id: gateway
      lane: loop
      at: gateway
      beat:
        title: "คำขอไม่ได้ออกไปถึงผู้ให้บริการ"
        text: >-
          ทางส่งคำขอเห็นว่า turn ถูกหยุดแล้ว จึงคืนผลว่าคุณเป็นคนหยุดทันที Geno บันทึกเหตุนั้นแล้วจบ turn
        from: engine
        to: engine
      do: >-
        `slots.run` โยนทันทีเพราะ signal ถูก abort ไปแล้ว gateway เห็นว่า signal ถูก abort จึงคืน `abort` "interrupted by the user"
        คำขอไม่ได้ออกไปถึงผู้ให้บริการ
      ref: packages/engine/src/gateway.ts#ABORTED
      emits: [abort, interrupted by the user]

    - id: logged
      lane: loop
      at: drive
      do: >-
        `callModel` บันทึก event `error` ชนิด `abort` แล้ว `loopStep` ให้ `done(error)`
      ref: "packages/engine/src/drive.ts#\"await record({ kind: 'error', seq: nextSeq(events), at, error: result.error, message: result.message, ...timing });\""
      emits: [error]
      phase: ending

    - id: cancelled
      lane: server
      at: turns
      beat:
        title: "Engine ตอบว่า turn ถูกยกเลิก"
        text: >-
          engine บอก VS Code ว่า turn ถูกยกเลิก งานในแผง Tasks จบแบบ stopped การหยุดไม่ขึ้นเป็นแถบ error
        from: engine
        to: panel
      do: >-
        `runTurn` เห็นว่าสัญญาณถูก abort ACP ได้ `stopReason: cancelled` งานในแผง Tasks จบแบบ stopped
      ref: "packages/engine/src/serve.ts#\"const end: TurnEnd = controller.signal.aborted ? 'cancelled' : ran.reason;\""
      emits: [cancelled, stopped]

    - id: turn-end
      lane: editor
      at: chat
      do: >-
        `prompt()` ใช้ `turnEndOf` อ่านได้ `stopped` แล้วส่ง action `turn-end` error ชนิด `abort` ไม่ขึ้นเป็นแถบ error
      ref: "packages/extension/src/chat/chat.ts#\"const status = turnEndOf(response);\""
      emits: [turn-end]

    - id: shown
      lane: panel
      at: rail
      beat:
        title: "แชตขึ้นว่าคุณเป็นคนหยุด"
        text: >-
          แถว Compacting the context หายไป และไม่มีเส้นคั่นการสรุปเพราะไม่มีอะไรถูกสรุป turn ไม่มีข้อความตอบ
          แผงจึงขึ้นประกาศพร้อมปุ่มให้ทำต่อ
        from: panel
        to: you
        end: "คุณหยุด context เหมือนเดิม"
        sees: { kind: notice, text: Geno stopped without a reply, detail: You stopped it before it answered., actions: [ Continue, Retry ], tone: warning }
      do: >-
        reducer ของ `turn-end` ล้างแถวประกาศ "Compacting the context" ไม่มีเส้นคั่นการสรุปเพราะไม่มีอะไรถูกสรุป
        turn ไม่มีข้อความหลังขั้นสุดท้าย `missingReply` จึงแสดงประกาศพร้อมปุ่มให้ทำต่อ
      sees: >-
        แถวประกาศหายไป หัวข้อ "stopped after 4m 2s" กล่อง "Geno stopped without a reply · You stopped it before it answered."
        พร้อมปุ่ม [Continue] [Retry] และท้าย turn ขึ้น "Stopped by you"
      ref: packages/extension/src/chat/rail.ts#missingReply
      end: { turn: stopped, reason: cancelled }
---

การสรุปอัตโนมัติเป็นส่วนหนึ่งของการเรียกโมเดลหนึ่งครั้ง Stop ระหว่างสรุปจึงจบ turn แบบเดียวกับ
[กด Stop ขณะ model กำลังเขียน](/scenarios/ctl/stop-while-streaming/) ต่างกันแค่ไม่มีข้อความครึ่งเดียวค้าง

สิ่งที่ควรสังเกต

- **การสรุปที่ถูกยกเลิกไม่เหลือร่องรอย** ไม่มี event `compact` ไม่มีเส้นคั่น และไม่มีบรรทัด "compact: ..." ใน stderr
  การกด Continue เริ่ม turn ใหม่ด้วย context เต็มเท่าเดิม และ `callModel` ของ turn นั้นจะสรุปใหม่ตั้งแต่ต้น
- **ยังมี checkpoint หนึ่งจุดหลัง Stop** `callModel` บันทึก `checkpoint` ก่อนรู้ว่าการเรียกจะไม่ออกไป
  Rewind และ Undo จึงเห็นจุดนี้เพิ่มขึ้นหนึ่งจุดโดยไม่มีการเรียกโมเดลตามมา
- **`/compact` ที่ผู้ใช้สั่งเองต่างออกไป** ทางนั้นไม่ใช่ turn ของ loop Stop ได้คำตอบ "Stopped. The context is as it was."
  และหัวข้อเป็น "worked for ..." ดู [คุณสั่ง /compact ระหว่าง turn](/scenarios/ctx/compaction-manual/)

การสรุปที่ไม่ถูกขัดเดินต่ออย่างไร ดู [Compaction อัตโนมัติก่อนเรียก model](/scenarios/ctx/compaction-auto/)
