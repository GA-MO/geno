---
title: คำสั่ง / ที่ Geno ทำเอง
description: คำสั่งในตัวบางคำสั่ง VS Code ทำเองโดยไม่ติดต่อ engine บางคำสั่ง engine ทำเองโดยไม่เรียก model ทั้งสองแบบไม่เปิดรอบของเอเจนต์
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
      beat:
        title: คุณเลือกคำสั่งจากรายการ `/`
        text: รายการบอกว่าคำสั่งไหน VS Code ทำเอง และคำสั่งไหน engine ทำ คำสั่งที่ไม่รับอะไรต่อท้าย เช่น `/new` กด Enter แล้วส่งเลย คำสั่งที่รับค่า เช่น `/mode` กด Enter แล้วได้ `/mode ` ในช่องพิมพ์ คุณพิมพ์ `plan` แล้วกด Enter อีกครั้งจึงส่งทั้งบรรทัด
        from: you
        to: panel
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
      beat:
        title: แชตดูว่าใครทำคำสั่งนี้
        text: ก่อนทำอย่างอื่น แชตดูว่าคำสั่งเป็นของ VS Code หรือของ engine
        from: panel
        to: panel
        ask: คำสั่งไหน
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
                beat:
                  title: VS Code เปิดแชตใหม่เอง
                  text: "`/new` ไม่ติดต่อ engine ไม่มี turn และไม่มีอะไรถูกบันทึกลง log session เดิมยังอยู่ในประวัติ"
                  from: panel
                  to: panel
                at: chat
                do: >-
                  `/new` ตรงกับ action `new-chat` `Chat.newChat` ซ่อนประวัติ แล้วเปิด session ใหม่ให้แผง
                  ไม่มี action `turn-start` ไม่มีคำขอ `session/prompt` และไม่มีอะไรถูกบันทึกลง log ของ session เดิม
                ref: packages/extension/src/chat/chat.ts#Chat.newChat
              - lane: panel
                beat:
                  title: แชตว่างพร้อมหน้าเริ่มต้น
                  text: ช่องพิมพ์ว่าง พร้อมรับ prompt แรกของแชตใหม่
                  from: panel
                  to: you
                  sees:
                    kind: composer
                    state: idle
                  end: แชตใหม่ว่าง
                at: rail
                do: แผงแชตว่าง พร้อมหน้าเริ่มต้นของแชตใหม่ session เดิมยังอยู่ในประวัติ
                sees: หน้าแชตใหม่ที่ไม่มีข้อความ และช่องพิมพ์ว่าง
                ref: packages/extension/src/chat/webview.ts#render
                end: { turn: none }

          - id: engine
            label: /mode plan (engine ทำเอง)
            steps:
              - lane: editor
                beat:
                  title: แชตส่ง `/mode plan` ไปที่ engine
                  text: "`/mode` ไม่ใช่คำสั่งของ VS Code แชตวาด turn ใหม่ที่มีชิปของคำสั่ง (ป้ายเล็กที่แสดงคำสั่งที่พิมพ์) แล้วส่งข้อความเป็น prompt ไปที่ engine เหมือนข้อความธรรมดา"
                  from: panel
                  to: engine
                at: chat
                do: >-
                  `/mode` ไม่ใช่คำสั่งของ editor `prompt()` ส่ง action `turn-start` ที่มีชิปของคำสั่ง แล้วส่งคำขอ ACP `session/prompt`
                ref: packages/extension/src/chat/chat.ts#Chat.prompt
                emits: [turn-start, session/prompt]
              - lane: server
                beat:
                  title: engine ทำเองโดยไม่เรียก model
                  text: engine เห็นว่าเป็นคำสั่งในตัว จึงไม่เปิดรอบของ agent ซึ่งคือ loop ที่เรียก model และรัน tool ไม่มีงานในแผง Tasks (แผงที่แสดงงานที่กำลังทำ) และไม่มีการเรียก model แชตยังแสดงเป็น turn สั้นๆ แต่ engine ไม่ได้เปิด turn จริง
                  from: engine
                  to: engine
                at: turns
                do: >-
                  `runTurn` ให้ `commands.expand` แปลงข้อความ ได้ `builtin` จึงเรียก `runBuiltin` แทนการเปิดรอบของเอเจนต์
                  ไม่มีการลงทะเบียน turn ไม่มีงานในแผง Tasks และไม่มีการเรียก model
                ref: packages/engine/src/commands.ts#runBuiltin
                emits: [builtin]
                phase: starting
              - lane: server
                beat:
                  title: Geno เปลี่ยนโหมดทันที
                  text: Geno ตรวจว่า plan เป็นโหมดที่มีจริง เปลี่ยนโหมดของ session บันทึกลง log และบอกแชตว่าโหมดเปลี่ยน โหมด Plan คือโหมดอ่านอย่างเดียว ไม่แก้ไฟล์ และรันเฉพาะคำสั่งที่ปลอดภัย
                  from: engine
                  to: engine
                at: turns
                do: >-
                  `ENGINE_ACTIONS.mode` ตรวจว่า `plan` เป็นโหมดที่มีจริง แล้ว `switchMode` เปลี่ยนโหมดของ session ทันที
                  บันทึก event `mode` ลง log และส่ง `current_mode_update` ให้ editor การอนุญาตครั้งต่อไปของ session นี้ใช้โหมด Plan
                ref: packages/engine/src/serve.ts#switchMode
                emits: [current_mode_update, mode]
              - lane: server
                beat:
                  title: แชตขึ้นคำตอบหนึ่งบรรทัด
                  text: แชตขึ้นคำตอบหนึ่งบรรทัดว่าโหมดเป็น plan แล้ว turn สั้นๆ ในแชตจบแบบ done ตัวเลือกโหมดในช่องพิมพ์เป็น Plan
                  from: engine
                  to: panel
                  sees:
                    kind: message
                    from: geno
                    text: "Approval mode: plan."
                  end: Turn สั้นๆ จบ
                at: turns
                do: >-
                  คำตอบของคำสั่งคือ "Approval mode: plan." ส่งเป็น `agent_message_chunk` แล้วตอบ `session/prompt`
                  ด้วย `stopReason: end_turn` และ `_meta` ที่บอกว่าจบแบบ `done` (ไม่มีงานในแผง Tasks ให้จบ)
                ref: "packages/engine/src/serve.ts#\"if (reply !== '') await from.client.notify(\""
                emits: [agent_message_chunk, end_turn]
                phase: ending
              - lane: editor
                at: chat
                do: >-
                  `current_mode_update` เปลี่ยนตัวเลือกโหมดในช่องพิมพ์ แล้ว `turnEndOf` อ่าน `_meta` ได้ `done` และ `prompt()` ส่ง action `turn-end`
                ref: "packages/extension/src/chat/chat.ts#\"this.dispatch({ type: 'turn-end', at: Date.now(), status, usage: usageOf(response)\""
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

