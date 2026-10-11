---
title: พิมพ์ต่อคิวไว้ขณะเทิร์นทำงาน
description: ผู้ใช้กด Enter ระหว่างที่ turn ทำงาน ข้อความรอในคิวของแผง แล้วถูกส่งเมื่อ turn จบแบบ done หรือกลับไปที่ช่องพิมพ์ถ้าถูกหยุด
tableOfContents: false
sidebar:
  order: 2
scenario:
  surface: vscode
  given:
    - turn ของแชตนี้กำลังทำงาน ปุ่ม Stop แสดงอยู่แทนปุ่ม Send
    - ช่องพิมพ์ยังไม่มีข้อความรอในคิว
  trigger: >-
    ผู้ใช้พิมพ์ "แล้วเพิ่ม README ด้วย" แล้วกด Enter ระหว่างที่ turn ทำงาน
  covers: [ctl.queued-followup]
  related: [ctl.steer-delivered, ctl.stop-while-streaming, turn.text-answer]
  steps:
    - id: type
      lane: user
      do: ผู้ใช้พิมพ์ข้อความถัดไปแล้วกด Enter ขณะที่ turn ยังไม่จบ
      phase: calling-model

    - id: queue
      lane: panel
      at: composer
      do: >-
        `submit()` เห็นว่ามี turn ทำงานอยู่ จึงไม่ส่ง แต่เก็บข้อความและไฟล์แนบเป็นข้อความรอหนึ่งข้อความในแผงเอง
        ช่องพิมพ์ว่าง ถ้ามีข้อความรออยู่แล้ว Enter ครั้งต่อไปไม่ทำอะไร
        extension host และ engine ยังไม่รู้เรื่องข้อความนี้
      sees: >-
        ป้าย "Queued" เหนือช่องพิมพ์ (ชี้แล้วขึ้น "Sends when the turn finishes") พร้อมปุ่มกากบาทที่เอาออกจากคิว
        และปุ่ม Send now ที่ส่งแทรกเข้า turn ที่ทำงานอยู่
      ref: packages/extension/src/chat/webview.ts#submit

    - id: runs
      lane: user
      do: >-
        ผู้ใช้รอ turn ทำงานต่อตามปกติ (ถ้ากด Send now ข้อความจะกลายเป็น steer ซึ่งเป็นอีกสถานการณ์หนึ่ง)

    - id: turn-end
      lane: editor
      at: chat
      do: >-
        turn จบ คำขอ `session/prompt` ได้คำตอบ `prompt()` ส่ง action `turn-end` พร้อมสถานะที่ engine บอก
        แล้วล้าง turn ที่ทำงานอยู่ของแผงทันทีหลังจากนั้น
      ref: "packages/extension/src/chat/chat.ts#\"this.dispatch({ type: 'turn-end', at: Date.now(), status, usage: usageOf(response)\""
      emits: [turn-end]
      phase: ending

    - id: at-end
      lane: panel
      at: composer
      do: >-
        แผงได้ `turn-end` แล้วเรียก `sendQueued` กับสถานะนั้น `followupAtTurnEnd` ตัดสินว่าจะส่งหรือคืนข้อความ
      ref: "packages/extension/src/chat/webview.ts#\"if (message.type === 'turn-end') sendQueued(message.status);\""
      fork:
        ask: turn ที่ทำงานอยู่จบแบบไหน
        options:
          - id: done
            label: จบแบบ done
            steps:
              - lane: panel
                at: composer
                do: >-
                  ข้อความรอออกจากคิว แผงโพสต์ `send` พร้อมข้อความและไฟล์แนบ เหมือนผู้ใช้เพิ่งกด Enter
                ref: packages/extension/src/chat/webview.ts#sendQueued
                emits: [send]
              - lane: editor
                at: chat
                do: >-
                  `Chat.send` ส่งต่อให้ `prompt()` turn ก่อนถูกล้างไปแล้ว จึงเริ่ม turn ใหม่ได้ทันที
                sees: บับเบิลใหม่ "แล้วเพิ่ม README ด้วย" และหัวข้อ "working"
                ref: packages/extension/src/chat/chat.ts#Chat.prompt
                emits: [turn-start]
                phase: starting
                goto: turn.text-answer
          - id: stopped
            label: ถูกหยุดหรือล้มเหลว
            steps:
              - lane: panel
                at: composer
                do: >-
                  ข้อความรอออกจากคิวโดยไม่ถูกส่ง `restoreFollowup` ใส่ข้อความกลับในช่องพิมพ์ถ้าช่องว่างอยู่ และคืนไฟล์แนบ
                  ผู้ใช้ตัดสินเองว่าจะส่งหรือไม่ เพราะ turn ไม่ได้ทำงานจนจบ
                sees: ป้าย Queued หายไป ข้อความ "แล้วเพิ่ม README ด้วย" กลับมาอยู่ในช่องพิมพ์
                ref: packages/extension/src/chat/webview.ts#restoreFollowup
                end: { turn: stopped, reason: cancelled }
---

คิวนี้อยู่ใน webview ล้วนๆ ข้อความรอไม่ไปถึง extension host หรือ engine จนกว่าแผงจะตัดสินใจส่ง
จึงมีได้ทีละหนึ่งข้อความ และแผงตัดสินจากสถานะใน `turn-end` เท่านั้น

| turn จบแบบ | ข้อความรอ |
| --- | --- |
| `done` | ส่งเป็น turn ใหม่ทันที |
| `stopped` | กลับไปที่ช่องพิมพ์ |
| `failed` | กลับไปที่ช่องพิมพ์ |

สิ่งที่ควรสังเกต

- **Queued ต่างจาก Send now** ข้อความ Queued รอให้ turn จบ ส่วน Send now ส่งข้อความเป็น steer ทันที
  ซึ่งเข้าสู่ turn ที่ทำงานอยู่ที่จุดปลอดภัยถัดไป ข้อความที่มีไฟล์แนบหรือ `@` mention ใช้ Send now ไม่ได้ ต้องรอในคิว
- **ข้อความรอทำให้ Continue และ Retry หายไป** ถ้า turn จบโดยไม่มีคำตอบ ปุ่ม Continue และ Retry จะไม่แสดงขณะที่มีข้อความรอ
- **การสลับแชตไม่ล้างคิว** เมื่อแผงย้ายไปแชตอื่น (New Chat หรือเปิดจาก History) แผงล้างเฉพาะข้อความที่กำลังส่งเป็น steer
  ข้อความ Queued ยังค้างอยู่ในช่องพิมพ์ของแชตใหม่ แชตใหม่ไม่มี turn ทำงาน ข้อความนั้นจึงไม่ถูกส่ง
  จนกว่า turn ถัดไปของแชตใหม่จะจบแบบ done แล้วมันจะถูกส่งเข้าแชตใหม่ ผู้ใช้เอาออกได้ด้วยปุ่มกากบาทบนป้าย
