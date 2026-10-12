---
title: "หยุด turn ของแม่ขณะ subagent ทำงาน"
description: ผู้ใช้กด Stop ขณะลูกแบบรอผลและลูกเบื้องหลังยังทำงาน ลูกทุกตัวหยุด รายงานของลูกเบื้องหลังไม่ถูกส่ง และการปลุกถูกพักจนกว่าผู้ใช้จะพิมพ์ใหม่
tableOfContents: false
sidebar:
  order: 4
scenario:
  surface: vscode
  given:
    - ค่า `agentTool` มีโหมดปัจจุบัน และมี turn ทำงานอยู่
    - ใน turn นี้ model เริ่ม `review` แบบเบื้องหลังไปแล้ว และตอนนี้รอผลจาก `explore` แบบรอผลอยู่
  trigger: >-
    ผู้ใช้กด Stop (หรือ Escape) ในแผงแชต
  covers: [sub.parent-stop-with-children]
  related: [sub.user-cancels-child, bg.child-wakes-parent, ctl.stop-while-tools-run, bg.wake-held-or-paused]
  steps:
    - id: press
      beat:
        title: คุณกด Stop
        text: >-
          ก่อนหน้านี้ model ส่ง `agent` สองครั้ง: `review` แบบ `background: true` ได้ผลกลับทันทีว่าเริ่มแล้ว
          แล้ว `explore` แบบรอผล (การ์ด: บทสนทนาของแม่ตอนนั้น) แถวของ explore ยังหมุนอยู่ และ review ทำงานเบื้องหลัง คุณกด Stop
        from: you
        to: panel
        sees:
          - kind: composer
            state: working
          - kind: payload
            source: packages/docs/src/data/recorded/parent-stop.jsonl#line=10
            select: messages
            collapse: ['[0]', '[4]']
            highlight: ['[1].content[1].input', '[2].content[0]', '[3].content[1].input']
      lane: user
      do: ผู้ใช้กด Stop ขณะแถวของ explore ยังหมุนอยู่ใต้ขั้น `agent`
      phase: running-tools

    - id: post
      lane: panel
      at: composer
      do: >-
        ปุ่ม Stop โพสต์ข้อความ `stop` ไปให้ extension host
      ref: "packages/extension/src/chat/webview.ts#\"stop.addEventListener('click', () => host.postMessage({ type: 'stop' }));\""
      emits: [stop]

    - id: cancel
      beat:
        title: แชตส่งคำขอยกเลิกไปที่ engine
        text: แชตยกเลิกการ์ดและคำถามที่เปิดอยู่ แล้วบอก engine ให้หยุด turn ของแม่
        from: panel
        to: engine
      lane: editor
      at: chat
      do: >-
        `Chat.stop` ตอบการ์ดและคำถามที่เปิดอยู่ว่ายกเลิก แล้วส่ง notification ACP `session/cancel` ด้วย session id ของแม่
      ref: packages/extension/src/chat/chat.ts#Chat.stop
      emits: [session/cancel]

    - id: abort
      beat:
        title: Geno หยุด turn ของแม่
        text: สัญญาณหยุดไหลไปถึงทุกอย่างที่ turn นี้เริ่มไว้
        from: engine
        to: engine
      lane: server
      at: turns
      do: >-
        engine abort `AbortController` ของ turn แม่ใน `turns` signal นี้ไหลไปถึงทุกอย่างที่ turn เริ่มไว้
      ref: "packages/engine/src/serve.ts#\"turns.get(params.sessionId)?.abort();\""

    - id: blocking-stops
      beat:
        title: explore หยุดทันที
        text: explore ผูกกับ call ที่แม่รออยู่ มันจึงหยุดพร้อม turn และจบแบบ cancelled
        from: engine
        to: model
      lane: child@explore
      at: loop
      do: >-
        `runPlaced` ผูก controller ของลูกไว้กับ signal ของ call `agent` ลูกจึงถูก abort ทันที การเรียกที่ค้างอยู่หยุด
        และลูกจบแบบ `cancelled`
      ref: packages/engine/src/subagents.ts#runPlaced
      emits: [cancelled]

    - id: answered
      beat:
        title: Geno ปิด call ที่ค้างแล้วบันทึกการหยุด
        text: >-
          Geno เลิกรอ explore ทันที call `agent` ของ explore ได้คำตอบว่าถูกหยุด แทนรายงาน model เห็นคำตอบนี้ใน request
          ของ turn ถัดไป เป็น `tool_result` ที่มี `is_error: true` และข้อความ "[Request interrupted by user for tool use]"
        from: engine
        to: engine
        sees:
          kind: payload
          source: packages/docs/src/data/recorded/parent-stop.jsonl#line=10
          select: messages[4].content[0]
          highlight: [content]
      lane: loop
      at: tools
      do: >-
        `runTools` เลิกรอชุดนี้ทันที (`unlessAborted`) call `agent` ที่เริ่มแล้วได้คำตอบ `UNRUN_TEXTS.stopped`
        แทนรายงานของลูก แล้ว `drive` บันทึก error ชนิด `abort` พร้อมรายชื่อ call ที่ถูกตัด
        `child-end` ของ explore ตามมาลง log ทีหลัง เมื่อลูกปิดตัวเสร็จ
      ref: packages/core/src/loop.ts#UNRUN_TEXTS
      emits: [abort, child-end]

    - id: done
      lane: loop
      at: step
      do: >-
        `loopStep` เห็น error ชนิด `abort` จึงตัดสิน `done(error)`
      ref: packages/core/src/loop.ts#ERROR_REASON
      emits: [error]
      phase: ending

    - id: background
      beat:
        title: Geno หยุด review ที่ทำงานเบื้องหลัง
        text: >-
          turn ไม่ได้จบเอง Geno จึงหยุดลูกเบื้องหลังทุกตัวด้วย ไม่มีอะไรปลุก session ทีหลัง แต่ review ที่ถูกหยุดยังได้รั้ว
          `<subagent_report agent="review" status="cancelled" partial="true">` ที่มีแค่ "(no report)" และรั้วนี้ติดไปกับ prompt
          ถัดไปของคุณ ต่อจากผลที่ถูกหยุดของ explore
        from: engine
        to: model
        sees:
          kind: payload
          source: packages/docs/src/data/recorded/parent-stop.jsonl#line=10
          select: messages[4]
          highlight: ['content[1].text', 'content[2].text']
      lane: loop
      at: agent
      do: >-
        ใน `finally` ของ `runAgent` turn ไม่ได้จบด้วย `end_turn` จึงเรียก `stopBackground()` แทน `detach()`
        ลูกเบื้องหลังทุกตัวถูก abort และถูกตั้งว่าไม่มีใครฟังรายงานแล้ว จากนั้นรอจนลูกทุกตัวบันทึกการจบ
      ref: "packages/engine/src/agent.ts#\"else children?.stopBackground();\""

    - id: review-stops
      lane: child@review
      at: loop
      do: >-
        review หยุดและจบแบบ `cancelled` `child-end` ถูกบันทึกลง log ของแม่ ไม่มีอะไรปลุก session ภายหลัง
        แต่รั้วรายงานที่ว่างของ review ถูกส่งให้ model พร้อม prompt ถัดไปของผู้ใช้
      ref: "packages/engine/src/subagents.ts#\"const heard = !silent && !unheard;\""
      emits: [child-end]

    - id: response
      beat:
        title: Turn จบแบบ stopped
        text: งานใน Tasks จบแบบ stopped และการปลุกของ session นี้ถูกพักจนกว่าคุณจะพิมพ์ prompt ใหม่
        from: engine
        to: panel
      lane: server
      at: turns
      do: >-
        `runTurn` เห็นว่า signal ถูก abort จึงใช้ `TURN_ENDS.cancelled`: `stopReason: cancelled` งานใน Tasks จบแบบ stopped
        และ error ชนิด `abort` พักการปลุกของ session นี้จนกว่าผู้ใช้จะพิมพ์ prompt ใหม่
        แผง Tasks ขึ้น "Wake-ups paused after Stop" เฉพาะเมื่อ session ยังมีสิ่งที่รอปลุก เช่น monitor หรือ PR watch
        ในทัวร์นี้ review ถูกหยุดไปแล้ว ไม่มีอะไรรอ จึงไม่มีบรรทัดนี้
      ref: packages/core/src/wake.ts#WAKE_PAUSE_TEXT
      emits: [cancelled, Wake-ups paused after Stop]

    - id: ended
      lane: server
      at: updates
      alongside: true
      do: >-
        `acpChildHost.ended` ส่ง `subagent_update` สถานะ `idle` stop reason `cancelled` ของลูกแต่ละตัว
      ref: packages/engine/src/subagent-acp.ts#acpChildHost
      emits: [subagent_update]

    - id: turn-end
      lane: editor
      at: chat
      do: >-
        `turnEndOf` อ่าน `_meta` ได้ `stopped` แล้ว `prompt()` ส่ง action `turn-end`
      ref: "packages/extension/src/chat/chat.ts#\"this.dispatch({ type: 'turn-end', at: Date.now(), status, usage: usageOf(response)\""
      emits: [turn-end]

    - id: footer
      beat:
        title: แชตปิดทุกแถวเป็น Cancelled
        text: ขั้นที่ยังหมุนและแถวของลูกทั้งสองขึ้นว่ายกเลิก turn ไม่มีข้อความตอบ แชตจึงบอกว่าคุณหยุดก่อนได้คำตอบ
        from: panel
        to: you
        sees:
          - kind: composer
            state: idle
            header: stopped after 1m 05s
          - kind: notice
            text: Geno stopped without a reply
            detail: You stopped it before it answered.
            actions:
              - Continue
              - Retry
            tone: warning
        end: คุณหยุด turn
      lane: panel
      at: rail
      do: >-
        `turn-end` ปิดทุกอย่างที่ยังรันอยู่ใน turn: ขั้นที่ยังหมุนเป็น cancelled และลูกที่ยังรันเป็น Cancelled (`endedByParent`)
        turn ไม่มีข้อความตอบและไม่มีแถบ error `missingReply` จึงบอกว่าผู้ใช้หยุดก่อนได้คำตอบ
      sees: >-
        หัวข้อ "stopped after 1m 05s" แถว explore และ review ขึ้นไอคอน cancelled และประกาศ
        "Geno stopped without a reply · You stopped it before it answered." [Continue] [Retry]
      ref: "packages/extension/src/chat/transcript.ts#\"const children = Object.keys(settled.children\""
      end: { turn: stopped, reason: cancelled }
