---
title: แนบไฟล์และ @mention
description: ผู้ใช้ @mention ไฟล์ใน workspace และวางภาพหน้าจอในช่องพิมพ์ ส่วนขยายส่งเป็นบล็อก ACP engine อ่านไฟล์ เก็บภาพ บันทึก prompt พร้อมบริบท แล้วจึงเริ่ม turn
tableOfContents: false
sidebar:
  order: 5
scenario:
  surface: vscode
  given:
    - แชตในแผงไม่มี turn ทำงาน และ workspace มี `src/date.test.ts`
    - ผู้ใช้มีภาพหน้าจอของ error อยู่ใน clipboard
  trigger: >-
    ผู้ใช้พิมพ์ `@date.t` ในช่องพิมพ์
  covers: [start.attach-and-mention]
  related: [turn.text-answer, tool.read-special-files, ctl.steer-delivered]
  steps:
    - id: at
      lane: user
      do: ผู้ใช้พิมพ์ `@` ตามด้วยส่วนหนึ่งของชื่อไฟล์
      phase: idle

    - id: complete
      lane: panel
      at: composer
      do: >-
        `askCompletions` เห็นว่าเคอร์เซอร์อยู่ใน mention จึงโพสต์ `complete` พร้อมคำค้น ทุกการกดแป้นถามใหม่
        และแผงแสดงเฉพาะคำตอบของคำถามล่าสุด
      ref: packages/extension/src/chat/webview.ts#askCompletions
      emits: [complete]

    - id: candidates
      lane: editor
      at: chat
      do: >-
        `Mentions.completions` จัดอันดับไฟล์ใน workspace ตามคำค้น และเพิ่ม `@selection` ไว้บนสุดเมื่อ editor ที่ใช้งานอยู่มีการเลือกในไฟล์
        และคำค้นเป็นต้นคำของ `selection` (คำค้น `date.t` จึงไม่มี) แล้วส่ง `completions` กลับ
      ref: packages/extension/src/chat/context.ts#Mentions.completions
      emits: [completions]

    - id: chips
      lane: panel
      at: composer
      do: >-
        แผงแสดงรายการให้เลือก ผู้ใช้เลือก `src/date.test.ts` แล้ววางภาพด้วย Cmd-V ตัวจัดการ `paste` รับไฟล์จาก clipboard เป็นไฟล์แนบ
        ไฟล์ที่ใหญ่เกินหรืออ่านไม่ได้ถูกปฏิเสธพร้อมเหตุผลตั้งแต่ตรงนี้ (โฟลเดอร์ถูกปฏิเสธเมื่อลากหรือเลือกผ่าน "Attach file…")
      sees: >-
        ในช่องพิมพ์มีข้อความ `@src/date.test.ts` แถวเหนือช่องพิมพ์มีชิป mention ชื่อ `date.test.ts` และชิปรูปภาพที่วาง
        (แถว "Attach file…" ขึ้นบนสุดของรายการเฉพาะตอนพิมพ์ `@` เปล่า)
      ref: "packages/extension/src/chat/composer-attachments.ts#\"target.addEventListener('paste', (event) => {\""

    - id: send
      lane: user
      do: ผู้ใช้พิมพ์ "test นี้พังตามภาพ ช่วยดูหน่อย" แล้วกด Enter

    - id: submit
      lane: panel
      at: composer
      do: >-
        `submit()` โพสต์ `send` พร้อมข้อความและไฟล์แนบ (ภาพเป็นข้อมูล base64)
      ref: packages/extension/src/chat/webview.ts#submit
      emits: [send]

    - id: blocks
      lane: editor
      at: chat
      do: >-
        `Chat.send` เรียก `prompt()` ซึ่งส่ง `turn-start` ก่อน แล้วจึงแปลง mention เป็นบล็อก ACP ตอนสร้างคำขอ `session/prompt`:
        `@path` ที่เป็นไฟล์จริงเป็น `resource_link` (`@selection` เป็น `resource` ที่มีข้อความของบรรทัดที่เลือก)
        และไฟล์แนบเป็นบล็อก `image` ที่มี `ATTACHMENT_META`
      ref: "packages/extension/src/chat/chat.ts#\"const blocks = async () => [...(await this.mentions.blocks(text)), ...promptBlocks(attachments)];\""
      emits: [ATTACHMENT_META, turn-start]

    - id: bubble
      lane: panel
      at: rail
      alongside: true
      do: บับเบิลของผู้ใช้แสดงข้อความพร้อมชิปของไฟล์แนบ
      sees: บับเบิล "test นี้พังตามภาพ ช่วยดูหน่อย" พร้อมชิปรูปภาพ หัวข้อ "working"
      ref: packages/extension/src/chat/chat.ts#Chat.prompt

    - id: parse
      lane: server
      at: turns
      do: >-
        `runTurn` แยก mention และไฟล์แนบออกจากบล็อก ภาพเกินจำนวนหรือขนาดรวมที่รับได้ทำให้คำขอถูกปฏิเสธ (`invalidParams`)
        แล้ว `logPrompt` อ่านไฟล์ที่ mention ผ่าน editor และเก็บภาพลงที่เก็บไฟล์แนบของ session
      ref: packages/engine/src/serve.ts#logPrompt
      phase: starting
      fork:
        ask: ไฟล์ที่ mention ยังอยู่หรือไม่
        options:
          - id: ok
            label: อยู่
            steps:
              - lane: server
                at: turns
                do: >-
                  `logPrompt` บันทึก event `user` ที่มีข้อความ `context` (เนื้อไฟล์ที่ mention และกฎของโปรเจกต์ที่ตรงกับไฟล์นั้น)
                  และ `attachments` แล้ว `runTurn` เรียก `runAgent` ด้วย prompt ว่าง จึงไม่บันทึกซ้ำ
                ref: packages/engine/src/serve.ts#logPrompt
                emits: [user]
              - lane: loop
                at: drive
                do: >-
                  `drive` เห็นว่า log จบด้วย prompt ที่ผู้ใช้พิมพ์ จึงไม่บันทึกซ้ำ แล้วให้ UserPromptSubmit hooks อ่านก่อน
                  คำขอถัดไปมีเนื้อไฟล์และภาพอยู่ในข้อความของผู้ใช้
                ref: "packages/engine/src/drive.ts#\"} else if (isTyped(events.at(-1))) {\""
                goto: turn.text-answer
          - id: missing
            label: ถูกลบไปแล้ว
            steps:
              - lane: server
                at: turns
                do: >-
                  `contextItems` อ่านไฟล์ไม่พบ จึงโยน `MentionError` ซึ่ง `logPrompt` แปลงเป็นการปฏิเสธคำขอแบบ `invalidParams`
                  ("no such file: src/date.test.ts") ไม่มีอะไรถูกบันทึกลง log
                ref: packages/engine/src/mentions.ts#contextItems
                emits: [MentionError]
              - lane: editor
                at: chat
                do: >-
                  คำขอ `session/prompt` ถูกปฏิเสธ `prompt()` จึงส่ง action `error` ด้วยข้อความนั้น ตามด้วย `turn-end` สถานะ `failed`
                ref: "packages/extension/src/chat/chat.ts#\"this.dispatch({ type: 'turn-end', at: Date.now(), status: 'failed', usage: undefined });\""
                emits: [turn-end]
              - lane: panel
                at: rail
                do: แผงแสดงบล็อก error ใต้บับเบิล และ turn จบแบบล้มเหลว
                sees: >-
                  บล็อก error สีแดง "Invalid params: no such file: src/date.test.ts" หัวข้อ "failed" และท้าย turn ขึ้น "Failed"
                ref: packages/extension/src/chat/render.ts#errorBlock
                end: { turn: failed }
