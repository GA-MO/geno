---
title: "Model ปฏิเสธที่จะตอบ"
description: model จบคำตอบด้วย stop_reason refusal gateway แปลงเป็น error ชนิด refusal turn จบแบบ failed และ prompt นั้นถูกตัดออกจากคำขอต่อไป
tableOfContents: false
sidebar:
  order: 4
scenario:
  surface: vscode
  given:
    - ผู้ใช้ส่งข้อความในแผงแชตของ VS Code และ turn กำลังเรียก model
  trigger: >-
    ผู้ให้บริการจบคำตอบด้วย `stop_reason: refusal` (หรือ `finish_reason: content_filter` บน wire แบบ OpenAI)
  covers: [mstop.refusal]
  related: [turn.text-answer, mstop.no-reply-continue-retry]
  steps:
    - id: refuse
      lane: model
      beat:
        title: "Model ปฏิเสธที่จะตอบต่อ"
        text: >-
          model ปฏิเสธคำขอนี้ บางครั้งมีคำอธิบายสั้นๆ มาด้วย แล้วจบคำตอบด้วยสัญญาณ refusal
        from: model
        to: engine
      do: >-
        model ปฏิเสธที่จะตอบต่อ บางครั้งมีข้อความอธิบายสั้นๆ หรือ `stop_details.explanation` มาด้วย
        แล้วจบด้วย `stop_reason: refusal`
      ref: "packages/engine/src/gateway.ts#\"if (message.stop_reason === 'refusal') {\""
      emits: [refusal]
      phase: calling-model

    - id: gateway
      lane: loop
      at: gateway
      beat:
        title: "Geno แปลงการปฏิเสธเป็น error"
        text: >-
          Geno ไม่ถือว่านี่เป็นคำตอบ แต่บันทึกเป็น error ชนิด refusal ข้อความที่ model เขียนมาก่อนปฏิเสธจึงไม่อยู่ในบันทึก
        from: engine
        to: engine
      do: >-
        gateway ไม่คืนเป็นคำตอบ แต่คืน error ชนิด `refusal` ข้อความมาจาก `refusalMessage`:
        คำอธิบายของผู้ให้บริการ ถ้าไม่มีก็ข้อความที่ model เขียน ถ้าไม่มีอีกก็ "the model refused"
      ref: packages/engine/src/gateway.ts#refusalMessage

    - id: logged
      lane: loop
      at: drive
      do: >-
        `callModel` บันทึก event `error` ชนิด `refusal` ไม่มี event `assistant` ข้อความที่ stream มาก่อนจึงไม่อยู่ใน log
      ref: "packages/engine/src/drive.ts#\"await record({ kind: 'error', seq: nextSeq(events), at, error: result.error, message: result.message, ...timing });\""
      emits: [error]

    - id: error-update
      lane: server
      at: updates
      beat:
        title: "Geno ส่ง error ไปที่แชต"
        text: >-
          engine ส่ง error ไปพร้อมป้ายว่าเป็น error ของ turn VS Code อ่านป้ายนั้นแล้วบอกแผงให้วาดเป็นบล็อก error
        from: engine
        to: panel
      do: >-
        `errorUpdate` ส่ง error เป็น `agent_message_chunk` ข้อความ `[refusal] ...` พร้อม `TURN_ERROR_META`
      ref: packages/engine/src/session-replay.ts#errorUpdate
      emits: [agent_message_chunk, TURN_ERROR_META]

    - id: error-action
      lane: editor
      at: chat
      alongside: true
      do: >-
        `agentChunkAction` เห็น `TURN_ERROR_META` ที่ไม่ใช่ `abort` จึงส่ง action `error` ให้ webview
      ref: packages/extension/src/chat/compact-host.ts#agentChunkAction

    - id: error-block
      lane: panel
      at: rail
      beat:
        title: "แชตขึ้นบล็อก error สีแดง"
        text: >-
          แผงวาดบล็อก error ด้วยคำอธิบายของผู้ให้บริการ ถ้าไม่มีก็ใช้ข้อความที่ model เขียน ถ้าไม่มีอีกก็ขึ้นข้อความสั้นๆ
          ด้านล่าง
        from: panel
        to: you
        sees: { kind: notice, text: The model refused, tone: error }
      alongside: true
      do: >-
        `errorBlock` วาดบล็อก error สีแดงด้วยข้อความของ refusal ที่ขึ้นต้นด้วยตัวพิมพ์ใหญ่
      sees: บล็อก error ไอคอนสีแดง เช่น "The model refused" เมื่อผู้ให้บริการไม่ได้ให้คำอธิบาย ข้อความ หรือ category มา (มี category จะต่อท้ายในวงเล็บ)
      ref: packages/extension/src/chat/render.ts#errorBlock

    - id: done
      lane: loop
      at: step
      beat:
        title: "Geno จบ turn"
        text: >-
          Geno เห็นว่าเหตุการณ์ล่าสุดคือการปฏิเสธ จึงจบ turn Stop hook ไม่ทำงาน เพราะ model ไม่ได้จบด้วยคำตอบ
        from: engine
        to: engine
      do: >-
        `loopStep` เห็น event ล่าสุดเป็น error `refusal` ตาราง `ERROR_REASON` ให้ `done(refusal)`
        Stop hook ไม่ทำงาน เพราะ model ไม่ได้จบ turn ด้วยคำตอบ
      ref: packages/core/src/loop.ts#ERROR_REASON
      phase: ending

    - id: response
      lane: server
      at: turns
      beat:
        title: "งานใน Tasks จบเป็น failed"
        text: >-
          engine บอก VS Code ว่า turn จบเพราะ model ปฏิเสธ งานในแผง Tasks จบแบบ failed และ session พร้อมรับข้อความถัดไป
        from: engine
        to: panel
      do: >-
        `runTurn` แปลงผลด้วย `TURN_ENDS`: ACP ได้ `stopReason: refusal` meta บอกว่างานจบแบบ `failed`
        งานในแผง Tasks จบแบบ failed แล้วปลด lock ของ session
      ref: packages/engine/src/serve.ts#TURN_ENDS
      emits: [TURN_END_META, failed]

    - id: turn-end
      lane: editor
      at: chat
      do: >-
        `prompt()` ใช้ `turnEndOf` อ่านได้ `failed` ข้อความสำรอง "The model declined to continue." ใน `STOP_MESSAGES` ไม่ถูกเพิ่ม
        เพราะ turn มีบล็อก error ของ engine อยู่แล้ว แล้วส่ง action `turn-end` สถานะ `failed`
      ref: "packages/extension/src/chat/chat.ts#\"const status = turnEndOf(response);\""
      emits: [turn-end]

    - id: shown
      lane: panel
      at: rail
      beat:
        title: "Turn จบโดยไม่มีปุ่ม Continue"
        text: >-
          บล็อก error บอกเหตุผลไว้แล้ว แผงจึงไม่ขึ้นประกาศ "Geno stopped without a reply" และไม่มีปุ่ม Continue หรือ
          Retry prompt ที่ถูกปฏิเสธไม่ถูกส่งซ้ำในคำขอครั้งหน้า คุณต้องพิมพ์ข้อความใหม่เอง
        from: panel
        to: you
        end: "Model ปฏิเสธ turn ล้มเหลว"
        sees: { kind: composer, state: idle }
      do: >-
        `missingReply` เห็นบล็อก error ที่ไม่ใช่ขีดจำกัด จึงไม่แสดงประกาศ "Geno stopped without a reply" และไม่มีปุ่ม Continue หรือ Retry
      sees: หัวข้อ "failed after 4s" บล็อก error ค้างอยู่ และท้าย turn ขึ้น "Failed" ปุ่ม Send กลับมา
      ref: packages/extension/src/chat/rail.ts#missingReply
      end: { turn: failed, reason: refusal }
