---
title: "กด Stop ขณะ tool ทำงาน"
description: ผู้ใช้กด Stop ระหว่างที่คำสั่งใน batch กำลังรัน engine ฆ่า process group ของคำสั่ง ตอบ call ที่ค้างว่าถูกหยุด แล้ว turn จบแบบ stopped
scenario:
  surface: vscode
  given:
    - turn กำลังทำงาน model ขอเรียก `bash` ด้วย `pnpm test` ตามด้วย `read` ของ `src/date.ts` ใน turn เดียวกัน
    - "`pnpm test` ผ่านการตรวจสิทธิ์แล้วและกำลังรันอยู่ในชุดของตัวเอง `read` รออยู่ในชุดถัดไป"
  trigger: >-
    ผู้ใช้คลิกปุ่ม Stop กด Escape หรือรันคำสั่ง "Geno: Stop the Chat Turn" ขณะที่ `pnpm test` ยังไม่จบ
  covers: [ctl.stop-while-tools-run]
  related: [ctl.stop-while-streaming, ctl.stop-at-card, mstop.no-reply-continue-retry, tool.mixed-batch-sequencing]
  steps:
    - id: running
      lane: tool
      at: shell
      beat:
        title: "pnpm test รันอยู่บนเครื่องของคุณ"
        text: >-
          model ขอรัน `pnpm test` แล้วอ่าน `src/date.ts` คำสั่งผ่านการตรวจสิทธิ์แล้วและรันอยู่ในกลุ่ม process ของตัวเอง
          ส่วนการอ่านไฟล์รออยู่ในชุดถัดไป
        from: engine
        to: machine
        sees: { kind: step, label: pnpm test, status: running }
      do: >-
        `runShell` รัน `pnpm test` ด้วย `/bin/sh` ใน process group ของตัวเอง และฟังสัญญาณ abort ของ turn ไว้
      ref: packages/engine/src/process.ts#runShell
      phase: running-tools

    - id: press
      lane: user
      beat:
        title: "คุณกด Stop"
        text: >-
          คุณคลิก Stop กด Escape หรือรันคำสั่ง "Geno: Stop the Chat Turn" ขณะ `pnpm test` ยังไม่จบ
        from: you
        to: panel
      do: ผู้ใช้กด Stop

    - id: post
      lane: panel
      at: composer
      do: >-
        ปุ่ม Stop โพสต์ข้อความ `stop` ไปให้ extension host
      ref: "packages/extension/src/chat/webview.ts#\"stop.addEventListener('click', () => host.postMessage({ type: 'stop' }));\""
      emits: [stop]

    - id: cancel
      lane: editor
      at: chat
      beat:
        title: "VS Code สั่ง engine หยุด"
        text: >-
          รอบนี้ไม่มีการ์ดเปิดอยู่ VS Code จึงสั่ง engine ให้หยุด turn ทันที
        from: panel
        to: engine
      do: >-
        `Chat.stop` ตอบการ์ดที่เปิดอยู่ว่า cancelled (รอบนี้ไม่มี) แล้วส่ง notification ACP `session/cancel`
      ref: packages/extension/src/chat/chat.ts#Chat.stop

    - id: abort
      lane: server
      at: turns
      beat:
        title: "Geno ยกเลิก turn"
        text: >-
          engine ส่งสัญญาณหยุด สัญญาณเดียวกันนี้อยู่ในทุก tool ที่กำลังรัน
        from: engine
        to: engine
      do: >-
        engine หา `AbortController` ของ turn ใน `turns` แล้วสั่ง abort สัญญาณเดียวกันนี้อยู่ใน `ctx.signal` ของทุก tool
      ref: "packages/engine/src/serve.ts#\".onNotification(acp.methods.agent.session.cancel, ({ params }) => {\""

    - id: race
      lane: loop
      at: tools
      beat:
        title: "Geno เลิกรอทั้งชุดทันที"
        text: >-
          Geno ไม่รอให้ tool หยุดเสร็จก่อน มันเลิกรอชุดนี้ทันทีที่ได้สัญญาณ
        from: engine
        to: engine
      do: >-
        `runTools` รอทั้ง batch ผ่าน `unlessAborted` ซึ่งจบทันทีที่สัญญาณถูก abort โดยไม่รอให้ tool หยุดเสร็จ
      ref: packages/engine/src/drive.ts#unlessAborted

    - id: kill
      lane: tool
      at: shell
      beat:
        title: "Geno ฆ่า process ของ pnpm test ทั้งกลุ่ม"
        text: >-
          ทุกอย่างที่ `pnpm test` เปิดไว้ถูกฆ่าไปด้วย ไม่มี process ลูกค้างอยู่บนเครื่องของคุณ
        from: engine
        to: machine
      alongside: true
      do: >-
        ตัวฟัง abort ของ `runShell` ส่ง `SIGKILL` ให้ทั้ง process group ทุกอย่างที่ `pnpm test` เปิดไว้ถูกฆ่าด้วย
      ref: "packages/engine/src/process.ts#\"so a timeout or abort kills everything it started\""

    - id: answered
      lane: loop
      at: tools
      beat:
        title: "Geno ตอบทุก call ที่ค้างว่าถูกหยุด"
        text: >-
          call ที่เริ่มแล้วได้คำตอบว่าคุณหยุดมันระหว่างรันและอาจรันไปบางส่วน
          การอ่านไฟล์ที่ยังไม่เริ่มได้คำตอบว่ามันไม่ได้รัน Geno บันทึกทุกคำตอบไว้ รอบหน้าจึงไม่รัน call เหล่านี้ซ้ำ
        from: engine
        to: model
      do: >-
        call ที่จบแล้วเก็บผลจริงไว้ call ที่เริ่มแล้วแต่ไม่จบได้คำตอบ `UNRUN_TEXTS.stopped` ("...may have partly run.")
        ส่วน `read` ที่ยังไม่เริ่มขึ้นเป็นขั้นรอในแผงก่อน แล้วได้คำตอบ `UNRUN_TEXTS['not-started']` ("...so it did not run.")
        ทุกคำตอบถูกบันทึกเป็น `tool-result` สถานะ `error` รอบถัดไปจึงไม่รัน call เหล่านี้ซ้ำ
      ref: packages/core/src/loop.ts#stoppedAnswers
      emits: [tool-result]

    - id: update
      lane: server
      at: updates
      do: >-
        `toolResultUpdate` ส่งแต่ละผลเป็น `tool_call_update` สถานะ `failed` พร้อมข้อความคำตอบ
      ref: packages/engine/src/session-replay.ts#toolResultUpdate
      emits: [tool_call_update, failed]

    - id: shown
      lane: panel
      at: rail
      beat:
        title: "แชตขึ้นสองขั้นที่ล้มเหลว"
        text: >-
          ขั้นของ `pnpm test` และการอ่านไฟล์หยุดหมุนและขึ้นเครื่องหมายล้มเหลว ผลที่พับไว้คือข้อความว่าคุณหยุด
        from: panel
        to: you
        sees: { kind: step, label: pnpm test, status: failed, output: "[Request interrupted by user for tool use] The user stopped this call while it ran, so it may have partly run." }
      alongside: true
      do: >-
        ขั้นของ `pnpm test` และ `read` หยุดหมุนและขึ้นเครื่องหมายล้มเหลว ผลที่พับไว้คือข้อความว่าผู้ใช้หยุด
      sees: >-
        ขั้น "pnpm test" และ "read date.ts" ขึ้นไอคอน error ของขั้นที่ล้มเหลว เปิดดูได้ข้อความ
        "[Request interrupted by user for tool use] The user stopped this call while it ran, so it may have partly run."
      ref: packages/extension/src/chat/session-updates.ts#updateActions

    - id: abort-logged
      lane: loop
      at: drive
      beat:
        title: "Geno บันทึกการหยุดแล้วจบ turn"
        text: >-
          Geno บันทึกการหยุดพร้อมรายการ tool ที่ถูกตัด เวลาเริ่ม และเวลาหยุด แผงไม่ขึ้นแถบ error Geno จบ turn และ Stop
          hook ไม่ทำงาน
        from: engine
        to: engine
      do: >-
        `drive` บันทึก event `error` ชนิด `abort` ที่มีรายการ tool ที่ถูกตัดพร้อมเวลาเริ่มและเวลาหยุด
      ref: "packages/engine/src/drive.ts#\"error: 'abort', message: 'interrupted by the user', tools: interrupted\""
      emits: [error, abort]

    - id: error-update
      lane: server
      at: updates
      do: >-
        `errorUpdate` ส่ง error เป็น `agent_message_chunk` พร้อม `TURN_ERROR_META`
      ref: packages/engine/src/session-replay.ts#errorUpdate
      emits: [agent_message_chunk, TURN_ERROR_META]

    - id: dropped
      lane: editor
      at: chat
      alongside: true
      do: >-
        `agentChunkAction` ทิ้ง error ชนิด `abort` แผงไม่ขึ้นบล็อก error
      ref: packages/extension/src/chat/compact-host.ts#agentChunkAction

    - id: done
      lane: loop
      at: step
      do: >-
        `loopStep` เห็น event ล่าสุดเป็น error `abort` จึงได้ `done(error)` Stop hook ไม่ทำงาน
      ref: packages/core/src/loop.ts#ERROR_REASON
      phase: ending

    - id: cancelled
      lane: server
      at: turns
      beat:
        title: "Engine ตอบว่า turn ถูกยกเลิก"
        text: >-
          engine บอก VS Code ว่า turn จบแบบ stopped VS Code ส่งต่อให้แผง
        from: engine
        to: panel
      do: >-
        `runTurn` เห็นสัญญาณถูก abort จึงถือว่าจบแบบ `cancelled` ACP ได้ `stopReason: cancelled` meta บอก `stopped`
      ref: "packages/engine/src/serve.ts#\"const end: TurnEnd = controller.signal.aborted ? 'cancelled' : ran.reason;\""
      emits: [cancelled, stopped]

    - id: turn-end
      lane: editor
      at: chat
      do: >-
        `prompt()` ใช้ `turnEndOf` อ่านได้ `stopped` แล้วส่ง action `turn-end` สถานะ `stopped`
      ref: "packages/extension/src/chat/chat.ts#\"const status = turnEndOf(response);\""
      emits: [turn-end]

    - id: notice
      lane: panel
      at: rail
      beat:
        title: "แชตขึ้นว่าคุณเป็นคนหยุด"
        text: >-
          ไม่มีข้อความหลังขั้นสุดท้ายและไม่มีแถบ error แผงจึงขึ้นประกาศพร้อมปุ่ม Continue และ Retry
        from: panel
        to: you
        end: "คุณหยุด tool ถูกฆ่า"
        sees: { kind: notice, text: Geno stopped without a reply, detail: You stopped it before it answered., actions: [ Continue, Retry ], tone: warning }
      do: >-
        `missingReply` เห็นว่าไม่มีข้อความหลังขั้นสุดท้าย ไม่มีบล็อก error และ turn ถูกหยุด จึงแสดงประกาศพร้อม Continue และ Retry
      sees: >-
        หัวข้อ "stopped after 21s" กล่อง "Geno stopped without a reply · You stopped it before it answered."
        ปุ่ม [Continue] [Retry] และท้าย turn ขึ้น "Stopped by you"
      ref: packages/extension/src/chat/rail.ts#missingReply
      end: { turn: stopped, reason: cancelled }
