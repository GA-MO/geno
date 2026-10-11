---
title: โมเดลเรียกเครื่องมือแล้วตอบ
description: โมเดลขออ่านไฟล์และค้นข้อความ harness รันทั้งสองพร้อมกัน ส่งผลกลับ แล้วโมเดลตอบจนจบ turn
tableOfContents: false
sidebar:
  order: 2
scenario:
  surface: vscode
  given:
    - เปิด Geno ในแผงแชตของ VS Code ในโหมด Ask
    - session นี้ไม่มี turn ทำงานอยู่ และไม่มี hook ที่ตั้งไว้
  trigger: >-
    ผู้ใช้ถามว่า "โปรเจกต์นี้รันเทสต์ด้วยอะไร" โมเดลตัดสินใจว่าต้องดูไฟล์ก่อนตอบ
  covers: [turn.with-tools]
  related: [turn.text-answer, perm.ask-allow, tool.parallel-read-batch]
  steps:
    - use: prompt-starts-turn
    - use: model-call

    - id: asks-tools
      lane: model
      do: >-
        โมเดลเขียนข้อความสั้นๆ ว่าจะดูไฟล์ก่อน แล้วขอเรียกเครื่องมือสองตัว: `read` ไฟล์ `package.json`
        และ `grep` หาคำว่า `vitest` จบคำตอบด้วย `stop_reason: tool_use`
      ref: "packages/engine/src/gateway.ts#\"stopReason: message.stop_reason,\""
      emits: [tool_use]

    - use: answer-streams
    - use: tool-call-opens

    - id: run
      lane: tool
      at: executor
      do: >-
        `read` กับ `grep` อยู่ในชุดเดียวกันจึงรันพร้อมกัน การอ่านใน workspace ที่ไม่ใช่ไฟล์ลับไม่ต้องขอสิทธิ์
        `read` อ่านผ่าน editor จึงได้เนื้อหาของ buffer ที่ยังไม่บันทึกด้วย
      ref: packages/engine/src/tools/index.ts#runExecutor

    - use: tool-result-returns
    - use: model-call

    - id: final
      lane: model
      do: >-
        โมเดลอ่าน `tool_result` ทั้งสองบล็อก แล้ว stream คำตอบสุดท้ายว่าโปรเจกต์ใช้ vitest
        จบด้วย `stop_reason: end_turn`
      ref: "packages/engine/src/gateway.ts#\"stopReason: message.stop_reason,\""
      emits: [tool_result, end_turn]

    - use: answer-streams
    - use: turn-ends
---

turn ที่มีเครื่องมือคือวงรอบเดิมของ [ถามแล้วได้คำตอบเป็นข้อความ](/scenarios/turn/text-answer/) ที่วนซ้ำ:
เรียกโมเดล รันเครื่องมือ แล้วเรียกโมเดลอีกครั้ง จนโมเดลจบด้วย `end_turn`
ในทัวร์นี้วนสองรอบ ช่องนับในแผงความคืบหน้าจึงขึ้นเป็นเรียกโมเดล 2 ครั้ง และรันเครื่องมือ 1 ชุด

สิ่งที่ควรสังเกต

- **PreToolUse ตัดสินทุก call ก่อน** แล้วการจัดชุดจึงเกิดขึ้น การอ่านสองตัวจึงอยู่ในชุดเดียวกัน
  ถ้ามี `bash` อยู่ด้วย `bash` จะรันเป็นชุดของตัวเอง
- **ผลถูกบันทึกตามลำดับที่โมเดลขอ** ไม่ใช่ลำดับที่เสร็จ แผงแชตเห็นแต่ละขั้นเสร็จก่อนได้ แต่ log เรียงตามคำขอ
- **ครั้งที่สองที่เรียกโมเดลผ่าน `deliver()` อีกครั้ง** ข้อความ steer ที่ผู้ใช้ส่งระหว่างเครื่องมือรันจะเข้ามาตรงนี้

ถ้าคำสั่งต้องขออนุญาตก่อนรัน ดู [โหมด Ask ขออนุญาตก่อนรันคำสั่ง](/scenarios/perm/ask-mode-bash-approval/)
