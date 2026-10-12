---
title: "Model เรียก tool แล้วตอบ"
description: model ขออ่านไฟล์และค้นข้อความ harness รันทั้งสองพร้อมกัน ส่งผลกลับ แล้ว model ตอบจนจบ turn
tableOfContents: false
sidebar:
  order: 2
scenario:
  surface: vscode
  given:
    - เปิด Geno ในแผงแชตของ VS Code ในโหมด Ask
    - session นี้ไม่มี turn ทำงานอยู่ และไม่มี hook ที่ตั้งไว้
  trigger: >-
    ผู้ใช้ถามว่า "โปรเจกต์นี้รันเทสต์ด้วยอะไร" model ตัดสินใจว่าต้องดูไฟล์ก่อนตอบ
  covers: [turn.with-tools]
  related: [turn.text-answer, perm.ask-allow, tool.parallel-read-batch]
  steps:
    - use: prompt-starts-turn
      beat:
        title: "คุณถามว่าโปรเจกต์รันเทสต์ด้วยอะไร"
        text: >-
          คุณพิมพ์คำถามแล้วกด Enter แผงแชตแสดงข้อความของคุณทันที และปุ่ม Stop มาแทนปุ่ม Send
          Geno เปิด turn ใหม่และจดคำถามลงบันทึกของ session
        from: you
        to: panel
        sees: { kind: composer, state: working, header: working }

    - use: model-call
      beat:
        title: "Geno ส่งบทสนทนาให้ model"
        text: >-
          Geno ตรวจว่ายังไม่เกินจำนวนรอบและงบของ turn แล้วส่งบทสนทนาทั้งหมดไปให้ model
          พร้อมรายชื่อ tool ที่ model ขอใช้ได้
        from: engine
        to: model
        sees:
          kind: payload
          source: docs/results/real-usecases/runs/A06-read-not-cat/1/requests.jsonl#seq=4
          select: messages[-1].content[-1]

    - id: asks-tools
      lane: model
      beat:
        title: "Model บอกว่าจะดูก่อน แล้วขอ tool สองตัว"
        text: >-
          model ยังไม่ตอบทันที มันเขียนสั้นๆ ว่าจะดูไฟล์ก่อน แล้วขอใช้ tool สองตัว
          ตัวหนึ่งอ่าน `package.json` อีกตัวค้นหาคำว่า vitest ข้อความสั้นนั้นขึ้นในแชตของคุณ
        from: model
        to: engine
        sees:
          kind: payload
          source: docs/results/real-usecases/runs/A06-read-not-cat/1/session.jsonl#seq=4
          select: content
          highlight: ['[2].name', '[2].input']
      do: >-
        model เขียนข้อความสั้นๆ ว่าจะดูไฟล์ก่อน แล้วขอเรียก tool สองตัว: `read` ไฟล์ `package.json`
        และ `grep` หาคำว่า `vitest` จบคำตอบด้วย `stop_reason: tool_use`
      ref: "packages/engine/src/gateway.ts#\"stopReason: message.stop_reason,\""
      emits: [tool_use]

    - use: answer-streams
    - use: tool-call-opens
      beat:
        title: "แชตขึ้น tool call ทั้งสอง"
        text: >-
          Geno จัดสองคำขอไว้ในชุดเดียวกัน เพราะเป็นการอ่านที่ไม่แก้อะไรและไม่ต้องขอสิทธิ์
          แชตของคุณขึ้นสองขั้นใหม่พร้อมจุดหมุน
        from: engine
        to: panel
        sees: { kind: step, label: read package.json, status: running }

    - id: run
      lane: tool
      at: executor
      runs: 2
      beat:
        title: "ทั้งสองรันพร้อมกันบนเครื่องของคุณ"
        text: >-
          การอ่านไฟล์และการค้นหารันพร้อมกัน การอ่านไฟล์ใน workspace ที่ไม่ใช่ไฟล์ลับไม่ต้องถามคุณ
          และถ้าไฟล์เปิดค้างอยู่ใน editor Geno อ่านเนื้อหาที่ยังไม่บันทึกด้วย
        from: engine
        to: machine
      do: >-
        `read` กับ `grep` อยู่ในชุดเดียวกันจึงรันพร้อมกัน การอ่านใน workspace ที่ไม่ใช่ไฟล์ลับไม่ต้องขอสิทธิ์
        `read` อ่านผ่าน editor จึงได้เนื้อหาของ buffer ที่ยังไม่บันทึกด้วย
      ref: packages/engine/src/drive.ts#runTools

    - use: tool-result-returns
      beat:
        title: "ผลลัพธ์กลับมาที่แชต"
        text: >-
          Geno เก็บผลตามลำดับที่ model ขอ ไม่ใช่ลำดับที่เสร็จ ขั้นในแชตหยุดหมุน และผลลัพธ์พับอยู่ใต้แต่ละขั้น
        from: engine
        to: panel
        sees: { kind: step, label: read package.json, status: done, output: "\"test\": \"vitest run\"" }

    - use: model-call
      beat:
        title: "Geno ส่งผลลัพธ์ให้ model"
        text: >-
          Geno เรียก model อีกรอบ คราวนี้คำขอมีผลของ tool ทั้งสองต่อท้ายบทสนทนา
          ถ้าคุณพิมพ์ข้อความแทรกระหว่างที่ tool รัน ข้อความนั้นก็เข้ามาตรงนี้
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
          model อ่านผลทั้งสองแล้วตอบว่าโปรเจกต์ใช้ vitest คำตอบค่อยๆ ขึ้นในแชตของคุณระหว่างที่ model เขียน
        from: model
        to: engine
        sees: { kind: message, from: geno, text: "โปรเจกต์นี้รันเทสต์ด้วย vitest สคริปต์ test คือ vitest run", streaming: true }
      do: >-
        model อ่าน `tool_result` ทั้งสองบล็อก แล้ว stream คำตอบสุดท้ายว่าโปรเจกต์ใช้ vitest
        จบด้วย `stop_reason: end_turn`
      ref: "packages/engine/src/gateway.ts#\"stopReason: message.stop_reason,\""
      emits: [tool_result, end_turn]

    - use: answer-streams
    - use: turn-ends
      beat:
        title: "Turn จบ"
        text: >-
          model ไม่ขอ tool เพิ่ม Geno จึงจบ turn ปุ่ม Send กลับมาแทน Stop
          และท้ายคำตอบมีแถวสรุปรุ่น model จำนวน token และค่าใช้จ่าย
        from: engine
        to: panel
        sees: { kind: message, from: geno, text: "โปรเจกต์นี้รันเทสต์ด้วย vitest สคริปต์ test คือ vitest run", footer: [worked for 8s, claude-sonnet-4.5, 12.4k tokens, $0.02] }
