---
title: "กด Stop ขณะ model กำลังเขียน"
description: ผู้ใช้กด Stop ระหว่างที่คำตอบกำลัง stream engine ตัดคำขอ model บันทึกการหยุด และ turn จบแบบ stopped
tableOfContents: false
sidebar:
  order: 1
scenario:
  surface: vscode
  given:
    - ผู้ใช้ส่งข้อความในแผงแชตของ VS Code และ turn กำลังทำงาน
    - model กำลัง stream คำตอบ ยังไม่มี tool หรือการ์ดขออนุญาตค้างอยู่
  trigger: >-
    ผู้ใช้คลิกปุ่ม Stop (สี่เหลี่ยม) กด Escape หรือรันคำสั่ง "Geno: Stop the Chat Turn"
  covers: [ctl.stop-while-streaming]
  related: [mstop.no-reply-continue-retry, ctl.queued-followup, ctl.stop-while-tools-run, ctl.stop-at-card]
  steps:
    - id: streaming
      lane: model
      beat:
        title: "Model กำลังเขียนคำตอบ"
        text: >-
          ข้อความแต่ละส่วนขึ้นในแชตทันที แต่ Geno ยังไม่บันทึกอะไรลงบันทึกของ session จนกว่าคำตอบจะจบ
        from: model
        to: engine
        sees: { kind: message, from: geno, text: ฟังก์ชันนี้รับวันที่เป็นข้อความ แล้ว, streaming: true }
      do: >-
        model กำลัง stream คำตอบ ข้อความแต่ละส่วนไปถึงแผงทันที แต่ยังไม่มีอะไรถูกบันทึกลง log จนกว่าคำตอบจะจบ
      ref: "packages/engine/src/drive.ts#\"onText: (delta) => watcher.text(delta),\""
      phase: calling-model

    - id: press
      lane: user
      beat:
        title: "คุณกด Stop"
        text: >-
          คุณคลิกปุ่มสี่เหลี่ยม กด Escape หรือรันคำสั่ง "Geno: Stop the Chat Turn" แผงส่งคำสั่งหยุดให้ VS Code
        from: you
        to: panel
        sees: { kind: composer, state: working, header: working }
      do: ผู้ใช้กด Stop

    - id: post
      lane: panel
      at: composer
      do: >-
        ปุ่ม Stop โพสต์ข้อความ `stop` ไปให้ extension host (Escape ทำแบบเดียวกันเมื่อไม่มีแผงย่อยเปิดอยู่)
      ref: "packages/extension/src/chat/webview.ts#\"stop.addEventListener('click', () => host.postMessage({ type: 'stop' }));\""
      emits: [stop]

    - id: cancel
      lane: editor
      at: chat
      beat:
        title: "VS Code ตอบการ์ดที่ค้างแล้วสั่งหยุด"
        text: >-
          ถ้ามีการ์ดขออนุญาตหรือคำถามเปิดอยู่ VS Code ตอบว่ายกเลิกก่อน แล้วสั่ง engine ให้หยุด turn
        from: panel
        to: engine
      do: >-
        `Chat.stop` ตอบการ์ดขออนุญาตและคำถามที่เปิดอยู่ว่า cancelled ก่อน (ACP กำหนดให้ทำ) แล้วส่ง notification ACP `session/cancel`
      ref: packages/extension/src/chat/chat.ts#Chat.stop

    - id: abort
      lane: server
      at: turns
      beat:
        title: "Geno ยกเลิก turn"
        text: >-
          engine ส่งสัญญาณหยุดไปทุกที่ที่ turn กำลังทำงาน ทั้งการเรียก model การรอ การรัน tool และ compaction
        from: engine
        to: engine
      do: >-
        engine หา `AbortController` ของ turn นี้ในทะเบียน `turns` แล้วสั่ง abort (ถ้า session id เป็นของ subagent
        `childCancels` หยุดลูกตัวนั้นแทน) สัญญาณนี้ไปถึง gateway การรอ backoff การรัน tool และ compaction
      ref: "packages/engine/src/serve.ts#\".onNotification(acp.methods.agent.session.cancel, ({ params }) => {\""

    - id: gateway
      lane: loop
      at: gateway
      beat:
        title: "Stream ถูกตัด Geno ไม่ retry"
        text: >-
          การเรียก model ถูกตัดกลางทาง Geno ไม่ลองใหม่ เพราะรู้ว่าคุณเป็นคนหยุด
        from: engine
        to: engine
      do: >-
        stream ถูกตัด SDK โยน `APIUserAbortError` gateway ไม่ลองใหม่ แต่คืนผล `abort` พร้อมข้อความ "interrupted by the user"
      ref: packages/engine/src/gateway.ts#ABORTED
      emits: [abort, interrupted by the user]

    - id: logged
      lane: loop
      at: drive
      beat:
        title: "Geno บันทึกการหยุด"
        text: >-
          Geno บันทึกว่าคุณหยุด turn ข้อความที่ stream มาแล้วไม่ถูกบันทึก เพราะบันทึกเก็บคำตอบเฉพาะตอนที่คำตอบจบ
          แผงไม่ขึ้นแถบ error เพราะปุ่ม Stop บอกอยู่แล้ว
        from: engine
        to: engine
      do: >-
        `callModel` บันทึก event `error` ชนิด `abort` ลง log ข้อความที่ stream มาแล้วไม่ถูกบันทึก เพราะ log เก็บคำตอบเฉพาะตอนที่คำตอบจบ
      ref: "packages/engine/src/drive.ts#\"await record({ kind: 'error', seq: nextSeq(events), at, error: result.error, message: result.message, ...timing });\""
      emits: [error]

    - id: error-update
      lane: server
      at: updates
      do: >-
        `watcher.logged` ล้างข้อความที่ค้างไว้สำหรับ reload แล้ว `errorUpdate` ส่ง error เป็น `agent_message_chunk`
        พร้อม `TURN_ERROR_META`
      ref: packages/engine/src/serve.ts#LOGGED
      emits: [agent_message_chunk, TURN_ERROR_META]

    - id: dropped
      lane: editor
      at: chat
      alongside: true
      do: >-
        `agentChunkAction` เห็นว่าเป็น error ชนิด `abort` จึงทิ้งไป แผงไม่ขึ้นบล็อก error เพราะปุ่ม Stop บอกอยู่แล้ว
      ref: packages/extension/src/chat/compact-host.ts#agentChunkAction

    - id: done
      lane: loop
      at: step
      beat:
        title: "Geno จบ turn แบบ stopped"
        text: >-
          Stop hook ไม่ทำงานในทางนี้ engine บอก VS Code ว่า turn ถูกยกเลิก งานในแผง Tasks จบแบบ stopped
        from: engine
        to: panel
      do: >-
        `loopStep` เห็น event ล่าสุดเป็น error `abort` ตาราง `ERROR_REASON` ให้ `done(error)` Stop hook ไม่ทำงานในทางนี้
        เพราะมันทำงานเฉพาะตอนที่ model จบด้วย `end_turn`
      ref: packages/core/src/loop.ts#ERROR_REASON
      phase: ending

    - id: cancelled
      lane: server
      at: turns
      do: >-
        `runTurn` เห็นว่าสัญญาณถูก abort จึงถือว่า turn จบแบบ `cancelled` ACP ได้ `stopReason: cancelled`
        meta บอกว่างานจบแบบ `stopped` งานในแผง Tasks จบแบบ stopped แล้วปลด lock ของ session
      ref: "packages/engine/src/serve.ts#\"const end: TurnEnd = controller.signal.aborted ? 'cancelled' : ran.reason;\""
      emits: [cancelled, stopped]

    - id: turn-end
      lane: editor
      at: chat
      do: >-
        คำขอ `session/prompt` ได้คำตอบ แล้ว `prompt()` ใช้ `turnEndOf` อ่านได้ `stopped` stop reason `cancelled` ไม่มีข้อความเพิ่ม
        จึงส่ง action `turn-end` สถานะ `stopped` อย่างเดียว
      ref: "packages/extension/src/chat/chat.ts#\"const status = turnEndOf(response);\""
      emits: [turn-end]

    - id: shown
      lane: panel
      at: rail
      beat:
        title: "แชตเก็บกวาด turn ที่หยุด"
        text: >-
          tool ที่ยังหมุนเปลี่ยนเป็น cancelled การ์ดที่ค้างเปลี่ยนเป็น Cancelled และข้อความในคิวกลับไปที่ช่องพิมพ์
          แผงดูว่ามีข้อความตอบอยู่ไหม
        from: panel
        to: panel
        ask: "เขียนไปแล้วไหม"
      do: >-
        reducer ของ `turn-end` เปลี่ยน tool ที่ยังหมุนเป็น cancelled และการ์ดที่เปิดค้างเป็น Cancelled
        ข้อความที่รออยู่ในคิวกลับไปที่ช่องพิมพ์ แล้ว `missingReply` ดูว่ามีข้อความตอบหลังขั้นสุดท้ายหรือไม่
      ref: packages/extension/src/chat/rail.ts#missingReply
      fork:
        ask: model เขียนข้อความออกมาแล้วหรือยังตอนที่ผู้ใช้กด Stop
        options:
          - id: had-text
            label: เขียนไปบางส่วนแล้ว
            steps:
              - lane: panel
                at: rail
                beat:
                  title: "ข้อความครึ่งเดียวค้างในแชต"
                  text: >-
                    ข้อความที่ขึ้นมาแล้วยังอยู่ในแผง แต่ไม่อยู่ในบันทึก reload แล้วจะหายไป และ model ก็ไม่เห็นมันในคำขอถัดไป
                  from: panel
                  to: you
                  end: "คุณหยุด ข้อความค้างครึ่ง"
                  sees: { kind: message, from: geno, text: ฟังก์ชันนี้รับวันที่เป็นข้อความ แล้ว, footer: [ stopped after 6.2s, Stopped by you ] }
                do: >-
                  ข้อความที่ stream มาแล้วยังอยู่ในแผง จึงไม่มีประกาศ "stopped without a reply"
                  แต่ข้อความนี้ไม่อยู่ใน log การ reload หรือเปิดแชตนี้ใหม่จะไม่เห็นมัน และ model ก็ไม่เห็นมันในคำขอถัดไป
                sees: >-
                  ข้อความครึ่งเดียวค้างอยู่ หัวข้อเป็น "stopped after 6.2s" ท้าย turn ขึ้น "Stopped by you" และปุ่ม Send กลับมา
                ref: packages/extension/src/chat/render.ts#turnFooter
                end: { turn: stopped, reason: cancelled }
          - id: no-text
            label: ยังไม่ได้เขียนอะไร
            steps:
              - lane: panel
                at: rail
                beat:
                  title: "แชตขึ้นว่าคุณหยุดก่อน Geno ตอบ"
                  text: >-
                    ไม่มีข้อความตอบและไม่มีแถบ error แผงจึงขึ้นประกาศพร้อมปุ่มให้ทำต่อหรือลองใหม่
                  from: panel
                  to: you
                  end: "คุณหยุดก่อนได้คำตอบ"
                  sees: { kind: notice, text: Geno stopped without a reply, detail: You stopped it before it answered., actions: [ Continue, Retry ], tone: warning }
                do: >-
                  ไม่มีข้อความหลังขั้นสุดท้าย และไม่มีบล็อก error `missingReply` จึงให้เหตุผลว่าผู้ใช้หยุดก่อน Geno ตอบ
                  turn ล่าสุดที่ไม่มีข้อความรอในคิวได้ปุ่ม Continue และ Retry
                sees: >-
                  "Geno stopped without a reply · You stopped it before it answered." พร้อมปุ่ม [Continue] [Retry]
                  ท้าย turn ขึ้น "Stopped by you"
                ref: packages/extension/src/chat/render.ts#noReplyNotice
                end: { turn: stopped, reason: cancelled }