---

mention กับไฟล์แนบต่างกันที่ใครอ่านเนื้อหา

| | ส่วนขยายส่ง | engine ทำ |
| --- | --- | --- |
| `@path` | `resource_link` (แค่ที่อยู่) | อ่านไฟล์ผ่าน editor ตอนรับ prompt และแนบกฎของโปรเจกต์ที่ตรง |
| `@selection` | `resource` พร้อมข้อความที่เลือก | ใส่เลขบรรทัดแล้วเก็บเป็นบริบท |
| ไฟล์แนบ (ภาพ ไฟล์ข้อความ) | `image` หรือ `resource` พร้อม `ATTACHMENT_META` | เก็บลงที่เก็บไฟล์แนบของ session |

สิ่งที่ควรสังเกต

- **บริบทถูกแช่ไว้ใน log** เนื้อไฟล์ที่ mention ถูกบันทึกใน event `user` ตอนส่ง ไฟล์ที่เปลี่ยนทีหลังไม่ทำให้ prompt เดิมเปลี่ยน
  คำขอทุกครั้งต่อจากนี้จึงส่งไบต์เดิมและ prompt cache ไม่หลุด
- **ร่างที่มีไฟล์แนบส่งเป็น steer ไม่ได้** ระหว่าง turn ทำงาน ปุ่ม Send now ไม่ยอมส่งร่างที่มีไฟล์แนบหรือ mention
  ร่างนั้นต้องเข้าคิวรอจนกว่า turn จะจบ
- **ข้อความ error มีคำนำของ JSON-RPC** engine ปฏิเสธด้วย `invalidParams` ซึ่ง ACP SDK เติม "Invalid params:" หน้าข้อความ
  แผงแสดงข้อความนั้นตรงๆ ผู้ใช้จึงเห็นคำนำนี้ก่อนเหตุผลจริง
- **mention ที่ไม่ใช่ไฟล์ยังเป็นข้อความ** คำที่ขึ้นต้นด้วย `@` แต่ไม่ตรงกับไฟล์ใน workspace ถูกส่งเป็นข้อความธรรมดา
