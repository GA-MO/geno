---
title: กด Stop ขณะสรุปบริบท
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
      do: >-
        `compactContext` ส่งส่วนเก่าของบทสนทนาไปให้โมเดลสรุป การเรียกนี้ใช้ signal เดียวกับ turn
      ref: packages/engine/src/compact.ts#compactContext
      sees: แถวประกาศ "Compacting the context" พร้อมไอคอนหมุนท้าย turn
      phase: compacting

    - id: press
      lane: user
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
      do: >-
        `callModel` ไม่ได้ตรวจ signal ระหว่างทาง มันยังบันทึก `checkpoint` ของ workspace ตามปกติ
        แล้วส่งคำขอให้ gateway
      ref: "packages/engine/src/drive.ts#\"if (mode.beforeCall !== undefined) await record(await mode.beforeCall(events));\""
      emits: [checkpoint]

    - id: gateway
      lane: loop
      at: gateway
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
[กด Stop ขณะโมเดลกำลังเขียน](/scenarios/ctl/stop-while-streaming/) ต่างกันแค่ไม่มีข้อความครึ่งเดียวค้าง

สิ่งที่ควรสังเกต

- **การสรุปที่ถูกยกเลิกไม่เหลือร่องรอย** ไม่มี event `compact` ไม่มีเส้นคั่น และไม่มีบรรทัด "compact: ..." ใน stderr
  การกด Continue เริ่ม turn ใหม่ด้วย context เต็มเท่าเดิม และ `callModel` ของ turn นั้นจะสรุปใหม่ตั้งแต่ต้น
- **ยังมี checkpoint หนึ่งจุดหลัง Stop** `callModel` บันทึก `checkpoint` ก่อนรู้ว่าการเรียกจะไม่ออกไป
  Rewind และ Undo จึงเห็นจุดนี้เพิ่มขึ้นหนึ่งจุดโดยไม่มีการเรียกโมเดลตามมา
- **`/compact` ที่ผู้ใช้สั่งเองต่างออกไป** ทางนั้นไม่ใช่ turn ของ loop Stop ได้คำตอบ "Stopped. The context is as it was."
  และหัวข้อเป็น "worked for ..." ดู [/compact ระหว่าง turn](/scenarios/ctx/compaction-manual/)
