---
title: ผู้ใช้ส่งข้อความถึงลูก
description: ผู้ใช้เปิดบทสนทนาของลูกที่กำลังทำงานแล้วพิมพ์ข้อความในช่องของลูก ข้อความไปถึงลูกที่จุดปลอดภัยถัดไปเป็นคำของผู้ใช้เอง
tableOfContents: false
sidebar:
  order: 8
scenario:
  surface: vscode
  given:
    - turn ของแม่ทำงานอยู่ และมีลูก `explore` แบบเบื้องหลังที่กำลังค้นโค้ด แถวของลูกขึ้น Running ใต้ขั้นของ `agent`
  trigger: >-
    ผู้ใช้คลิกแถวของ explore เพื่อเปิดบทสนทนาของลูก แล้วพิมพ์ข้อความในช่องของลูก
  covers: [sub.user-steers-child]
  related: [sub.message-running-child, ctl.steer-delivered, sub.user-cancels-child]
  steps:
    - id: open
      lane: panel
      at: rail
      do: >-
        คลิกแถวของลูกเปิดมุมมองบทสนทนาของลูกแทนบทสนทนาของแม่ ใต้บทสนทนามีช่องข้อความของลูกตราบที่ลูกยัง Running
      sees: บทสนทนาของ explore และช่อง "Message explore…" พร้อมปุ่ม [Send]
      ref: packages/extension/src/chat/steer-view.ts#childSteer
      phase: running-tools

    - id: type
      lane: user
      do: ผู้ใช้พิมพ์ "skip the generated folder" แล้วกด Send

    - id: post
      lane: panel
      at: rail
      do: >-
        `steerField` โพสต์ข้อความ `steer` ที่มีเป้าหมายเป็นลูก (`kind: 'child'` กับ session id ของลูก) ไปให้ extension host
      sees: ใต้ช่องขึ้น "Sending… it lands at the next tool round"
      ref: packages/extension/src/chat/steer-view.ts#steerField
      emits: [steer]

    - id: request
      lane: editor
      at: chat
      do: >-
        `SteerHost.steerSession` ส่งคำขอ ACP `session/prompt` ไปที่ session id ของลูก พร้อม `_meta` `gcode/steer: true`
        คำขอนี้ไม่เริ่ม turn ใหม่ แต่ขอให้ข้อความเข้า turn ที่รันอยู่
      ref: packages/extension/src/chat/steer-host.ts#SteerHost.steerSession
      emits: [session/prompt, gcode/steer]

    - id: route
      lane: server
      at: turns
      do: >-
        engine เห็น `gcode/steer` จึงส่งให้ `steerRunning`: steer ต้องเป็นข้อความล้วน ไฟล์แนบและ @mention ใช้ไม่ได้
        ข้อความเข้ากล่องของลูกด้วย `from: 'user'` แล้วรอจนลูกรับหรือรู้ว่ารับไม่ได้
      ref: packages/engine/src/steer.ts#steerRunning
      fork:
        ask: ลูกยังทำงานอยู่ตอนข้อความไปถึงไหม
        options:
          - id: running
            label: ยังทำงาน
            then: logged

          - id: finished
            label: จบไปก่อนแล้ว
            steps:
              - lane: server
                at: turns
                do: >-
                  ลูกจบระหว่างที่ผู้ใช้พิมพ์ กล่องของลูกปิดไปแล้ว `steerRunning` จึงตอบ error "the subagent already finished"
                  ข้อความไม่ไปถึงใคร และไม่กลายเป็น turn ใหม่
                ref: packages/engine/src/steer.ts#steerRunning
              - lane: panel
                at: rail
                do: >-
                  `fieldStatus` แปลง error เป็นบรรทัดสถานะใต้ช่อง ช่องพิมพ์ของลูกซ่อนเพราะลูกไม่ Running แล้ว
                sees: "explore already finished"
                ref: packages/extension/src/chat/steer-model.ts#fieldStatus
                end: { turn: continues }

    - id: logged
      lane: child@explore
      at: loop
      do: >-
        ที่จุดปลอดภัยก่อนเรียกโมเดลครั้งถัดไป `deliver()` ของลูกบันทึก event `user` แบบ steer โดยไม่มี `from`
        เพราะเป็นคำของผู้ใช้เอง ลูกที่กำลังรันเครื่องมือรับข้อความหลังเครื่องมือชุดนั้นจบ
      ref: packages/core/src/steer.ts#steerEvent
      emits: [user]

    - id: shown
      lane: server
      at: updates
      do: >-
        `steerUpdate` ส่ง `user_message_chunk` ที่มี `STEER_META` (`from: user`) บน session ของลูก
      ref: packages/engine/src/session-replay.ts#steerUpdate
      emits: [user_message_chunk, STEER_META]

    - id: bubble
      lane: panel
      at: rail
      alongside: true
      do: ข้อความขึ้นในบทสนทนาของลูกตรงที่ลงจริง
      sees: บับเบิล "Sent mid-turn" ที่มีข้อความ "skip the generated folder"
      ref: packages/extension/src/chat/steer-view.ts#steerStep

    - id: answered
      lane: server
      at: turns
      do: >-
        `steerRunning` ได้ผล `delivered` engine ตอบคำขอ `session/prompt` ทันทีด้วย `_meta` `gcode/steer` ที่บอกลำดับ event
      ref: "packages/engine/src/serve.ts#\"if (outcome.kind === 'delivered') return { stopReason: 'end_turn', _meta: { [STEER_META]: outcome } };\""

    - id: status
      lane: panel
      at: rail
      alongside: true
      do: บรรทัดสถานะใต้ช่องเปลี่ยน
      sees: "Delivered at its next tool round"
      ref: packages/extension/src/chat/steer-model.ts#fieldStatus

    - id: reads
      lane: child@explore
      at: model
      do: >-
        ลูกเรียกโมเดลต่อ ข้อความถูกห่อด้วย `userSteerText`: "[Geno] The user sent a new message while you were working: ..."
        ลูกปรับการค้นตาม แม่ไม่รู้เรื่องข้อความนี้จนกว่าจะอ่านรายงานของลูก
      ref: packages/core/src/fence.ts#userSteerText
      emits: [tool_use]
      end: { turn: continues }
---

ข้อความที่ผู้ใช้ส่งถึงลูกต่างจากข้อความที่แม่ส่ง (`message_agent`) ที่ผู้ส่ง:
ของผู้ใช้เป็นคำของผู้ใช้เอง ลูกอ่านเป็น "The user sent a new message" ส่วนของแม่อยู่ในรั้ว `<parent_message>` ที่บอกว่ามันไม่ใช่ผู้ใช้

สิ่งที่ควรสังเกต

- **ช่องของลูกมีเฉพาะตอนลูก Running** หลังลูกจบช่องซ่อน แต่บรรทัดสถานะสุดท้ายยังอยู่จนผู้ใช้พิมพ์ใหม่
- **ข้อความไม่หยุดลูก** ลูกทำเครื่องมือชุดที่รันอยู่จนจบก่อน แล้วจึงอ่านข้อความ
- **ข้อความแบบเดียวกันส่งจากแผง Tasks ได้** ปุ่ม Message บนงานในแผง Tasks ใช้ `steerSession` ทางเดียวกัน
