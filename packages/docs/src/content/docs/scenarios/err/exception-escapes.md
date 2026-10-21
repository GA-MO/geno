---
title: "Exception หลุดออกจาก loop"
description: error ที่ไม่ใช่ error ของผู้ให้บริการ เช่น stream ที่จบไม่ครบ หลุดผ่าน gateway ออกจาก loop turn จบแบบ failed ไม่มีอะไรใน log ของ session แต่ log ของ engine บันทึกไว้ และแผงเห็นข้อความของ error
scenario:
  surface: vscode
  given:
    - ผู้ใช้ส่งข้อความในแผงแชตของ VS Code และ turn กำลังทำงาน
    - ผู้ให้บริการเป็น Anthropic (wire แบบ Anthropic) และ model กำลัง stream คำตอบ
  trigger: >-
    การเชื่อมต่อปิดอย่างเรียบร้อยกลางคำตอบ stream จบโดยไม่มี event `message_stop`
  covers: [err.exception-escapes-loop]
  related: [err.transient-retried, err.engine-crash-restart, ctl.stop-while-streaming]
  steps:
    - use: model-call
      beat:
        title: "Geno ส่งคำขอให้ model"
        text: >-
          turn กำลังทำงาน ผู้ให้บริการเป็น Anthropic Geno ส่งคำขอ แล้ว model เริ่ม stream คำตอบกลับมาทีละชิ้น
          การ์ดข้างล่างคือ `messages` ของคำขอจริงไปยัง Anthropic จากการรันอื่นที่ไม่มี error คำขอส่งบทสนทนาทั้งหมดทุกครั้ง
          ดูสองก้อนที่ไฮไลต์ท้ายสุด: `tool_use` คือคำขอ `read` ของ model รอบก่อน และ `tool_result` คือผลที่ Geno ส่งกลับ model ตอบต่อจากตรงนี้
        from: engine
        to: model
        sees:
          kind: payload
          source: docs/results/real-usecases/runs/A20-thai-question/sonnet-1/wire.jsonl#line=5
          select: messages
          collapse: ['[0]', '[1]', '[2]']
          highlight: ['[3].content[0]', '[4].content[0]']

    - id: torn
      lane: model
      beat:
        title: "Stream ขาดกลางคำตอบ"
        text: >-
          ข้อความส่วนแรกขึ้นในแชตแล้ว แต่การเชื่อมต่อปิดก่อนคำตอบจะครบ Geno ประกอบคำตอบจากส่วนที่ได้ไม่ได้
          การ์ดที่สองเป็นการบันทึกที่รัน Geno จริงกับ model จำลองที่ตอบตามบทที่เขียนไว้ก่อน ผ่าน wire แบบ Anthropic
          คำตอบ stream มาเป็น event ทีละชิ้น ชิ้นแรกคือ `message_start` ตามด้วยการเริ่มก้อนข้อความ (`content_block_start`) การ์ดแสดง event สุดท้ายที่มาถึง
          คือชิ้นข้อความ `. It rea` หลังจากนั้นการเชื่อมต่อปิดเรียบร้อย ไม่มี `content_block_stop` ไม่มี `message_delta` ที่บอก
          `stop_reason` และไม่มี `message_stop` ที่บอกว่าคำตอบจบ
        from: model
        to: engine
        sees:
          - { kind: message, from: geno, text: "This file has one function, parseVersion. It rea", streaming: true }
          - kind: payload
            source: packages/docs/src/data/recorded/err-exception-escapes.jsonl#line=5
            select: '[-1]'
            highlight: [data.delta.text]
      do: >-
        ข้อความส่วนแรกของคำตอบ stream มาถึงแผงแล้ว แต่ stream ปิดก่อนคำตอบจะครบ `messageFromEvents` ประกอบคำตอบจาก event ที่ได้ไม่ได้
      ref: "packages/engine/src/wire.ts#\"const message = messageFromEvents(seen);\""
      phase: calling-model

    - id: wire
      lane: loop
      at: gateway
      beat:
        title: "Geno ไม่ลองใหม่ แต่โยน error ต่อ"
        text: >-
          โค้ดของ Geno เองเป็นคนโยน error นี้ตอนพบว่าคำตอบไม่ครบ มันไม่ใช่ error ที่ผู้ให้บริการส่งมา จึงไม่ผ่านตัวแยกชนิด
          (ฟังก์ชันที่อ่าน error ของผู้ให้บริการแล้วตัดสินว่าจะลองใหม่ รอ หรือเลิก) ตัวแยกชนิดมีรูปแบบของ stream ที่ขาดอยู่แล้ว แต่ชนิดของ error และถ้อยคำของ wire เองทำให้รูปแบบนั้นไม่ถูกใช้
        from: engine
        to: engine
      do: >-
        wire โยน `EngineError` "Anthropic ended the answer's stream before the answer was complete"
        error นี้ไม่ใช่ `AnthropicError` จึงไม่ผ่าน `classifyFailure` และถ้อยคำของมันก็ไม่ตรงรูปแบบ "stream ended before message_stop" ใน `TRANSIENT`
        gateway ไม่ลองใหม่ แต่โยนต่อ
      ref: "packages/engine/src/gateway.ts#\"if (!(error instanceof AnthropicError)) throw error;\""

    - id: escapes
      lane: loop
      at: drive
      beat:
        title: "Error หลุดออกจาก loop โดยไม่มีบันทึก"
        text: >-
          ไม่มีอะไรจับ error ระหว่างทาง Geno ไม่ได้บันทึกทั้ง error และคำตอบ ข้อความที่ stream มาแล้วหายจากประวัติ และ
          prompt ของคุณค้างอยู่โดยไม่มีคำตอบ
        from: engine
        to: engine
      do: >-
        exception หลุดออกจาก `callModel` และ `drive` ไม่มี event `error` หรือ `assistant` ถูกบันทึก
        ข้อความที่ stream มาแล้วหายไปจากประวัติ prompt ของผู้ใช้ยังค้างอยู่ใน log โดยไม่มีคำตอบ
      ref: packages/engine/src/drive.ts#callModel
      phase: ending

    - id: cleanup
      lane: loop
      at: agent
      beat:
        title: "Geno เก็บกวาดสิ่งที่เปิดไว้"
        text: >-
          แม้ loop ล้ม Geno ยังปิดทางรับข้อความที่คุณส่งแทรกระหว่าง turn ข้อความที่คุณกด Send now (ปุ่มลูกศรที่ส่งข้อความเข้า engine
          ระหว่าง turn) ถึง engine แล้วแต่ยังไม่ถึง model engine จะรันข้อความนั้นเป็น turn ถัดไป
          มันหยุด subagent (session ลูกที่ model สร้างให้ทำงานย่อย) ที่รันเบื้องหลัง และปิด sandbox ที่ครอบคำสั่ง `bash`
        from: engine
        to: engine
      do: >-
        `finally` ของ `runAgent` ยังทำงาน: ปิดประตู steer (steer ที่ค้างกลายเป็น turn ถัดไป) หยุด subagent เบื้องหลัง
        และปิด sandbox
      ref: "packages/engine/src/agent.ts#\"steers.release(session.id, inbox);\""

    - id: rejected
      lane: server
      at: turns
      beat:
        title: "Engine ตอบด้วยข้อความของ error"
        text: >-
          งานของแชตนี้ในแผง Tasks (แผงที่แสดงงานที่กำลังรันของทุกแชต) จบเป็น failed และ session พร้อมรับ turn ถัดไป
          คำขอที่ VS Code ใช้ส่ง prompt ได้คำตอบเป็น error ที่บอกข้อความจริง และ engine เขียน error ลง log ของ engine
          ซึ่งเปิดดูได้ที่แท็บ "Geno engine" ในแผง Output
        from: engine
        to: panel
      do: >-
        `finally` ของ `runTurn` ปิดงานในแผง Tasks แบบ `failed` และปลด lock ของ session
        handler ของ `session/prompt` ส่ง exception ให้ `promptFailure` ซึ่งเขียนข้อความและ stack ลง stderr ของ engine
        แล้วตอบด้วย `RequestError` รหัส -32603 ที่มีข้อความจริงเป็น message แทน "Internal error" เปล่า ๆ ของ ACP SDK
      ref: packages/engine/src/serve.ts#promptFailure
      emits: [failed]

    - id: caught
      lane: editor
      at: chat
      do: >-
        `prompt()` จับ error แล้วส่ง action `error` ด้วย `error.message` ซึ่งคือข้อความจริงของ error ตามด้วย `turn-end` สถานะ `failed`
      ref: "packages/extension/src/chat/chat.ts#\"this.dispatch({ type: 'error', ...turnErrorOf(error, this.modelName()) });\""
      emits: [error, turn-end]

    - id: shown
      lane: panel
      at: rail
      beat:
        title: "แชตขึ้นแถบ error ที่บอกเหตุผล"
        text: >-
          ข้อความครึ่งเดียวยังค้างในแผงนี้จนกว่าจะ reload แถบ error บอกเหตุผลที่ turn ล้ม ข้อความที่ยังรอคิวในแผง (ยังไม่ได้ส่งเข้า engine)
          กลับไปที่ช่องพิมพ์ เพราะ turn ไม่ได้จบแบบ done แผงจึงไม่ส่งให้เอง ข้อความที่กด Send now ไปแล้วไม่กลับมา engine รันมันเป็น turn ถัดไป ครั้งหน้าที่คุณส่ง model จะเห็นทั้ง prompt เดิมที่ไม่มีคำตอบและข้อความใหม่
        from: panel
        to: you
        end: "turn ล้มเหลวพร้อมบอกเหตุ"
        sees: { kind: notice, text: "Anthropic ended the answer's stream before the answer was complete", tone: error }
      do: >-
        แผงขึ้นแถบ error ท้าย turn ข้อความที่ stream มาแล้วยังค้างอยู่ในแผงนี้จนกว่าจะ reload
        `followupAtTurnEnd` ส่งข้อความที่รอคิวในแผงกลับไปที่ช่องพิมพ์เพราะ turn ไม่ได้จบ `done` ส่วน steer ที่ส่งเข้า engine แล้วคงไว้ตามเดิม
        เพราะ engine รันมันเป็น turn ถัดไป
      sees: >-
        ข้อความครึ่งเดียว แถบ error สีแดงที่บอกว่า stream จบก่อนคำตอบครบ หัวข้อ "failed after 12s" และปุ่ม Send กลับมา
      ref: packages/extension/src/chat/render.ts#errorBlock
      end: { turn: failed, reason: error }