---

turn ที่มี tool คือวงรอบเดิมของ [Model ตอบเป็นข้อความโดยไม่เรียก tool](/scenarios/turn/text-answer/) ที่วนซ้ำ:
เรียก model รัน tool แล้วเรียก model อีกครั้ง จน model จบด้วย `end_turn`
ในทัวร์นี้วนสองรอบ ช่องนับในแผงความคืบหน้าจึงขึ้นเป็นเรียก model 2 ครั้ง และรัน tool 2 ครั้ง (`read` กับ `grep` ในชุดเดียว)

สิ่งที่ควรสังเกต

- **ถ้ามี hook PreToolUse มันตัดสินทุก call ก่อน** แล้วการจัดชุดจึงเกิดขึ้น ในทัวร์นี้ไม่มี hook จึงจัดชุดทันที
  การอ่านสองตัวอยู่ในชุดเดียวกัน ถ้ามี `bash` อยู่ด้วย `bash` จะรันเป็นชุดของตัวเอง
- **ผลถูกบันทึกตามลำดับที่ model ขอ** ไม่ใช่ลำดับที่เสร็จ แผงแชตเห็นแต่ละขั้นเสร็จก่อนได้ แต่ log เรียงตามคำขอ
- **ครั้งที่สองที่เรียก model ผ่าน `deliver()` อีกครั้ง** ข้อความ steer ที่ผู้ใช้ส่งระหว่าง tool รันจะเข้ามาตรงนี้

ถ้าคำสั่งต้องขออนุญาตก่อนรัน ดู [โหมด Ask ขออนุญาตก่อนรันคำสั่ง](/scenarios/perm/ask-mode-bash-approval/)
