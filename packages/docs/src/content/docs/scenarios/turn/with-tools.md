---
title: "Model เรียก tool แล้วตอบ"
description: model ขอ tool สามตัวเพื่อดูไฟล์ในโปรเจกต์ Geno รันทั้งสามพร้อมกันบนเครื่องของคุณ ส่งผลกลับ แล้ว model ตอบจนจบ turn
scenario:
  surface: vscode
  given:
    - เปิด Geno ในแผงแชตของ VS Code ในโหมด Ask
    - session นี้ไม่มี turn ทำงานอยู่ และไม่มี hook ที่ตั้งไว้
  trigger: >-
    ผู้ใช้ขอว่า "บอก script ใน package.json รายชื่อไฟล์ใน src และไฟล์เทสต์ที่มีอยู่" model ตัดสินใจว่าต้องดูไฟล์ก่อนตอบ
  covers: [turn.with-tools]
  related: [turn.text-answer, perm.ask-allow, tool.parallel-read-batch]
  steps:
    - use: prompt-starts-turn
      beat:
        title: "คุณถามเรื่อง script ไฟล์ และเทสต์ของโปรเจกต์"
        text: >-
          คุณพิมพ์คำขอแล้วกด Enter แผงแชตแสดงข้อความของคุณทันที และปุ่ม Stop มาแทนปุ่ม Send
          Geno เปิด turn ใหม่ turn คือทุกอย่างตั้งแต่คุณส่งข้อความหนึ่งข้อจนคำตอบจบ แล้ว Geno จดคำขอลงบันทึกของ session
        from: you
        to: panel
        sees: { kind: composer, state: working, header: working }

    - use: model-call
      beat:
        title: "Geno ส่งบทสนทนาให้ model"
        text: >-
          Geno ตรวจว่ายังไม่เกินงบของ turn (จำนวนครั้งที่เรียก model และค่าใช้จ่าย) แล้วส่งบทสนทนาทั้งหมดไปให้ model
          พร้อมรายชื่อ tool ที่ model ขอใช้ได้ การ์ดคือบล็อกสุดท้ายของคำขอ ซึ่งเป็นคำขอของคุณตามที่พิมพ์ในการรันจริง (ภาษาอังกฤษ)
        from: engine
        to: model
        sees:
          kind: payload
          source: docs/results/real-usecases/runs/A06-read-not-cat/1/requests.jsonl#seq=4
          select: messages[-1].content[-1]

    - id: asks-tools
      lane: model
      beat:
        title: "Model บอกว่าจะดูก่อน แล้วขอ tool สามตัว"
        text: >-
          model ยังไม่ตอบทันที มันเขียนสั้นๆ ว่าจะดูไฟล์ก่อน แล้วขอใช้ tool สามตัว `read` อ่าน `package.json`
          `list` ดูรายชื่อไฟล์ใน `src` และ `glob` หาไฟล์เทสต์ ข้อความสั้นนั้นขึ้นในแชตของคุณ
          ในการ์ด บล็อก `thinking` แรกคือความคิดของ model ซึ่งไม่ขึ้นในแชต แต่ละคำขอคือบล็อก `tool_use` ดู `name` (tool ที่ขอ) และ `input` (argument) ส่วน `id` ใช้จับคู่กับผลทีหลัง
          คำตอบนี้จบด้วย `stop_reason` ค่า `tool_use` แปลว่า model รอผลของ tool ยังไม่จบ
        from: model
        to: engine
        sees:
          kind: payload
          source: docs/results/real-usecases/runs/A06-read-not-cat/1/session.jsonl#seq=4
          select: content
          highlight: ['[2].name', '[2].input']
      do: >-
        model เขียนข้อความสั้นๆ ว่าจะดูไฟล์ก่อน แล้วขอเรียก tool สามตัว: `read` ไฟล์ `package.json`
        `list` โฟลเดอร์ `src` และ `glob` หาไฟล์เทสต์ จบคำตอบด้วย `stop_reason: tool_use`
      ref: "packages/engine/src/gateway.ts#\"stopReason: message.stop_reason,\""
      emits: [tool_use]

    - use: answer-streams
    - use: tool-call-opens
      beat:
        title: "แชตขึ้น tool call ทั้งสาม"
        text: >-
          Geno จัดสามคำขอไว้ในชุดเดียวกัน ชุดคือกลุ่มของ call ที่รันพร้อมกันได้ ทั้งสามเป็นการอ่านที่ไม่แก้อะไรและไม่ต้องขอสิทธิ์
          แชตของคุณขึ้นสามขั้นใหม่พร้อมจุดหมุน
        from: engine
        to: panel
        sees: { kind: step, label: read package.json, status: running }

    - id: run
      lane: tool
      at: executor
      runs: 3
      beat:
        title: "ทั้งสามรันพร้อมกันบนเครื่องของคุณ"
        text: >-
          การอ่านไฟล์ การดูรายชื่อไฟล์ และการหาไฟล์รันพร้อมกัน การอ่านใน workspace (โฟลเดอร์ที่คุณเปิด) ที่ไม่ใช่ไฟล์ลับไม่ต้องถามคุณ
          และถ้าไฟล์เปิดค้างอยู่ใน editor `read` อ่านเนื้อหาที่ยังไม่บันทึกด้วย
        from: engine
        to: machine
      do: >-
        `read` `list` และ `glob` อยู่ในชุดเดียวกันจึงรันพร้อมกัน การอ่านใน workspace ที่ไม่ใช่ไฟล์ลับไม่ต้องขอสิทธิ์
        `read` อ่านผ่าน editor จึงได้เนื้อหาของ buffer ที่ยังไม่บันทึกด้วย
      ref: packages/engine/src/drive.ts#runTools

    - use: tool-result-returns
      beat:
        title: "ผลลัพธ์กลับมาที่แชต"
        text: >-
          Geno เก็บผลตามลำดับที่ model ขอ ไม่ใช่ลำดับที่เสร็จ ขั้นในแชตหยุดหมุน และผลลัพธ์พับอยู่ใต้แต่ละขั้น
        from: engine
        to: panel
        sees: { kind: step, label: read package.json, status: done, output: "\"test\": \"node --test\"" }

    - use: model-call
      beat:
        title: "Geno ส่งผลลัพธ์ให้ model"
        text: >-
          Geno เรียก model อีกครั้ง คราวนี้คำขอมีผลของ tool ทั้งสามต่อท้ายบทสนทนา ในการ์ด ผลแต่ละตัวคือบล็อก `tool_result`
          ที่ `tool_use_id` ตรงกับ `id` ของคำขอในการ์ดก่อน model จึงรู้ว่าผลไหนตอบคำขอไหน
          ถ้าคุณพิมพ์ข้อความแทรก (steer) ระหว่างที่ tool รัน ข้อความนั้นก็เข้ามาตรงนี้
        from: engine
        to: model
        sees:
          kind: payload
          source: docs/results/real-usecases/runs/A06-read-not-cat/1/requests.jsonl#seq=9
          select: messages[-1].content
          highlight: ['[0].tool_use_id']
          collapse: ['[0].content']

    - id: final
      lane: model
      beat:
        title: "Model เขียนคำตอบ"
        text: >-
          model อ่านผลทั้งสามแล้วตอบว่า script เดียวคือ `test` ซึ่งรัน `node --test` และบอกรายชื่อไฟล์ คำตอบค่อยๆ ขึ้นในแชตระหว่างที่ model เขียน
          การ์ดข้างล่างเป็นคำตอบจริงของ model ต่อคำขอก่อนหน้า มีบล็อก `thinking` (ไม่ขึ้นในแชต) กับบล็อก `text` และไม่มี `tool_use` จึงจบด้วย `end_turn`
        from: model
        to: engine
        sees:
          - { kind: message, from: geno, text: "script เดียวคือ test ซึ่งรัน node --test มีไฟล์ใน src ห้าไฟล์ และไฟล์เทสต์สามไฟล์", streaming: true }
          - kind: payload
            source: docs/results/real-usecases/runs/A06-read-not-cat/1/session.jsonl#seq=9
            select: content
            collapse: ['[0].thinking']
            highlight: ['[1]']
            quote: "- `src/config.ts`"
      do: >-
        model อ่าน `tool_result` ทั้งสามบล็อก แล้ว stream คำตอบสุดท้ายว่า script `test` รัน `node --test`
        จบด้วย `stop_reason: end_turn`
      ref: "packages/engine/src/gateway.ts#\"stopReason: message.stop_reason,\""
      emits: [tool_result, end_turn]

    - use: answer-streams
    - use: turn-ends
      beat:
        title: "Turn จบ"
        text: >-
          model ไม่ขอ tool เพิ่ม Geno จึงจบ turn ปุ่ม Send กลับมาแทน Stop หัวข้อเปลี่ยนเป็น "worked for" ตามด้วยเวลาที่ใช้
          ท้ายคำตอบมีแถวสรุปรุ่น model จำนวน token ขาเข้า (in) และขาออก (out) รวมทั้งสองครั้งที่เรียก model และค่าใช้จ่าย
          ตัวเลขในภาพมาจากการรันเดียวกับการ์ด
        from: engine
        to: panel
        sees: { kind: message, from: geno, text: "script เดียวคือ test ซึ่งรัน node --test มีไฟล์ใน src ห้าไฟล์ และไฟล์เทสต์สามไฟล์", footer: [qwen3.8-flash, 18k in, 310 out, $0.0030] }
