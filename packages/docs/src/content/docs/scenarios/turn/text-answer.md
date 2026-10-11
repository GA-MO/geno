---
title: ถามแล้วได้คำตอบเป็นข้อความ
description: ผู้ใช้ส่งคำถามหนึ่งข้อ โมเดลตอบเป็นข้อความโดยไม่เรียกเครื่องมือ แล้ว turn จบแบบ done
sidebar:
  order: 1
scenario:
  surface: vscode
  given:
    - เปิด Geno ในแผงแชตของ VS Code และ engine ทำงานอยู่แล้ว
    - session นี้ไม่มี turn ทำงานอยู่
  trigger: >-
    ผู้ใช้พิมพ์ "อธิบายฟังก์ชัน `loopStep` ให้หน่อย" แล้วกด Enter
  covers: [turn.text-answer]
  related: [turn.with-tools, mstop.no-reply-continue-retry, ctl.stop-while-streaming]
  steps:
    - use: prompt-starts-turn
    - use: model-call

    - id: answer
      lane: model
      do: >-
        โมเดลคิดก่อน (ความคิดไม่แสดงเป็นข้อความ) แล้ว stream คำตอบออกมาทีละส่วน
        จบด้วย `stop_reason: end_turn` โดยไม่ขอเรียกเครื่องมือ
      ref: "packages/engine/src/drive.ts#\"onText: (delta) => watcher.text(delta),\""
      emits: [end_turn]

    - use: answer-streams
    - use: turn-ends
---

turn นี้คือเส้นทางที่สั้นที่สุดของ Geno และทุกสถานการณ์อื่นแตกออกจากเส้นทางนี้
ลองสังเกตสามเรื่องระหว่างเดินทัวร์

- **ส่วนขยายกับ engine เป็นคนละ process** แผงแชตคุยกับ extension host ด้วย `postMessage`
  ส่วน extension host คุยกับ engine ด้วย ACP ผ่าน Unix socket ดังนั้นขั้นที่ข้ามคอลัมน์ VS Code กับเซิร์ฟเวอร์ engine
  คือข้อความ ACP เสมอ
- **`turn-start` เกิดก่อนติดต่อ engine** ผู้ใช้จึงเห็นข้อความของตัวเองทันที แม้ engine จะยังเปิดไม่เสร็จ
- **log คือเครื่องสถานะ** `loopStep` ไม่จำอะไรไว้เอง มันอ่าน log ทุกครั้งแล้วตัดสินใหม่
  ดูตารางการตัดสินใจได้ที่ [เครื่องสถานะของ turn](/concepts/turn-state-machine/)

เมื่อโมเดลขอเรียกเครื่องมือแทนการตอบทันที ทางจะแยกไปที่ [โมเดลเรียกเครื่องมือแล้วตอบ](/scenarios/turn/with-tools/)
