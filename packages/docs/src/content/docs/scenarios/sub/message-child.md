---
title: "ส่งข้อความถึง subagent ที่กำลังทำงานหรือจบแล้ว"
description: แม่ใช้ message_agent ส่งข้อความถึงลูกที่เริ่มไว้ ลูกที่ยังทำงานได้ข้อความที่จุดปลอดภัยถัดไป ลูกที่จบแล้วถูกปลุกให้ทำต่อจาก transcript ของตัวเอง
scenario:
  surface: vscode
  given:
    - ค่า `agentTool` มีโหมดปัจจุบัน model จึงมีทั้ง `agent` และ `message_agent`
    - ใน turn นี้ model เริ่ม `explore` แบบเบื้องหลังไว้แล้ว ได้ session id ของลูกจากผลของ call `agent`
  trigger: >-
    ผู้ใช้บอกว่าไม่ต้องดูไฟล์เทสต์ model จึงส่งข้อความถึง explore
  covers: [sub.message-running-child, sub.message-finished-resume]
  related: [sub.user-steers-child, bg.child-wakes-parent, sub.cut-off-by-engine-stop, ctl.steer-delivered]
  steps:
    - id: wants
      beat:
        title: Model ส่งข้อความถึง explore
        text: >-
          `message_agent` เป็น tool ที่ส่งแค่ชื่อไปก่อน model จึงโหลดนิยามด้วย `tool_search` ก่อน (แท็บแรก: ผลที่ได้คือ schema
          และคำอธิบายว่าลูกที่ยังทำงานได้ข้อความหลังรอบ tool ปัจจุบัน ส่วนลูกที่จบแล้วจะทำต่อจาก transcript ของตัวเอง)
          แล้ว model ส่ง `tool_use` ที่มี `agent_session` คือ session id ที่ได้จากผลของ `agent` และ `text: "Skip test files."` (แท็บสอง)
        from: model
        to: engine
        sees:
          - kind: payload
            source: packages/docs/src/data/recorded/background-steer.jsonl#line=8
            select: messages[4].content[0]
            quote: gets it after its current tool round and before its next model call
          - kind: payload
            source: packages/docs/src/data/recorded/background-steer.jsonl#line=14
            select: messages[5].content
            highlight: ['[1].input']
      lane: model
      do: >-
        model ขอเรียก `message_agent` ด้วย `agent_session` ของ explore และ `text: "Skip test files."`
        จบคำตอบด้วย `stop_reason: tool_use`
      ref: packages/core/src/steer.ts#MESSAGE_AGENT_TOOL_DEFINITION
      emits: [tool_use, message_agent]
      phase: calling-model

    - use: tool-call-opens
      beat:
        title: แชตขึ้นขั้น message_agent
        text: แผงแชตขึ้นขั้นใหม่พร้อมจุดหมุน
        from: panel
        to: you
        sees:
          kind: step
          label: message_agent explore
          status: running

    - id: one-at-a-time
      beat:
        title: Geno ส่งข้อความถึง explore ทีละข้อความ
        text: ถ้ามีข้อความถึงลูกตัวเดียวกันอีก มันต้องรอข้อความนี้จบก่อน เพื่อไม่ให้ปลุกลูกซ้อนกัน ทางที่ข้อความไปขึ้นกับว่า explore ยังทำงานอยู่ไหม
        from: engine
        to: engine
        ask: explore ยังทำงานไหม
      lane: loop
      at: tools
      runs: 1
      do: >-
        executor ของ `message_agent` ส่งข้อความถึงลูกตัวเดียวกันทีละข้อความ ข้อความที่สองรอข้อความแรกจบก่อน
        เพื่อไม่ให้สองข้อความปลุกลูกที่จบแล้วซ้อนกันบน log เดียว
      ref: "packages/engine/src/subagents.ts#\"const sent = (messaging.get(agent_session) ?? Promise.resolve()).then(send);\""
      fork:
        ask: explore ยังทำงานอยู่ไหม
        options:
          - id: running
            label: ยังทำงานอยู่
            then: logged
            steps:
              - lane: loop
                beat:
                  title: ข้อความเข้ากล่องของ explore
                  text: explore ยังทำงาน Geno ใส่ข้อความในกล่องของมัน แล้วรอจนมันรับ
                  from: engine
                  to: model
                at: tools
                do: >-
                  กล่องข้อความของลูกยังเปิดอยู่และแม่คือ session นี้ `inbox.push` ใส่ข้อความ (`from: 'parent'`) แล้วรอจนลูกรับ
                  call นี้จึงค้างจนลูกถึงจุดปลอดภัย
                ref: "packages/engine/src/subagents.ts#\"const delivery = await inbox.push({ text, from: 'parent' });\""
              - lane: child@explore
                beat:
                  title: explore รับข้อความที่จุดปลอดภัย
                  text: >-
                    request ถัดไปของ explore มีผลของ `grep` ที่มันขอไว้ ตามด้วยโน้ตของ Geno: ข้อความของแม่ในรั้ว `<parent_message>`
                    และหมายเหตุว่าให้ถือเป็นการเปลี่ยน task ข้อความนี้ไม่ใช่ผู้ใช้และไม่อนุมัติอะไร
                  from: engine
                  to: model
                  sees:
                    kind: payload
                    source: packages/docs/src/data/recorded/background-steer.jsonl#line=10
                    select: messages[2]
                    highlight: ['content[1].text']
                at: loop
                do: >-
                  `deliver()` ของลูกที่จุดปลอดภัยก่อนเรียก model ครั้งถัดไปบันทึก event `user` แบบ steer (`from: 'parent'`)
                  เนื้อความอยู่ในรั้ว `<parent_message>` พร้อมหมายเหตุว่าแม่ส่งมาระหว่างทำงาน ให้ถือเป็นการเปลี่ยน task
                  และข้อความนี้ไม่ใช่ผู้ใช้และไม่อนุมัติอะไร
                ref: packages/core/src/steer.ts#parentMessage
                emits: [user, parent_message]
              - lane: panel
                at: rail
                alongside: true
                do: >-
                  ในบทสนทนาของลูก (เปิดได้จากแถวของลูก) ข้อความขึ้นตรงที่ลงจริง
                sees: ป้าย "Message from the parent agent" ตามด้วย "Skip test files."
                ref: packages/extension/src/chat/steer-view.ts#steerStep
              - lane: child@explore
                beat:
                  title: explore ปรับงานตามข้อความของแม่
                  text: explore อ่านข้อความของแม่แล้วทำงานต่อโดยถือว่า task เปลี่ยนแล้ว
                  from: model
                  to: engine
                at: model
                do: >-
                  ลูกเรียก model ต่อโดยอ่านข้อความของแม่ แล้วทำงานต่อตามนั้น
                ref: packages/core/src/fence.ts#arrivalText
              - lane: loop
                beat:
                  title: Geno ตอบ model ว่าข้อความถึงแล้ว
                  text: >-
                    ผลของ call บอกว่าข้อความไปถึงตอนไหนในบันทึกของ explore ผลนี้ไม่ใช่รายงาน รายงานของ explore
                    มาทีหลังเป็นโน้ตของ Geno เหมือนลูกเบื้องหลังตัวอื่น
                  from: engine
                  to: model
                  sees:
                    kind: payload
                    source: packages/docs/src/data/recorded/background-steer.jsonl#line=14
                    select: messages[6].content[0]
                    highlight: [content]
                at: tools
                do: >-
                  `push` ได้ผล `delivered` พร้อมลำดับ event ในลูก ผลของ call คือ
                  "delivered at next tool round (event 14 of the subagent's log)"
                  (ถ้าลูกจบก่อนรับ ข้อความจะไปทางเดียวกับลูกที่จบแล้ว)
                ref: packages/core/src/steer.ts#messageAgentResult
                emits: [delivered]

          - id: finished
            label: จบแล้ว
            then: logged
            steps:
              - lane: loop
                beat:
                  title: Geno ตรวจว่าปลุก explore ได้
                  text: explore จบไปแล้ว Geno ตรวจว่ามันเป็นลูกของ session นี้ และนิยาม explore ยังอยู่
                  from: engine
                  to: engine
                at: tools
                do: >-
                  ไม่มีกล่องข้อความที่เปิดอยู่ `resumable` อ่าน log ของลูก ตรวจว่า `session-start` บอกว่าแม่คือ session นี้
                  (หรือ workflow ที่ session นี้เริ่ม) ลูกไม่ได้รันบน agent ภายนอก และนิยาม `explore` ยังมีอยู่
                ref: "packages/engine/src/subagents.ts#\"const resumable = async (id: string, message: string\""
              - lane: child@explore
                beat:
                  title: explore ทำต่อจาก transcript ของตัวเอง
                  text: >-
                    request ของ explore ที่ถูกปลุกเริ่มด้วยบทสนทนาเดิมของมันทั้งหมด รวม call `report` ครั้งก่อน
                    ต่อด้วยผล "Report delivered" และโน้ตที่มีข้อความของแม่ในรั้ว `<parent_message>` บอกว่ามาหลังรายงาน
                    ให้ทำต่อและส่งรายงานใหม่ (การ์ดนี้มาจาก flow ที่ explore รันแบบรอ และข้อความคือคำถามต่อ)
                    explore ได้งบชุดใหม่
                  from: engine
                  to: model
                  sees:
                    kind: payload
                    source: packages/docs/src/data/recorded/message-finished.jsonl#line=12
                    select: messages
                    highlight: ['[1].content[1]', '[2].content[1].text']
                at: loop
                do: >-
                  `openResume` ต่อท้าย log ของลูกด้วย event `user` จากแม่ (`resumeEvent`) หมายเหตุบอกว่าข้อความนี้มาหลังรายงาน
                  งานเดินต่อจากตรงนี้ และให้ส่งรายงานใหม่ ลูกได้เพดานรอบและเงินชุดใหม่ ยังจำกัดด้วยงบที่รอบของแม่เหลือ
                ref: packages/core/src/steer.ts#resumeEvent
                emits: [user]
              - lane: loop
                at: drive
                do: >-
                  `runPlaced` บันทึก `child-start` ใหม่ด้วย session id เดิมของลูก และ call id ของ `message_agent`
                ref: "packages/engine/src/subagents.ts#\"await ctx.logNote!({ kind: 'child-start'\""
                emits: [child-start]
              - lane: server
                beat:
                  title: แถวของ explore กลับมาหมุน
                  text: แชตเห็นว่า explore รันอีกครั้ง
                  from: panel
                  to: you
                  sees:
                    kind: task
                    title: explore
                    status: running
                    detail: 0:01
                at: updates
                do: >-
                  `subagent_update` สถานะ `running` แถวของลูกกลับมาหมุนอีกครั้ง
                ref: packages/engine/src/subagent-acp.ts#acpChildHost
                emits: [subagent_update, running]
              - lane: panel
                at: rail
                alongside: true
                do: แถวของ explore กลับมาเป็น Running
                sees: แถว "explore · <model> · 0:01" พร้อมไดโนเสาร์ที่ขยับ
                ref: packages/extension/src/chat/subagent-view.ts#childRow
              - lane: loop
                beat:
                  title: Geno ตอบ model ว่าปลุก explore แล้ว
                  text: >-
                    explore เดิมทำงานเบื้องหลัง จึงถูกปลุกแบบเบื้องหลังอีกครั้ง session นี้รอรายงานใหม่ ซึ่งจะมาถึงทีหลัง
                    ถ้า explore เคยรันแบบรอ call `message_agent` จะรอ และผลของมันคือรายงานใหม่ในรั้ว
                    `<subagent_report>` ที่มี session id เดิม (การ์ด จาก flow แบบรอ)
                  from: engine
                  to: model
                  sees:
                    kind: payload
                    source: packages/docs/src/data/recorded/message-finished.jsonl#line=14
                    select: messages[8].content[0]
                    highlight: [content]
                at: tools
                do: >-
                  explore เดิมเป็นลูกเบื้องหลัง จึงถูกปลุกแบบเบื้องหลังอีกครั้ง: session ติดหนี้รายงานใหม่ และผลของ call คือ
                  "Resumed explore in the background as subagent session ..., with your message. Its new report arrives ..."
                  (ลูกที่เคยรันแบบรอ call นี้จะรอ และผลคือรายงานใหม่ในรั้ว)
                ref: "packages/engine/src/subagents.ts#\"Resumed ${name} in the background as subagent session ${id}, with your message.\""
                emits: [Resumed]

    - id: logged
      beat:
        title: ขั้น message_agent เสร็จ
        text: Geno บันทึกผลของ call และแชตขึ้นว่าขั้นนี้เสร็จ แล้วส่งผลให้ model อ่าน
        from: panel
        to: you
        sees:
          kind: step
          label: message_agent explore
          status: done
      lane: loop
      at: tools
      do: >-
        `runTools` บันทึก `tool-result` ของ `message_agent`
      ref: "packages/engine/src/drive.ts#\"for (const result of outcome.results) if (result !== undefined) await record(result);\""
      emits: [tool-result]

    - id: update
      lane: server
      at: updates
      do: >-
        `toolResultUpdate` ส่ง `tool_call_update` ขั้นของ `message_agent` เสร็จ
      ref: packages/engine/src/session-replay.ts#toolResultUpdate
      emits: [tool_call_update]

    - use: model-call

    - id: tells
      beat:
        title: Model บอกคุณว่าส่งต่อแล้ว
        text: model บอกว่าส่งข้อความถึง explore แล้ว และจะเล่าเมื่อรายงานมาถึง โดยไม่เดาผล
        from: model
        to: engine
        end: Turn จบ รอรายงาน
      lane: model
      do: >-
        model บอกผู้ใช้ว่าส่งต่อให้ explore แล้ว และจะเล่าเมื่อรายงานมาถึง โดยไม่เดาผล
      ref: "packages/engine/src/gateway.ts#\"stopReason: message.stop_reason,\""
      emits: [end_turn]
      end: { turn: done, reason: end_turn }
