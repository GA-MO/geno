---
title: "พิมพ์ข้อความถึง subagent โดยตรง"
description: ผู้ใช้เปิดบทสนทนาของลูกที่กำลังทำงานแล้วพิมพ์ข้อความในช่องของลูก ข้อความไปถึงลูกที่จุดปลอดภัยถัดไปเป็นคำของผู้ใช้เอง
scenario:
  surface: vscode
  given:
    - turn ของแม่ทำงานอยู่ และรอลูก `explore` ที่กำลังค้นโค้ด แถวของลูกขึ้น Running ใต้ขั้นของ `agent`
  trigger: >-
    ผู้ใช้คลิกแถวของ explore เพื่อเปิดบทสนทนาของลูก แล้วพิมพ์ข้อความในช่องของลูก
  covers: [sub.user-steers-child]
  related: [sub.message-running-child, ctl.steer-delivered, sub.user-cancels-child]
  steps:
    - id: open
      beat:
        title: คุณเปิดบทสนทนาของ explore
        text: >-
          explore คือ subagent (session ลูกที่ค้นโค้ดแล้วส่งรายงานกลับ) ที่ model ของแม่ (session หลักที่คุณคุยอยู่)
          เริ่มไว้และรอรายงานของมัน คลิกแถวของ explore แชตแสดงบทสนทนาของมันแทนของแม่
          ใต้บทสนทนามีช่องข้อความของ explore ตราบที่มันยังทำงาน
        from: you
        to: panel
        sees: บทสนทนาของ explore และช่อง "Message explore…" พร้อมปุ่ม [Send]
      lane: panel
      at: rail
      do: >-
        คลิกแถวของลูกเปิดมุมมองบทสนทนาของลูกแทนบทสนทนาของแม่ ใต้บทสนทนามีช่องข้อความของลูกตราบที่ลูกยัง Running
      sees: บทสนทนาของ explore และช่อง "Message explore…" พร้อมปุ่ม [Send]
      ref: packages/extension/src/chat/steer-view.ts#childSteer
      phase: running-tools

    - id: type
      beat:
        title: คุณพิมพ์ “Skip src/update.ts.”
        text: >-
          คุณกด Send ใต้ช่องขึ้นว่ากำลังส่ง ซึ่งบอกว่าข้อความจะลงที่รอบ tool ถัดไปถ้า explore ยังทำงาน
          คือหลัง tool ที่ explore รันอยู่จบ และก่อนมันเรียก model ครั้งถัดไป
        from: you
        to: panel
        sees: Sending… it lands at the next tool round
      lane: user
      do: ผู้ใช้พิมพ์ "Skip src/update.ts." แล้วกด Send

    - id: post
      lane: panel
      at: rail
      do: >-
        `steerField` โพสต์ข้อความ `steer` ที่มีเป้าหมายเป็นลูก (`kind: 'child'` กับ session id ของลูก) ไปให้ extension host
      sees: ใต้ช่องขึ้น "Sending… it lands at the next tool round"
      ref: packages/extension/src/chat/steer-view.ts#steerField
      emits: [steer]

    - id: request
      beat:
        title: แชตส่งข้อความไปที่ session ของ explore
        text: คำขอนี้ไม่เริ่ม turn ใหม่ มันขอให้ข้อความเข้า turn ที่ explore รันอยู่
        from: panel
        to: engine
      lane: editor
      at: chat
      do: >-
        `SteerHost.steerSession` ส่งคำขอ ACP `session/prompt` ไปที่ session id ของลูก พร้อม `_meta` `gcode/steer: true`
        คำขอนี้ไม่เริ่ม turn ใหม่ แต่ขอให้ข้อความเข้า turn ที่รันอยู่
      ref: packages/extension/src/chat/steer-host.ts#SteerHost.steerSession
      emits: [session/prompt, gcode/steer]

    - id: route
      beat:
        title: Geno ส่งข้อความไปที่กล่องของ explore
        text: >-
          ข้อความต้องเป็นข้อความล้วน แนบไฟล์หรือ @mention ไม่ได้ กล่องข้อความของ explore คือคิวข้อความที่รอส่งให้มัน
          ถ้ากล่องยังเปิด Geno ใส่ข้อความไว้ แล้วรอจนรู้ว่า explore รับหรือรับไม่ได้
        from: engine
        to: engine
        ask: explore ยังทำงานไหม
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
                beat:
                  title: explore จบไปก่อนแล้ว
                  text: explore จบระหว่างที่คุณพิมพ์ Geno ตอบ error ข้อความไม่ไปถึงใคร และไม่กลายเป็น turn ใหม่
                  from: engine
                  to: panel
                at: turns
                do: >-
                  ลูกจบระหว่างที่ผู้ใช้พิมพ์ กล่องของลูกปิดไปแล้ว `steerRunning` จึงตอบ error "the subagent already finished"
                  ข้อความไม่ไปถึงใคร และไม่กลายเป็น turn ใหม่
                ref: packages/engine/src/steer.ts#steerRunning
              - lane: panel
                beat:
                  title: แชตบอกว่า explore จบแล้ว
                  text: บรรทัดสถานะใต้ช่องบอกเหตุ และช่องพิมพ์ซ่อนไป
                  from: panel
                  to: you
                  sees: explore already finished
                  end: ข้อความไม่ถึงใคร
                at: rail
                do: >-
                  `fieldStatus` แปลง error เป็นบรรทัดสถานะใต้ช่อง ช่องพิมพ์ของลูกซ่อนเพราะลูกไม่ Running แล้ว
                sees: "explore already finished"
                ref: packages/extension/src/chat/steer-model.ts#fieldStatus
                end: { turn: continues }

    - id: logged
      beat:
        title: explore รับข้อความที่จุดปลอดภัย
        text: >-
          ก่อนเรียก model ครั้งถัดไป explore บันทึกข้อความเป็นคำของคุณเอง ถ้ามันกำลังรัน tool ข้อความรอจน tool ชุดนั้นจบ
          ใน request ถัดไปของ explore ข้อความต่อท้ายผลของ `grep` เป็นโน้ต "[Geno] The user sent a new message while you were working"
          แท็บแรกไฮไลต์โน้ตนี้ มันไม่อยู่ในรั้ว (แท็กที่ห่อข้อความไว้ว่าเป็นข้อมูล) ต่างจากข้อความที่แม่ส่งด้วย `message_agent`
          ซึ่งอยู่ในรั้ว `<parent_message>` (แท็บสอง จากอีก flow หนึ่ง)
        from: engine
        to: model
        sees:
          - kind: payload
            source: packages/docs/src/data/recorded/user-steers-child.jsonl#line=6
            select: messages[2]
            highlight: ['content[1].text']
          - kind: payload
            source: packages/docs/src/data/recorded/background-steer.jsonl#line=10
            quote: "<parent_message>"
            select: messages[2]
            highlight: ['content[1].text']
      lane: child@explore
      at: loop
      do: >-
        ที่จุดปลอดภัยก่อนเรียก model ครั้งถัดไป `deliver()` ของลูกบันทึก event `user` แบบ steer โดยไม่มี `from`
        เพราะเป็นคำของผู้ใช้เอง ลูกที่กำลังรัน tool รับข้อความหลัง tool ชุดนั้นจบ
      ref: packages/core/src/steer.ts#steerEvent
      emits: [user]

    - id: shown
      beat:
        title: ข้อความขึ้นในบทสนทนาของ explore
        text: ข้อความขึ้นตรงที่ลงจริง พร้อมป้ายว่าส่งระหว่าง turn
        from: panel
        to: you
        sees: บับเบิล "Sent mid-turn" ที่มีข้อความ "Skip src/update.ts."
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
      sees: บับเบิล "Sent mid-turn" ที่มีข้อความ "Skip src/update.ts."
      ref: packages/extension/src/chat/steer-view.ts#steerStep

    - id: answered
      beat:
        title: แชตบอกว่าข้อความถึงแล้ว
        text: engine ตอบคำขอทันทีที่ explore รับข้อความ บรรทัดสถานะใต้ช่องเปลี่ยน
        from: panel
        to: you
        sees: Delivered at its next tool round
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
      beat:
        title: explore ปรับการค้นตามคุณ
        text: >-
          explore อ่านว่าคุณส่งข้อความใหม่ระหว่างทำงาน แล้วข้ามไฟล์นั้น แม่ไม่รู้เรื่องนี้จนกว่าจะอ่านรายงานของ explore
          แม่รอ explore อยู่ รายงานจึงกลับไปเป็นผลของ call `agent` ในรั้วตามปกติ การ์ดไฮไลต์ `content` ของผลนั้น: รายงานในรั้ว `<subagent_report>` บอกว่า explore ข้าม `src/update.ts` ตามที่คุณขอ
        from: model
        to: engine
        sees:
          kind: payload
          source: packages/docs/src/data/recorded/user-steers-child.jsonl#line=8
          quote: "I skipped src/update.ts, as you asked."
          select: messages[2].content[0]
          highlight: [content]
        end: explore ทำต่อ
      lane: child@explore
      at: model
      do: >-
        ลูกเรียก model ต่อ ข้อความถูกห่อด้วย `userSteerText`: "[Geno] The user sent a new message while you were working: ..."
        ลูกปรับการค้นตาม แม่ไม่รู้เรื่องข้อความนี้จนกว่าจะอ่านรายงานของลูก
      ref: packages/core/src/fence.ts#userSteerText
      emits: [tool_use]
      end: { turn: continues }