---

ข้อผิดพลาดของผู้ให้บริการผ่าน `classifyFailure` แล้วกลายเป็นการลองใหม่ การรอ หรือ event `error` ที่อธิบายตัวเอง
ดู [ผู้ให้บริการล้มชั่วคราว](/scenarios/err/transient-retried/) แต่ error ชนิดอื่นไม่มีใครจับระหว่าง gateway กับ `runTurn`
มันหลุดออกไปเป็น error ของคำขอ ACP

สิ่งที่ควรสังเกต

- **ผู้ใช้เห็นเหตุผล แต่ log ของ session ไม่มี** `promptFailure` ทำให้ข้อความจริงเป็น message ของ error
  (ACP SDK เองจะตอบ "Internal error" และเก็บข้อความไว้ใน `data.details` ที่ไม่มีใครอ่าน) และเขียนลง log ของ engine
  แต่ log ของ session ยังไม่มี event `error`
- **ตัวจัดประเภทมีรูปแบบของกรณีนี้ แต่ไม่ได้ใช้** `TRANSIENT` ใน `model-error.ts` มีรูปแบบ "stream ended before message_stop" อยู่แล้ว
  แต่ `EngineError` จาก `anthropicWire` ไม่เคยผ่านตัวจัดประเภท และถ้อยคำ "Anthropic ended the answer's stream before the answer was complete"
  ก็ไม่ตรงรูปแบบนั้น แม้ผ่านก็ไม่ถูกนับว่าชั่วคราว turn จึงล้มทันที
- **ที่อื่นที่โยนแบบเดียวกัน** `takeCheckpoint` ที่ git ล้ม (`checkpoint git ... failed`) และการเขียน log ที่ดิสก์เต็ม
  ให้ผลเหมือนกัน: turn จบ failed ไม่มี event `error` และ prompt ค้างอยู่
- **prompt ที่ค้างไปกับข้อความถัดไป** log จบที่ `user` ที่ยังไม่มีคำตอบ ครั้งหน้าที่ผู้ใช้ส่งข้อความ model จะเห็นทั้งสองข้อความ

error ที่ผ่านตัวแยกชนิดได้ทางที่ดีกว่า ดู [ผู้ให้บริการล้มชั่วคราว Geno retry เอง](/scenarios/err/transient-retried/)