---

Stop ระหว่างรัน tool ใช้สัญญาณเดียวกับ Stop ระหว่าง model เขียน ต่างกันที่ปลายทาง:
สัญญาณไปถึง `unlessAborted` ของ batch และ `ctx.signal` ของ tool แต่ละตัว

สิ่งที่ควรสังเกต

- **loop ไม่รอให้ tool หยุด** `unlessAborted` จบทันทีที่ abort แม้ tool ยังทำงานอยู่
  tool แต่ละตัวต้องฟัง `ctx.signal` เอง `bash` ฟัง และฆ่าทั้ง process group
- **ทุก call ของ turn ได้คำตอบ** log ไม่มี `tool_use` ที่ค้างโดยไม่มีผล ข้อความถัดไปของผู้ใช้จึงไม่ทำให้ call เก่ารันอีก
  และ model รู้จากคำตอบว่า call ไหนอาจรันไปบางส่วน call ไหนไม่ได้รันเลย
- **ขั้นที่ถูกหยุดขึ้นเป็นล้มเหลว** engine ส่งคำตอบของ call ที่ถูกหยุดเป็น `tool_call_update` สถานะ `failed`
  ก่อนที่ `turn-end` จะเปลี่ยนขั้นที่ยังหมุนเป็น cancelled ขั้นเหล่านี้จึงขึ้นไอคอน error แบบเดียวกับคำสั่งที่ล้มเหลวจริง
  ความต่างอยู่ในข้อความผลที่พับไว้

ปุ่ม Continue และ Retry ทำอะไรต่อ ดู [Turn จบโดยไม่มีคำตอบ แล้วคุณกด Continue หรือ Retry](/scenarios/mstop/no-reply-continue-retry/)