---

Stop เดินทางเป็นสายเดียวจากแผงถึงคำขอ model: ข้อความ `stop` ในแผง, notification ACP `session/cancel`,
`AbortController` ของ turn ในเซิร์ฟเวอร์ engine แล้วจึงถึง stream ของผู้ให้บริการ
ทุกจุดที่ turn อาจรออยู่ฟังสัญญาณเดียวกัน Stop จึงใช้ได้ทั้งตอน stream ตอนรอ retry และตอนรัน tool

สิ่งที่ควรสังเกต

- **ข้อความครึ่งเดียวไม่ถูกเก็บ** log บันทึกคำตอบของ model เป็น event `assistant` ตอนที่คำตอบจบเท่านั้น
  เมื่อหยุดกลางทาง log มีแค่ error `abort` แผงที่เห็นข้อความอยู่จะยังเห็น แต่ model และการ reload ไม่เห็น
- **prompt ที่ยังไม่ได้คำตอบยังค้างอยู่** error `abort` ไม่ลบ prompt ออกจากคำขอถัดไป ข้อความถัดไปของผู้ใช้จึงไปพร้อม prompt เดิม
  และมีโน้ตบอก model ว่าผู้ใช้หยุด turn ที่แล้ว ดู [Turn จบโดยไม่มีคำตอบ แล้วคุณกด Continue หรือ Retry](/scenarios/mstop/no-reply-continue-retry/)
- **ไม่มีบล็อก error ในแผง** engine ส่ง error `abort` มาเหมือน error อื่น แต่ฝั่ง extension ทิ้งมันไป
  ป้าย "Stopped by you" ท้าย turn ทำหน้าที่บอกแทน

ปุ่ม Continue และ Retry ทำอะไรต่อ ดู [Turn จบโดยไม่มีคำตอบ แล้วคุณกด Continue หรือ Retry](/scenarios/mstop/no-reply-continue-retry/)
