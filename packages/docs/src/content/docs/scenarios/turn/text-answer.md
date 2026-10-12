---
title: "Model ตอบเป็นข้อความโดยไม่เรียก tool"
description: ผู้ใช้ส่งคำถามหนึ่งข้อ โมเดลตอบเป็นข้อความโดยไม่เรียกเครื่องมือ แล้ว turn จบแบบ done
tableOfContents: false
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
      beat:
        title: "คุณพิมพ์คำถามแล้วกด Enter"
        text: >-
          คุณถามว่า "อธิบายฟังก์ชัน loopStep ให้หน่อย" แผงแชตแสดงข้อความของคุณทันที และปุ่ม Stop มาแทนปุ่ม Send Geno
          เปิด turn ใหม่และจดคำถามลงบันทึกของ session
        to: engine
        sees: { kind: composer, state: working, header: working }

    - use: model-call
      beat:
        title: "Geno ส่งบทสนทนาให้ model"
        text: >-
          Geno ตรวจว่ายังไม่เกินจำนวนรอบและงบของ turn แล้วส่งบทสนทนาทั้งหมดไปให้โมเดล พร้อมรายชื่อ tool ที่โมเดลใช้ได้
          ตัวอย่างนี้มาจาก run จริงที่ผู้ใช้ถามเป็นภาษาไทย
        to: model
        sees:
          kind: payload
          direction: request
          source: docs/results/real-usecases/runs/A20-thai-question/1/requests.jsonl#seq=4
          select: messages[-1]

    - id: answer
      lane: model
      beat:
        title: "Model คิดแล้วเขียนคำตอบ"
        text: >-
          โมเดลคิดก่อน ความคิดนั้นไม่ขึ้นเป็นข้อความในแชต แล้วเขียนคำตอบออกมาทีละส่วน มันจบด้วยสัญญาณ end_turn
          ซึ่งแปลว่าตอบเสร็จแล้วและไม่ขอใช้ tool
        sees:
          kind: payload
          direction: response
          source: docs/results/real-usecases/runs/A20-thai-question/1/session.jsonl#seq=18
          select: content
      do: >-
        โมเดลคิดก่อน (ความคิดไม่แสดงเป็นข้อความ) แล้ว stream คำตอบออกมาทีละส่วน
        จบด้วย `stop_reason: end_turn` โดยไม่ขอเรียกเครื่องมือ
      ref: "packages/engine/src/drive.ts#\"onText: (delta) => watcher.text(delta),\""
      emits: [end_turn]

    - use: answer-streams
      beat:
        title: "คำตอบค่อยๆ ขึ้นในแชต"
        text: >-
          แต่ละส่วนที่โมเดลเขียนวิ่งจาก engine ผ่าน VS Code ไปถึงแผงแชตทันที คุณจึงอ่านได้ก่อนโมเดลเขียนเสร็จ
          เมื่อเขียนจบ Geno บันทึกคำตอบพร้อม token และค่าใช้จ่ายลงบันทึกของ session
        from: engine
        to: panel
        sees: { kind: message, from: geno, text: loopStep อ่านบันทึกของ turn แล้วตัดสินว่าขั้นต่อไปคืออะไร, streaming: true }

    - use: turn-ends
      beat:
        title: "Turn จบ"
        text: >-
          โมเดลไม่ขออะไรเพิ่ม Geno จึงจบ turn ปุ่ม Send กลับมาแทน Stop และท้ายคำตอบมีแถวสรุปรุ่นโมเดล จำนวน token
          และค่าใช้จ่าย
        to: panel
        end: "Turn จบแบบ done"
        sees: { kind: message, from: geno, text: loopStep อ่านบันทึกของ turn แล้วตัดสินว่าขั้นต่อไปคืออะไร, footer: [ worked for 8s, claude-sonnet-4.5, 3.1k tokens, $0.01 ] }
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
