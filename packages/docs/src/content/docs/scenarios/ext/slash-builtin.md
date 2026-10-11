---
title: คำสั่ง / ที่ Geno ทำเอง
description: คำสั่งในตัวบางคำสั่ง VS Code ทำเองโดยไม่ติดต่อ engine บางคำสั่ง engine ทำเองโดยไม่เรียกโมเดล ทั้งสองแบบไม่เปิดรอบของเอเจนต์
tableOfContents: false
sidebar:
  order: 2
scenario:
  surface: vscode
  given:
    - เปิด Geno ในแผงแชตของ VS Code ในโหมด Ask
    - session นี้มีบทสนทนาอยู่แล้วและไม่มี turn ทำงานอยู่
  trigger: >-
    ผู้ใช้พิมพ์คำสั่งในตัว เช่น `/mode plan` หรือ `/new` แล้วกด Enter
  covers: [ext.slash-builtin-engine, ext.slash-builtin-editor]
  related: [ctx.compaction-manual, ext.slash-template, perm.mode-switch-mid-turn, sess.new-chat]
  steps:
    - id: type
      lane: user
      do: >-
        ผู้ใช้เลือกคำสั่งจากรายการ `/` แล้วกด Enter รายการบอกว่าคำสั่งไหน editor ทำเอง และคำสั่งไหน engine ทำ
      phase: idle

    - id: send
      lane: panel
      at: composer
      do: >-
        `submit()` โพสต์ข้อความ `send` พร้อมข้อความทั้งบรรทัดไปให้ extension host
      ref: packages/extension/src/chat/webview.ts#submit
      emits: [send]

    - id: route
      lane: editor
      at: chat
      do: >-
        `Chat.send` ถาม `routeText` ก่อนทำอย่างอื่น คำสั่งที่ engine บอกว่า `runs: client` และอยู่ใน `EDITOR_ACTIONS`
        (`/new`, `/clear`, `/history`, `/model`, `/rules`, `/memory`, `/best-of-n`, `/lane`) VS Code ทำเอง ที่เหลือส่งให้ engine
      ref: packages/extension/src/chat/slash-route.ts#routeText
      fork:
        ask: คำสั่งไหน
        options:
          - id: editor
            label: /new (VS Code ทำเอง)
            steps:
              - lane: editor
                at: chat
                do: >-
                  `/new` ตรงกับ action `new-chat` `Chat.newChat` ซ่อนประวัติ แล้วเปิด session ใหม่ให้แผง
                  ไม่มี action `turn-start` ไม่มีคำขอ `session/prompt` และไม่มีอะไรถูกบันทึกลง log ของ session เดิม
                ref: packages/extension/src/chat/chat.ts#Chat.newChat
              - lane: panel
                at: rail
                do: แผงแชตว่าง พร้อมหน้าเริ่มต้นของแชตใหม่ session เดิมยังอยู่ในประวัติ
                sees: หน้าแชตใหม่ที่ไม่มีข้อความ และช่องพิมพ์ว่าง
                ref: packages/extension/src/chat/webview.ts#render
                end: { turn: none }

          - id: engine
            label: /mode plan (engine ทำเอง)
            steps:
              - lane: editor
                at: chat
                do: >-
                  `/mode` ไม่ใช่คำสั่งของ editor `prompt()` ส่ง action `turn-start` ที่มีชิปของคำสั่ง แล้วส่งคำขอ ACP `session/prompt`
                ref: packages/extension/src/chat/chat.ts#Chat.prompt
                emits: [turn-start, session/prompt]
              - lane: server
                at: turns
                do: >-
                  `runTurn` ให้ `commands.expand` แปลงข้อความ ได้ `builtin` จึงเรียก `runBuiltin` แทนการเปิดรอบของเอเจนต์
                  ไม่มีการลงทะเบียน turn ไม่มีงานในแผง Tasks และไม่มีการเรียกโมเดล
                ref: packages/engine/src/commands.ts#runBuiltin
                emits: [builtin]
                phase: starting
              - lane: server
                at: turns
                do: >-
                  `ENGINE_ACTIONS.mode` ตรวจว่า `plan` เป็นโหมดที่มีจริง แล้ว `switchMode` เปลี่ยนโหมดของ session ทันที
                  บันทึก event `mode` ลง log และส่ง `current_mode_update` ให้ editor การอนุญาตครั้งต่อไปของ session นี้ใช้โหมด Plan
                ref: packages/engine/src/serve.ts#switchMode
                emits: [current_mode_update, mode]
              - lane: server
                at: turns
                do: >-
                  คำตอบของคำสั่งคือ "Approval mode: plan." ส่งเป็น `agent_message_chunk` แล้วตอบ `session/prompt`
                  ด้วย `stopReason: end_turn` งานจบแบบ `done`
                ref: "packages/engine/src/serve.ts#\"if (reply !== '') await from.client.notify(\""
                emits: [agent_message_chunk, end_turn]
                phase: ending
              - lane: editor
                at: chat
                do: >-
                  `current_mode_update` เปลี่ยนตัวเลือกโหมดในช่องพิมพ์ แล้ว `turnEndOf` อ่านได้ `done` และส่ง action `turn-end`
                ref: packages/extension/src/chat/chat.ts#turnEndOf
                emits: [turn-end]
              - lane: panel
                at: rail
                do: >-
                  turn สั้นๆ มีชิป `/mode plan` กับคำตอบหนึ่งบรรทัด ตัวเลือกโหมดในช่องพิมพ์เป็น Plan
                sees: >-
                  ชิป "/mode plan" คำตอบ "Approval mode: plan." หัวข้อ "worked for 0s" และช่องพิมพ์ที่บอกโหมด Plan
                ref: packages/extension/src/chat/rail.ts#headerOf
                end: { turn: done, reason: end_turn }