---

Stop ของแม่หยุดทุกอย่างที่ turn เริ่มไว้ ไม่ว่าลูกจะรันแบบรอผลหรือเบื้องหลัง
ต่างจาก [Cancel บนแถวของลูก](/scenarios/sub/user-cancels-child/) ที่หยุดแค่ลูกตัวเดียวแล้วให้แม่ทำต่อ

สิ่งที่ควรสังเกต

- **รายงานบางส่วนของลูกแบบรอผลไม่ถึง model** call `agent` ได้ข้อความว่าผู้ใช้หยุดระหว่างรัน ไม่ใช่รายงานในรั้ว
  สิ่งที่ลูกทำไว้ยังอยู่ใน log ของลูก เปิดดูได้จากแถวของลูก
- **ลูกเบื้องหลังรอดได้เฉพาะ turn ที่จบด้วย `end_turn`** ถ้า model จบ turn เอง ลูกเบื้องหลังทำงานต่อและปลุก session ได้
  ([ลูกเบื้องหลังรายงานแล้วปลุกเซสชัน](/scenarios/bg/child-wakes-parent/)) ทุกการจบแบบอื่นหยุดลูกเบื้องหลังทั้งหมด
- **การปลุกถูกพัก** จนกว่าผู้ใช้จะส่ง prompt ใหม่ ถ้า session ยังมีสิ่งที่รอปลุกอยู่ (monitor, schedule, PR watch)
  แผง Tasks แสดง "Wake-ups paused after Stop" ถ้าไม่มีอะไรรอ ก็ไม่มีบรรทัดนี้
- **Retry หลัง Stop** ส่ง prompt เดิมอีกครั้ง prompt เดิมยังค้างใน log (`abort` เป็นชนิดที่เก็บ prompt ไว้) พร้อมโน้ตว่า turn ก่อนถูกหยุด
