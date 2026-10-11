---
title: exception หลุดออกจาก loop
description: error ที่ไม่ใช่ error ของผู้ให้บริการ เช่น stream ที่จบไม่ครบ หลุดผ่าน gateway ออกจาก loop turn จบแบบ failed โดยไม่มีอะไรใน log และแผงเห็นแค่ "Internal error"
tableOfContents: false
sidebar:
  order: 3
scenario:
  surface: vscode
  given:
    - ผู้ใช้ส่งข้อความในแผงแชตของ VS Code และ turn กำลังทำงาน
    - ผู้ให้บริการเป็น Anthropic (wire แบบ Anthropic) และโมเดลกำลัง stream คำตอบ
  trigger: >-
    การเชื่อมต่อปิดอย่างเรียบร้อยกลางคำตอบ stream จบโดยไม่มี event `message_stop`
  covers: [err.exception-escapes-loop]
  related: [err.transient-retried, err.engine-crash-restart, ctl.stop-while-streaming]
  steps:
    - use: model-call

    - id: torn
      lane: model
      do: >-
        ข้อความส่วนแรกของคำตอบ stream มาถึงแผงแล้ว แต่ stream ปิดก่อนคำตอบจะครบ `messageFromEvents` ประกอบคำตอบจาก event ที่ได้ไม่ได้
      ref: "packages/engine/src/wire.ts#\"const message = messageFromEvents(seen);\""
      phase: calling-model

    - id: wire
      lane: loop
      at: gateway
      do: >-
        wire โยน `EngineError` "Anthropic ended the answer's stream before the answer was complete"
        error นี้ไม่ใช่ `AnthropicError` จึงไม่ผ่าน `classifyFailure` ทั้งที่ข้อความแบบนี้ควรนับเป็นข้อผิดพลาดชั่วคราว
        gateway ไม่ลองใหม่ แต่โยนต่อ
      ref: "packages/engine/src/gateway.ts#\"if (!(error instanceof AnthropicError)) throw error;\""

    - id: escapes
      lane: loop
      at: drive
      do: >-
        exception หลุดออกจาก `callModel` และ `drive` ไม่มี event `error` หรือ `assistant` ถูกบันทึก
        ข้อความที่ stream มาแล้วหายไปจากประวัติ prompt ของผู้ใช้ยังค้างอยู่ใน log โดยไม่มีคำตอบ
      ref: packages/engine/src/drive.ts#callModel
      phase: ending

    - id: cleanup
      lane: loop
      at: agent
      do: >-
        `finally` ของ `runAgent` ยังทำงาน: ปิดประตู steer (steer ที่ค้างกลายเป็น turn ถัดไป) หยุดเอเจนต์ลูกเบื้องหลัง
        และปิด sandbox
      ref: "packages/engine/src/agent.ts#\"steers.release(session.id, inbox);\""

    - id: rejected
      lane: server
      at: turns
      do: >-
        `finally` ของ `runTurn` ปิดงานในแผง Tasks แบบ `failed` และปลด lock ของ session
        คำขอ `session/prompt` ตอบด้วย error ACP SDK แปลง exception ที่ไม่ใช่ `RequestError` เป็น "Internal error"
        ข้อความจริงไปอยู่ใน `data.details` และไม่มีอะไรเขียนลง stderr ของ engine
      ref: "packages/engine/src/serve.ts#\"tasks.end(sessionId, controller.signal.aborted ? 'stopped' : ended, turn?.taskUsage(), wakes.view(sessionId));\""
      emits: [failed]

    - id: caught
      lane: editor
      at: chat
      do: >-
        `prompt()` จับ error แล้วส่ง action `error` ด้วย `error.message` ซึ่งคือ "Internal error" ตามด้วย `turn-end` สถานะ `failed`
      ref: "packages/extension/src/chat/chat.ts#\"this.dispatch({ type: 'error', message: error instanceof Error ? error.message : String(error) });\""
      emits: [error, turn-end]

    - id: shown
      lane: panel
      at: rail
      do: >-
        แผงขึ้นแถบ error ท้าย turn ข้อความที่ stream มาแล้วยังค้างอยู่ในแผงนี้จนกว่าจะ reload
        ข้อความที่รอในคิวกลับไปที่ช่องพิมพ์
      sees: >-
        ข้อความครึ่งเดียว แถบ error สีแดง "Internal error" หัวข้อ "failed after 12s" และปุ่ม Send กลับมา
      ref: packages/extension/src/chat/render.ts#errorBlock
      end: { turn: failed, reason: error }
---

ข้อผิดพลาดของผู้ให้บริการผ่าน `classifyFailure` แล้วกลายเป็นการลองใหม่ การรอ หรือ event `error` ที่อธิบายตัวเอง
ดู [ผู้ให้บริการล้มชั่วคราว](/scenarios/err/transient-retried/) แต่ error ชนิดอื่นไม่มีใครจับระหว่าง gateway กับ `runTurn`
มันหลุดออกไปเป็น error ของคำขอ ACP

สิ่งที่ควรสังเกต

- **ผู้ใช้ไม่ได้รู้เหตุผล** แผงเห็นแค่ "Internal error" เพราะ extension อ่าน `error.message` ของ `RequestError`
  ส่วนข้อความจริงอยู่ใน `data.details` ซึ่งไม่มีใครอ่าน และ engine ไม่เขียนมันลง stderr ด้วย
  (ได้จากการอ่าน `errorToResult` ของ ACP SDK ไม่ได้รันจริง)
- **stream ที่ขาดควรได้ลองใหม่** `TRANSIENT` ใน `model-error.ts` มีรูปแบบ "stream ended before message_stop" อยู่แล้ว
  แต่ `EngineError` จาก `anthropicWire` ไม่เคยผ่านตัวจัดประเภท จึงล้มทันทีแทนที่จะลองใหม่หลัง 1 วินาที
- **ที่อื่นที่โยนแบบเดียวกัน** `takeCheckpoint` ที่ git ล้ม (`checkpoint git ... failed`) และการเขียน log ที่ดิสก์เต็ม
  ให้ผลเหมือนกัน: turn จบ failed ไม่มี event `error` และ prompt ค้างอยู่
- **prompt ที่ค้างไปกับข้อความถัดไป** log จบที่ `user` ที่ยังไม่มีคำตอบ ครั้งหน้าที่ผู้ใช้ส่งข้อความ โมเดลจะเห็นทั้งสองข้อความ