---

คำสั่งในตัวมีสามกลุ่ม ต่างกันที่ว่าใครทำและต้องเปิดรอบของเอเจนต์ไหม

| กลุ่ม | คำสั่ง | ใครทำ | เรียกโมเดล |
| --- | --- | --- | --- |
| editor | `/new` `/clear` `/history` `/model` `/rules` `/memory` `/best-of-n` `/lane` | VS Code | ไม่ |
| engine | `/mode` `/schedule` | engine โดยไม่เปิดรอบ | ไม่ |
| engine ที่สรุปบริบท | `/compact` | engine โดยไม่เปิดรอบ | เรียกครั้งเดียวเพื่อสรุป ดู [/compact ระหว่าง turn](/scenarios/ctx/compaction-manual/) |
| กลายเป็น prompt | `/init` `/workflow` | รอบปกติของเอเจนต์ | ใช่ |

สิ่งที่ควรสังเกต

- **client อื่นที่ไม่มีคำสั่งของ editor** ถ้า client ที่ไม่ใช่ VS Code ส่ง `/new` มาที่ engine `runBuiltin` ตอบว่า
  "/new runs in the editor, and this client does not offer it."
- **อาร์กิวเมนต์ผิดไม่ทำให้ล้ม** `/mode อะไรก็ได้` ได้คำตอบ "Usage: /mode plan | ask | auto" และ turn ยังจบแบบ done
- **ไม่มี prompt ใน log** ทางของคำสั่ง builtin ไม่บันทึกข้อความของผู้ใช้ เมื่อเปิด session ซ้ำ จะเห็นแค่ผลของคำสั่ง (เช่น event `mode`)
- **การเปลี่ยนโหมดระหว่าง turn** ทำได้จากตัวเลือกโหมด ไม่ใช่จาก `/mode` เพราะคำสั่ง `/` ส่งไม่ได้ขณะ turn รัน (แผงเก็บไว้ในคิว)