---

`message_agent` มีทางเดียวสำหรับ model แต่ engine เลือกทางตามสถานะของลูก

| ลูก | ข้อความไปที่ | ผลของ call | รายงาน |
| --- | --- | --- | --- |
| ยังทำงาน | จุดปลอดภัยถัดไปของลูก | `delivered at next tool round (event N ...)` | ฉบับเดิมที่จะมา |
| จบแล้ว รันแบบรอ | ต่อท้าย log แล้วรันใหม่ | รายงานใหม่ในรั้ว | เป็นผลของ call นี้ |
| จบแล้ว รันเบื้องหลัง | ต่อท้าย log แล้วรันใหม่ | `Resumed ... in the background ...` | มาทีหลังเป็นข้อความ |
| รันบน agent ภายนอก | ไม่ส่ง | `not delivered: ... cannot take a message mid-turn` หรือ error ว่า resume ไม่ได้ | ไม่มี |

สิ่งที่ควรสังเกต

- **ข้อความของแม่ไม่ใช่คำของผู้ใช้** รั้ว `<parent_message>` บอกลูกว่ามันไม่อนุมัติอะไร ลูกจึงอ้างข้อความนี้ข้ามการขออนุญาตไม่ได้
- **call ค้างจนลูกรับ** กับลูกที่ทำงานอยู่ `message_agent` จบเมื่อลูกถึงจุดปลอดภัย ถ้าลูกกำลังรันคำสั่งยาว call นี้รอด้วย
- **ลูกของ workflow ก็ส่งถึงได้** session ที่เริ่ม workflow ส่งข้อความถึงขั้นของ workflow นั้นได้ เพราะ `holderOf` อ่าน log ของ workflow
