---
title: ส่งข้อความถึงลูก ที่กำลังทำงานหรือจบแล้ว
description: แม่ใช้ message_agent ส่งข้อความถึงลูกที่เริ่มไว้ ลูกที่ยังทำงานได้ข้อความที่จุดปลอดภัยถัดไป ลูกที่จบแล้วถูกปลุกให้ทำต่อจาก transcript ของตัวเอง
tableOfContents: false
sidebar:
  order: 7
scenario:
  surface: vscode
  given:
    - ค่า `agentTool` มีโหมดปัจจุบัน โมเดลจึงมีทั้ง `agent` และ `message_agent`
    - ใน turn นี้โมเดลเริ่ม `explore` แบบเบื้องหลังไว้แล้ว ได้ session id ของลูกจากผลของ call `agent`
  trigger: >-
    ผู้ใช้บอกว่าให้ดู `packages/cli` ด้วย โมเดลจึงส่งข้อความถึง explore
  covers: [sub.message-running-child, sub.message-finished-resume]
  related: [sub.user-steers-child, bg.child-wakes-parent, sub.cut-off-by-engine-stop, ctl.steer-delivered]
  steps:
    - id: wants
      lane: model
      do: >-
        โมเดลขอเรียก `message_agent` ด้วย `agent_session` ของ explore และ `text: "also cover packages/cli"`
        จบคำตอบด้วย `stop_reason: tool_use`
      ref: packages/core/src/steer.ts#MESSAGE_AGENT_TOOL_DEFINITION
      emits: [tool_use, message_agent]
      phase: calling-model

    - use: tool-call-opens

    - id: one-at-a-time
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
                at: tools
                do: >-
                  กล่องข้อความของลูกยังเปิดอยู่และแม่คือ session นี้ `inbox.push` ใส่ข้อความ (`from: 'parent'`) แล้วรอจนลูกรับ
                  call นี้จึงค้างจนลูกถึงจุดปลอดภัย
                ref: "packages/engine/src/subagents.ts#\"const delivery = await inbox.push({ text, from: 'parent' });\""
              - lane: child@explore
                at: loop
                do: >-
                  `deliver()` ของลูกที่จุดปลอดภัยก่อนเรียกโมเดลครั้งถัดไปบันทึก event `user` แบบ steer (`from: 'parent'`)
                  เนื้อความอยู่ในรั้ว `<parent_message>` พร้อมหมายเหตุว่าแม่ส่งมาระหว่างทำงาน ให้ถือเป็นการเปลี่ยน task
                  และข้อความนี้ไม่ใช่ผู้ใช้และไม่อนุมัติอะไร
                ref: packages/core/src/steer.ts#parentMessage
                emits: [user, parent_message]
              - lane: panel
                at: rail
                alongside: true
                do: >-
                  ในบทสนทนาของลูก (เปิดได้จากแถวของลูก) ข้อความขึ้นตรงที่ลงจริง
                sees: ป้าย "Message from the parent agent" ตามด้วย "also cover packages/cli"
                ref: packages/extension/src/chat/steer-view.ts#steerStep
              - lane: child@explore
                at: model
                do: >-
                  ลูกเรียกโมเดลต่อโดยอ่านข้อความของแม่ แล้วค้นใน `packages/cli` เพิ่ม
                ref: packages/core/src/fence.ts#arrivalText
              - lane: loop
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
                at: tools
                do: >-
                  ไม่มีกล่องข้อความที่เปิดอยู่ `resumable` อ่าน log ของลูก ตรวจว่า `session-start` บอกว่าแม่คือ session นี้
                  (หรือ workflow ที่ session นี้เริ่ม) ลูกไม่ได้รันบน agent ภายนอก และนิยาม `explore` ยังมีอยู่
                ref: "packages/engine/src/subagents.ts#\"const resumable = async (id: string, message: string\""
              - lane: child@explore
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
                at: updates
                do: >-
                  `subagent_update` สถานะ `running` แถวของลูกกลับมาหมุนอีกครั้ง
                ref: packages/engine/src/subagent-acp.ts#acpChildHost
                emits: [subagent_update, running]
              - lane: panel
                at: rail
                alongside: true
                do: แถวของ explore กลับมาเป็น Running
                sees: แถว "explore · <โมเดล> · 0:01" พร้อมไดโนเสาร์ที่ขยับ
                ref: packages/extension/src/chat/subagent-view.ts#childRow
              - lane: loop
                at: tools
                do: >-
                  explore เดิมเป็นลูกเบื้องหลัง จึงถูกปลุกแบบเบื้องหลังอีกครั้ง: session ติดหนี้รายงานใหม่ และผลของ call คือ
                  "Resumed explore in the background as subagent session ..., with your message. Its new report arrives ..."
                  (ลูกที่เคยรันแบบรอ call นี้จะรอ และผลคือรายงานใหม่ในรั้ว)
                ref: "packages/engine/src/subagents.ts#\"Resumed ${name} in the background as subagent session ${id}, with your message.\""
                emits: [Resumed]

    - id: logged
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
      lane: model
      do: >-
        โมเดลบอกผู้ใช้ว่าส่งต่อให้ explore แล้ว และจะเล่าเมื่อรายงานมาถึง โดยไม่เดาผล
      ref: "packages/engine/src/gateway.ts#\"stopReason: message.stop_reason,\""
      emits: [end_turn]
      end: { turn: continues, reason: end_turn }
---

`message_agent` มีทางเดียวสำหรับโมเดล แต่ engine เลือกทางตามสถานะของลูก

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