---

turn ที่มี tool คือวงรอบเดิมของ [Model ตอบเป็นข้อความโดยไม่เรียก tool](/scenarios/turn/text-answer/) ที่วนซ้ำ:
เรียก model รัน tool แล้วเรียก model อีกครั้ง จน model จบด้วย `end_turn`
ในทัวร์นี้วนสองรอบ turn นี้จึงเรียก model 2 ครั้ง และรัน tool 3 ครั้ง (`read` `list` และ `glob` ในชุดเดียว)

สิ่งที่ควรสังเกต

- **ถ้ามี [hook](/start/glossary/) PreToolUse มันตัดสินทุก call ก่อน** แล้วการจัดชุดจึงเกิดขึ้น ในทัวร์นี้ไม่มี hook จึงจัดชุดทันที
  การอ่านทั้งสามตัวอยู่ในชุดเดียวกัน ถ้ามี `bash` อยู่ด้วย `bash` จะรันเป็นชุดของตัวเอง
- **ผลถูกบันทึกตามลำดับที่ model ขอ** ไม่ใช่ลำดับที่เสร็จ แผงแชตเห็นแต่ละขั้นเสร็จก่อนได้ แต่ log เรียงตามคำขอ
- **ครั้งที่สองที่เรียก model ผ่าน `deliver()` อีกครั้ง** `deliver()` คือจุดก่อนเรียก model ที่ Geno รับของที่มาถึงระหว่างทาง
  ข้อความ [steer](/start/glossary/) ที่ผู้ใช้ส่งระหว่าง tool รันจะเข้ามาตรงนี้

ถ้าคำสั่งต้องขออนุญาตก่อนรัน ดู [โหมด Ask ขออนุญาตก่อนรันคำสั่ง](/scenarios/perm/ask-mode-bash-approval/)