---

ข้อความที่ผู้ใช้ส่งถึงลูกต่างจากข้อความที่แม่ส่ง (`message_agent`) ที่ผู้ส่ง:
ของผู้ใช้เป็นคำของผู้ใช้เอง ลูกอ่านเป็น "The user sent a new message" ส่วนของแม่อยู่ในรั้ว `<parent_message>` ที่บอกว่ามันไม่ใช่ผู้ใช้

สิ่งที่ควรสังเกต

- **ช่องของลูกมีเฉพาะตอนลูก Running** หลังลูกจบช่องซ่อน แต่บรรทัดสถานะสุดท้ายยังอยู่จนผู้ใช้พิมพ์ใหม่
- **ข้อความไม่หยุดลูก** ลูกทำ tool ชุดที่รันอยู่จนจบก่อน แล้วจึงอ่านข้อความ
- **ลูกเบื้องหลังรับข้อความได้เหมือนกัน** ถ้าแม่เริ่ม explore แบบเบื้องหลัง (ไม่รอมัน) ข้อความถึงลูกแบบเดียวกัน
  แต่รายงานไม่กลับเป็นผลของ call `agent` มันมาทีหลังเป็นข้อความจาก Geno ดู [ส่งข้อความถึง subagent ที่กำลังทำงานหรือจบแล้ว](/scenarios/sub/message-child/)
- **ข้อความแบบเดียวกันส่งจากแผง Tasks ได้** ปุ่ม Message บนงานในแผง Tasks ใช้ `steerSession` ทางเดียวกัน
