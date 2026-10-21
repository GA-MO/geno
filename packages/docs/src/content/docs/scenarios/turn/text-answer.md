---
title: "Model ตอบเป็นข้อความโดยไม่เรียก tool"
description: ผู้ใช้ส่งคำถามหนึ่งข้อ model ตอบเป็นข้อความโดยไม่เรียก tool แล้ว turn จบแบบ done
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
          เปิด turn ใหม่ turn คือทุกอย่างตั้งแต่คุณส่งคำถามหนึ่งข้อจนคำตอบจบ แล้ว Geno จดคำถามลงบันทึกของ session
        from: you
        to: panel
        sees: { kind: composer, state: working, header: working }

    - use: model-call
      beat:
        title: "Geno ส่งบทสนทนาให้ model"
        text: >-
          Geno ตรวจว่ายังไม่เกินงบของ turn (จำนวนครั้งที่เรียก model และค่าใช้จ่าย) แล้วส่งบทสนทนาทั้งหมดไปให้ model
          พร้อมรายชื่อ tool ที่ model ขอใช้ได้ (tool คือคำสั่งที่ model ขอให้ Geno ทำแทน เช่นอ่านไฟล์) การ์ดมาจากการรันจริงที่ผู้ใช้ถามอีกคำถามเป็นภาษาไทย ดูบล็อก `text` อันสุดท้าย
          นั่นคือคำถามของผู้ใช้ บล็อกก่อนหน้าคือสิ่งที่ Geno แนบไว้ในข้อความแรกของแชต เช่นไฟล์คำสั่งของคุณและข้อมูลเครื่อง
        from: engine
        to: model
        sees:
          kind: payload
          source: docs/results/real-usecases/runs/A20-thai-question/1/requests.jsonl#seq=4
          select: messages[-1]

    - id: answer
      lane: model
      beat:
        title: "Model คิดแล้วเขียนคำตอบ"
        text: >-
          model คิดก่อน แล้วเขียนคำตอบออกมาทีละส่วน มันจบด้วย `stop_reason` ค่า `end_turn` ซึ่งแปลว่าตอบเสร็จแล้วและไม่ขอใช้ tool
          ในการ์ด บล็อก `thinking` คือความคิด ซึ่งไม่ขึ้นในแชต บล็อก `text` คือคำตอบที่คุณเห็น ไม่มีบล็อก `tool_use` ที่ขอใช้ tool
          การ์ดนี้เป็นคำตอบสุดท้ายของการรันจริงเดียวกับการ์ดก่อน ซึ่ง model อ่านไฟล์ไปก่อนแล้ว คำตอบจึงพูดถึงไฟล์ได้
        from: model
        to: engine
        sees:
          kind: payload
          source: docs/results/real-usecases/runs/A20-thai-question/1/session.jsonl#seq=18
          select: content
      do: >-
        model คิดก่อน (ความคิดไม่แสดงเป็นข้อความ) แล้ว stream คำตอบออกมาทีละส่วน
        จบด้วย `stop_reason: end_turn` โดยไม่ขอเรียก tool
      ref: "packages/engine/src/drive.ts#\"onText: (delta) => watcher.text(delta),\""
      emits: [end_turn]

    - use: answer-streams
      beat:
        title: "คำตอบค่อยๆ ขึ้นในแชต"
        text: >-
          แต่ละส่วนที่ model เขียนวิ่งจาก engine ผ่าน VS Code ไปถึงแผงแชตทันที คุณจึงอ่านได้ก่อน model เขียนเสร็จ
          เมื่อเขียนจบ Geno บันทึกคำตอบพร้อมจำนวน token (หน่วยนับข้อความที่ผู้ให้บริการใช้คิดเงิน) และค่าใช้จ่ายลงบันทึกของ session
        from: engine
        to: panel
        sees: { kind: message, from: geno, text: loopStep อ่านบันทึกของ turn แล้วตัดสินว่าขั้นต่อไปคืออะไร, streaming: true }

    - use: turn-ends
      beat:
        title: "Turn จบ"
        text: >-
          model ไม่ขออะไรเพิ่ม Geno จึงจบ turn ปุ่ม Send กลับมาแทน Stop หัวข้อเปลี่ยนเป็น "worked for" ตามด้วยเวลาที่ใช้
          และท้ายคำตอบมีแถวสรุปรุ่น model จำนวน token ขาเข้า (in) จำนวน token ขาออก (out) และค่าใช้จ่าย
        from: engine
        to: panel
        end: "Turn จบแบบ done"
        sees: { kind: message, from: geno, text: loopStep อ่านบันทึกของ turn แล้วตัดสินว่าขั้นต่อไปคืออะไร, footer: [ qwen3.8-flash, "<token ขาเข้า> in", "<token ขาออก> out", "$<ค่าใช้จ่าย>" ] }
---

turn นี้คือเส้นทางที่สั้นที่สุดของ Geno และทุกสถานการณ์อื่นแตกออกจากเส้นทางนี้
ลองสังเกตสามเรื่องระหว่างเดินทัวร์

- **ส่วนขยายกับ engine เป็นคนละ process** แผงแชตคุยกับ [extension host](/start/glossary/) ด้วย `postMessage`
  ส่วน extension host คุยกับ engine ด้วย [ACP](/start/glossary/) ผ่าน [Unix socket](/start/glossary/) ดังนั้นขั้นที่ข้ามคอลัมน์ VS Code กับเซิร์ฟเวอร์ engine
  คือข้อความ ACP เสมอ
- **`turn-start` เกิดก่อนติดต่อ engine** `turn-start` คือคำสั่งที่ extension ส่งให้แผงวาด turn ใหม่
  ผู้ใช้จึงเห็นข้อความของตัวเองทันที แม้ engine จะยังเปิดไม่เสร็จ
- **log คือเครื่องสถานะ** `loopStep` ไม่จำอะไรไว้เอง มันอ่าน log ทุกครั้งแล้วตัดสินใหม่
  ดูตารางการตัดสินใจได้ที่ [เครื่องสถานะของ turn](/concepts/turn-state-machine/)

เมื่อ model ขอเรียก tool แทนการตอบทันที ทางจะแยกไปที่ [Model เรียก tool แล้วตอบ](/scenarios/turn/with-tools/)