---

refusal เป็นการหยุดเพียงแบบเดียวของ model ที่ Geno ตัด prompt ทิ้ง
`KEEPS_PENDING_PROMPT.refusal` เป็น `false` เมื่อ `replayMessages` ประกอบคำขอครั้งถัดไป prompt ที่ถูกปฏิเสธจะไม่ถูกส่งซ้ำ
ข้อความถัดไปของผู้ใช้จึงเริ่มใหม่ ไม่ได้ต่อท้าย prompt เดิมเหมือนหลัง Stop หรือหลังชนขีดจำกัด

สิ่งที่ควรสังเกต

- **ข้อความที่ stream มาแล้วหายเมื่อ reload** ถ้า model เขียนอะไรก่อนปฏิเสธ แผงเห็นข้อความนั้นทันที
  แต่ log มีแค่ error `refusal` การเปิดแชตนี้ใหม่จึงเห็นแค่บล็อก error
- **wire แบบ OpenAI ใช้ทางเดียวกัน** `chatStream` แปลง `finish_reason: content_filter` เป็น `refusal`
  ผู้ให้บริการแบบ OpenAI-compatible จึงได้ผลเหมือนกันทุกขั้น
- **ไม่มีปุ่ม Continue หรือ Retry** ประกาศ "Geno stopped without a reply" ไม่แสดงเมื่อ turn มีบล็อก error ที่ไม่ใช่ขีดจำกัด
  ผู้ใช้ต้องพิมพ์ข้อความใหม่เอง

ทางหยุดแบบอื่นของ model ดูตารางใน [Model จบด้วย stop reason ที่ไม่ใช่การตอบหรือเรียก tool](/scenarios/mstop/pause-or-malformed-stop/)
