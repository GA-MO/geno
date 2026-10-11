---
title: ปิด session ขณะ turn ทำงาน
description: client ส่ง session/close ถึงแชตที่มี turn ทำงานอยู่ engine หยุด turn นั้นทันทีและถือว่า session ปิด แม้ turn จะเป็นของหน้าต่างอื่น
tableOfContents: false
sidebar:
  order: 9
scenario:
  surface: vscode
  given:
    - เปิดโฟลเดอร์เดียวกันไว้สองหน้าต่าง ทั้งสองต่อ engine ตัวเดียวกัน
    - หน้าต่าง B เริ่ม turn ในแชต X และ turn กำลังรัน `pnpm test`
    - หน้าต่าง A แสดงแชต X อยู่ด้วย แต่แผงของ A ไม่ได้ถือ turn นั้น
  trigger: >-
    ผู้ใช้ในหน้าต่าง A คลิก New Chat (หรือเปิดแชตอื่นจาก History)
  covers: [ctl.session-close-during-turn]
  related: [ctl.stop-while-tools-run, sess.leave-running, turn.prompt-while-running, sess.new-chat]
  steps:
    - id: new-chat
      lane: user
      do: ผู้ใช้ในหน้าต่าง A คลิก New Chat
      phase: running-tools

    - id: move
      lane: editor
      at: chat
      do: >-
        `moveTo` ของหน้าต่าง A เปิด session ใหม่ แล้วปิด session ที่ออกมา แผงของ A ไม่ได้ถือ turn ของแชต X
        (`running` ว่าง) จึงไม่ส่ง detach แต่ส่งคำขอ ACP `session/close` ถึงแชต X เพื่อหยุด MCP server ของมัน
      ref: "packages/extension/src/chat/chat.ts#\"if (left !== undefined && left !== now && running === undefined) void connection.agent.request(acp.methods.agent.session.close\""

    - id: close
      lane: server
      at: sessions
      do: >-
        handler ของ `session/close` ไม่ได้ดูว่าใครเริ่ม turn มัน abort `AbortController` ของแชต X ลบ session ออกจากทะเบียน `turns`
        เลิกส่งอัปเดตให้ผู้ดู ถอดรายการคำสั่ง ปิด agent ภายนอก และปิด MCP server ของ session
      ref: "packages/engine/src/serve.ts#\"turns.get(sessionId)?.abort();\""

    - id: aborted
      lane: loop
      at: tools
      do: >-
        signal เดียวกับที่ Stop ใช้ไปถึง batch ที่รันอยู่ `pnpm test` ได้คำตอบว่าถูกหยุดระหว่างรันและอาจรันไปบางส่วน
        `drive` บันทึก event `error` ชนิด `abort` แล้ว `loopStep` ให้ `done(error)`
      ref: "packages/engine/src/drive.ts#\"error: 'abort', message: 'interrupted by the user', tools: interrupted\""
      emits: [error, abort]
      phase: ending

    - id: stays-closed
      lane: server
      at: turns
      do: >-
        `runTurn` เห็นว่า signal ถูก abort จึงตอบคำขอของหน้าต่าง B ด้วย `stopReason: cancelled` และงานจบแบบ stopped
        `finally` ไม่ใส่แชต X กลับเข้า `turns` เพราะมันถูกลบไปแล้ว session จึงยังปิดอยู่
      ref: "packages/engine/src/serve.ts#\"if (turns.has(sessionId)) turns.set(sessionId, undefined);\""
      emits: [cancelled, stopped]

    - id: turn-end
      lane: editor
      at: chat
      do: >-
        ใน extension host ของหน้าต่าง B คำขอ `session/prompt` ได้คำตอบ `turnEndOf` อ่านได้ `stopped` แล้วส่ง action `turn-end`
      ref: packages/extension/src/chat/chat.ts#turnEndOf
      emits: [turn-end]

    - id: shown
      lane: panel
      at: rail
      do: >-
        แผงของหน้าต่าง B แสดง turn ที่ถูกหยุด เหมือนผู้ใช้ใน B กด Stop เอง ขั้นของคำสั่งล้มเหลวพร้อมข้อความว่าผู้ใช้หยุดมัน
      sees: >-
        หน้าต่าง B ขึ้นหัวข้อ "stopped after 1m 5s" กล่อง "Geno stopped without a reply · You stopped it before it answered."
        และท้าย turn ขึ้น "Stopped by you" ทั้งที่ไม่มีใครใน B กด Stop
      ref: packages/extension/src/chat/rail.ts#missingReply
      end: { turn: stopped, reason: cancelled }
---

`session/close` ใน ACP แปลว่า client เลิกใช้ session engine ของ Geno ทำตามนั้น: หยุด turn ปลดทุกอย่างที่ session ถือ
แต่ log ยังอยู่ และ `session/resume` หรือ `session/load` เปิดมันได้อีก

แผงของ Geno เองส่ง `session/close` เฉพาะตอนย้ายออกจากแชตที่แผงนั้นไม่ได้ถือ turn ถ้าแผงถือ turn อยู่ มันส่ง detach แทน
และ turn ทำงานต่อเบื้องหลัง ดู [สลับออกจากแชตที่ยังทำงาน](/scenarios/sess/leave-running/)
ทางในหน้านี้จึงเกิดเมื่อ turn เป็นของหน้าต่างอื่นหรือ client ACP ตัวอื่น

สิ่งที่ควรสังเกต

- **หน้าต่างหนึ่งหยุด turn ของอีกหน้าต่างได้โดยไม่ตั้งใจ** การคลิก New Chat ในหน้าต่าง A หยุดงานที่หน้าต่าง B สั่ง
  และ B แสดงว่า "Stopped by you"
- **แชต X ยังปิดอยู่สำหรับหน้าต่าง B** หน้าต่าง B ยังจำว่า session ของมันคือ X ข้อความถัดไปที่ B ส่ง `prompt()` ของ engine จะเรียก `known`
  ซึ่งไม่เจอ X ใน `turns` และปฏิเสธด้วย "no session ..." จนกว่า B จะเปิดแชตนั้นใหม่ (ได้จากการอ่านโค้ด ไม่ได้รันจริง)
- **Stop ของ ACP กับ close ต่างกัน** `session/cancel` หยุดแค่ turn session ยังเปิด ส่วน `session/close` หยุด turn และปิด MCP server ด้วย