คำสั่งในตัวมีสามกลุ่ม ต่างกันที่ว่าใครทำและต้องเปิดรอบของเอเจนต์ ([agent loop](/start/glossary/)) ไหม

| กลุ่ม | คำสั่ง | ใครทำ | เรียก model |
| --- | --- | --- | --- |
| editor | `/new` `/clear` `/history` `/model` `/rules` `/memory` `/best-of-n` `/lane` | VS Code | ไม่ |
| engine | `/mode` `/schedule` | engine โดยไม่เปิดรอบ | ไม่ |
| engine ที่สรุปบริบท | `/compact` | engine โดยไม่เปิดรอบ | เรียกครั้งเดียวเพื่อสรุป ดู [/compact ระหว่างสอง turn](/scenarios/ctx/compaction-manual/) |
| กลายเป็น prompt | `/init` `/workflow` | รอบปกติของเอเจนต์ (`/workflow` engine เรียก tool `workflow` เองก่อน ไม่มี model อ่าน prompt ก่อน) | ใช่ |

สิ่งที่ควรสังเกต

- **client อื่นที่ไม่มีคำสั่งของ editor** ถ้า client ที่ไม่ใช่ VS Code ส่ง `/new` มาที่ engine `runBuiltin` ตอบว่า
  "/new runs in the editor, and this client does not offer it."
- **อาร์กิวเมนต์ผิดไม่ทำให้ล้ม** `/mode อะไรก็ได้` ได้คำตอบ "Usage: /mode plan | ask | auto" และ turn ยังจบแบบ done
- **ไม่มี prompt ใน log** ทางของคำสั่ง builtin ไม่บันทึกข้อความของผู้ใช้ เมื่อเปิด session ซ้ำ จะเห็นแค่ผลของคำสั่ง (เช่น event `mode`)
- **การเปลี่ยนโหมดระหว่าง turn** ทำได้จากตัวเลือกโหมด ไม่ใช่จาก `/mode` เพราะคำสั่ง `/` ส่งไม่ได้ขณะ turn รัน (แผงเก็บไว้ในคิว)
