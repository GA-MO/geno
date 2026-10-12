---
title: "Agent loop"
description: ประกอบทุกชิ้นเข้าด้วยกัน เรียก model รัน tool ส่งผลกลับ แล้วเรียกอีก จนกว่า model จะจบ ผ่านการรันจริงที่เทสต์พัง แก้ แล้วรันเทสต์อีกรอบ
scenario:
  surface: cli
  given:
    - รันแบบ non-interactive ด้วย `gcode agent` บน qwen3.8-flash (การรันจริง A13 รอบที่ 1)
    - repo มี `src/duration.ts` ที่ยังเป็นแค่ stub และ `test/slug.test.ts` ที่พังอยู่ก่อนแล้ว
  trigger: >-
    ผู้ใช้สั่ง "Implement parseDuration in src/duration.ts so test/duration.test.ts passes."
  covers: [turn.test-fix-loop]
  related: [turn.with-tools, tool.parallel-read-batch, tool.bash-safe-runs, edit.applied-as-diff, cli.agent-run]
  steps:
    - id: ask
      lane: user
      beat:
        title: "คุณขอให้ทำ parseDuration จนเทสต์ผ่าน"
        text: >-
          คุณรัน `gcode agent` พร้อมคำสั่งหนึ่งประโยค loop ทั้งหมดรันใน process นี้ ไม่มีแผงแชต
          ข้อความของ model ออกทางเทอร์มินัล
        from: you
        to: panel
      do: ผู้ใช้รัน `gcode agent` พร้อมคำสั่ง
      phase: idle

    - id: setup
      lane: loop
      at: agent
      do: >-
        คำสั่ง `agent` อ่านแฟล็ก เปิด session ใหม่ ตั้งขีดจำกัด 40 ครั้งและ $0.40 และเปิดการรัน check หลัง `edit` เป็นค่าเริ่มต้น
      ref: packages/engine/src/agent.ts#agent
      phase: starting

    - id: record
      lane: loop
      at: drive
      do: >-
        `drive` บันทึก event `user` ลง log ของ session
      ref: "packages/engine/src/drive.ts#\"await record({ kind: 'user', seq: nextSeq(events), at: new Date().toISOString(), content: prompt });\""
      emits: [user]

    - use: model-call
      beat:
        title: "Geno ส่ง request แรกให้ model"
        text: >-
          loop เห็นว่ามี prompt ที่ยังไม่มีคำตอบ จึงเรียก model request มีข้อความเดียว:
          บริบทของ session ตามด้วยคำสั่งของคุณ
        from: engine
        to: model
        sees:
          kind: payload
          source: docs/results/real-usecases/runs/A13-fail-then-fix/1/requests.jsonl#seq=4
          select: messages[-1].content[-1]
          highlight: [text]

    - id: wants-reads
      lane: model
      beat:
        title: "Model ขออ่าน stub กับไฟล์เทสต์"
        text: >-
          model ยังไม่เขียนโค้ด มันบอกว่าจะดูก่อน แล้วขอ `read` สองไฟล์ในคำตอบเดียว จบด้วย `tool_use`
          ซึ่งแปลว่ารอผล
        from: model
        to: engine
        sees:
          kind: payload
          source: docs/results/real-usecases/runs/A13-fail-then-fix/1/session.jsonl#seq=4
          select: content
          highlight: ['[2].input', '[3].input']
      do: >-
        model ขอ `read` `src/duration.ts` และ `test/duration.test.ts` จบด้วย `stop_reason: tool_use`
      ref: "packages/engine/src/gateway.ts#\"stopReason: message.stop_reason,\""
      emits: [tool_use]

    - id: run-reads
      lane: tool
      at: executor
      runs: 2
      beat:
        title: "Geno อ่านสองไฟล์พร้อมกัน"
        text: >-
          การอ่านใน workspace ไม่แก้อะไร จึงไม่ต้องขอสิทธิ์และรันพร้อมกัน เทอร์มินัลพิมพ์บรรทัดของแต่ละ call
        from: engine
        to: machine
        sees: "> read src/duration.ts"
      do: >-
        `loopStep` ตัดสิน `run-tools` การอ่านสองตัวอยู่ในชุดเดียวกันจึงรันพร้อมกัน แล้วบันทึก `tool-result` ตามลำดับที่ model ขอ
      ref: packages/engine/src/drive.ts#runTools
      phase: running-tools
      emits: [tool-result]

    - use: model-call
      beat:
        title: "Geno ส่งเนื้อไฟล์ทั้งสองกลับให้ model"
        text: >-
          request ที่สองมีทุกอย่างของ request แรก คำตอบของ model และผลของ `read` ทั้งสองบล็อกต่อท้าย
          model เห็นเทสต์ครบจึงรู้ว่าต้องรองรับรูปแบบไหน
        from: engine
        to: model
        sees:
          kind: payload
          source: docs/results/real-usecases/runs/A13-fail-then-fix/1/requests.jsonl#seq=8
          select: messages[-1].content
          highlight: ['[0].tool_use_id', '[1].tool_use_id']
          collapse: ['[0].content', '[1].content']

    - id: wants-edit
      lane: model
      beat:
        title: "Model เขียน parseDuration ด้วย edit"
        text: >-
          model คิดอยู่พักหนึ่ง แล้วขอ `edit` ครั้งเดียวที่แทน stub ทั้งฟังก์ชันด้วยโค้ดใหม่
        from: model
        to: engine
        sees:
          kind: payload
          source: docs/results/real-usecases/runs/A13-fail-then-fix/1/session.jsonl#seq=8
          select: content[-1]
          highlight: [input.path, input.new_str]
      do: >-
        model ขอ `edit` ที่ `src/duration.ts` ด้วย `old_str` เป็น stub ทั้งก้อน จบด้วย `stop_reason: tool_use`
      ref: "packages/engine/src/gateway.ts#\"stopReason: message.stop_reason,\""
      emits: [tool_use]

    - id: edit
      lane: tool
      at: executor
      beat:
        title: "Geno แก้ไฟล์แล้วรันเทสต์ทั้งชุดเอง"
        text: >-
          `edit` สำเร็จ แล้ว Geno รันคำสั่ง check ของโปรเจกต์ต่อทันทีโดยไม่มีใครขอ เทสต์ทั้งชุดพัง
          เพราะ `slug.test.ts` ที่พังอยู่ก่อน ผลของ check ต่อท้ายผลของ `edit` ให้ model อ่าน
        from: engine
        to: machine
        sees:
          kind: payload
          source: docs/results/real-usecases/runs/A13-fail-then-fix/1/requests.jsonl#seq=11
          select: messages[-1].content[0]
          highlight: [content]
      do: >-
        `editExecutor` เขียนไฟล์ แล้ว `afterEdit` รัน check ของโปรเจกต์ (`node --test`) และต่อผลท้ายผลของ `edit`
      ref: packages/engine/src/tools/agent.ts#editExecutor
      emits: [tool-result]

    - id: headline
      lane: tool
      at: shell
      do: >-
        บรรทัดแรกของผล check เขียนด้วย `checkHeadline` เป็น "check `node --test` failed (exit 1)"
      ref: packages/core/src/tools.ts#checkHeadline

    - use: model-call
      beat:
        title: "ผลที่มีเทสต์พังกลับไปหา model"
        text: >-
          loop ไม่ได้ตัดสินว่าเทสต์พังแปลว่าอะไร มันแค่ส่งผลกลับและเรียก model อีกครั้ง
          การตีความเป็นหน้าที่ของ model
        from: engine
        to: model

    - id: wants-test
      lane: model
      beat:
        title: "Model รันเฉพาะเทสต์ของ duration"
        text: >-
          model สังเกตว่าเทสต์ที่พังอยู่ใน `slug.test.ts` ไม่ใช่ของงานนี้ มันจึงขอ `bash` รันเฉพาะ
          `test/duration.test.ts` และดู git status ไปด้วย
        from: model
        to: engine
        sees:
          kind: payload
          source: docs/results/real-usecases/runs/A13-fail-then-fix/1/session.jsonl#seq=11
          select: content[-1]
          highlight: [input.command, input.description]
      do: >-
        model ขอ `bash` ด้วย `node --test test/duration.test.ts; echo "exit=$?"; git status --short`
      ref: "packages/engine/src/gateway.ts#\"stopReason: message.stop_reason,\""
      emits: [tool_use]

    - id: judge
      lane: policy
      at: rules
      beat:
        title: "Geno ตรวจคำสั่งแล้วรันใน sandbox"
        text: >-
          ก่อนรัน `bash` Geno ตรวจคำสั่งกับกฎ ไม่มีกฎไหนจับคำสั่งนี้ จึงรันใน sandbox ที่เขียนได้แค่ใน workspace
          ทั้งสามเทสต์ของ duration ผ่าน
        from: engine
        to: machine
        sees:
          kind: payload
          source: docs/results/real-usecases/runs/A13-fail-then-fix/1/session.jsonl#seq=12
          highlight: [status, output]
          collapse: [timing]
      do: >-
        `ruledDenial` ไม่พบกฎที่จับคำสั่งนี้ คำสั่งจึงไม่ต้องถามใคร
      ref: packages/core/src/permission-rules.ts#ruledDenial

    - id: shell
      lane: tool
      at: shell
      do: >-
        `bash` รันคำสั่งใน sandbox แล้วบันทึกผลพร้อม `[exit code 0]`
      ref: "packages/engine/src/tools/agent.ts#\"tools.sandbox.run(command\""
      emits: [tool-result]

    - use: model-call
      beat:
        title: "Geno เรียก model เป็นครั้งที่สี่"
        text: >-
          ผลเทสต์ที่ผ่านกลับไปใน request ที่สี่ ซึ่งยังมีทุกอย่างตั้งแต่ request แรก
          ส่วนต้นอ่านจาก cache ได้ 11,085 token
        from: engine
        to: model

    - id: answer
      lane: model
      beat:
        title: "Model รายงานผลและบอกเทสต์ที่พังอยู่ก่อน"
        text: >-
          model ไม่ขอ tool เพิ่ม มันเขียนรายงานว่าแก้อะไร เทสต์ไหนผ่าน และบอกว่า `slug.test.ts`
          พังอยู่ก่อนแล้วจึงไม่ได้แตะ จบด้วย `end_turn`
        from: model
        to: engine
        sees:
          kind: payload
          source: docs/results/real-usecases/runs/A13-fail-then-fix/1/session.jsonl#seq=14
          select: content[-1]
          highlight: [text]
      do: >-
        model ตอบเป็นข้อความอย่างเดียว จบด้วย `stop_reason: end_turn`
      ref: "packages/engine/src/gateway.ts#\"stopReason: message.stop_reason,\""
      emits: [end_turn]

    - id: done
      lane: loop
      at: step
      beat:
        title: "Geno จบ turn"
        text: >-
          คำตอบล่าสุดจบด้วย `end_turn` และไม่มี tool ค้าง loop จึงจบ turn ทั้ง turn เรียก model สี่ครั้ง
          ใช้เงิน $0.0072 และแก้ไฟล์เดียว
        from: engine
        to: panel
        end: จบ turn
      do: >-
        `loopStep` ตัดสิน `done(end_turn)` `finish` พิมพ์ยอดใช้งานแล้วคืน exit code 0
      ref: packages/engine/src/drive.ts#finish
      emits: [end_turn]
      phase: ending

    - id: exit
      lane: panel
      at: terminal
      do: process จบด้วย exit code 0
      sees: "usage: ... แล้ว process จบด้วย exit code 0"
      ref: packages/engine/src/drive.ts#finish
      end: { turn: done, reason: end_turn }
---

## loop ทั้งหมดมีแค่นี้

ทัวร์ข้างบนเรียก model สี่ครั้ง ทุกครั้งเป็นวงเดียวกัน

```mermaid
flowchart TD
  A["อ่าน session log"] --> B{"loopStep:<br/>ขั้นต่อไปคืออะไร"}
  B -- "มี prompt หรือผลที่ยังไม่มีคำตอบ" --> C["สร้าง request จาก log<br/>แล้วเรียก model"]
  C --> D["บันทึกคำตอบลง log"]
  D --> A
  B -- "มี tool_use ที่ยังไม่มีผล" --> E["ตรวจสิทธิ์ แล้วรัน tool"]
  E --> F["บันทึกผลลง log"]
  F --> A
  B -- "end_turn หรือเกินงบ" --> G["จบ turn"]
```

ใน Geno วงนี้คือ `drive` ใน `packages/engine/src/drive.ts` กับ `loopStep` ใน `packages/core/src/loop.ts`
`loopStep` เป็นฟังก์ชันบริสุทธิ์: รับ log คืนขั้นต่อไป ไม่มีสถานะซ่อนในหน่วยความจำ
ผลคือ loop ที่ถูกขัดจังหวะ (Stop, engine ล่ม, หน้าต่าง reload) เดินต่อได้จาก log เดิม

## สามเรื่องที่ทัวร์นี้แสดง

- **model เป็นคนตัดสินว่าผลแปลว่าอะไร** loop ส่ง "check `node --test` failed" กลับไปเฉยๆ
  model อ่านแล้วแยกเองว่าเทสต์ที่พังไม่ใช่ของงานนี้ และเลือกรันเฉพาะเทสต์ที่เกี่ยว
- **harness เป็นคนทำทุกอย่างที่แตะเครื่อง** อ่านไฟล์ แก้ไฟล์ รัน check ตรวจคำสั่ง และรันใน sandbox
- **request โตขึ้นทุกรอบ แต่จ่ายเพิ่มไม่มาก** cache อ่านได้ 5,594 แล้ว 8,826 แล้ว 9,282 แล้ว 11,085 token
  ส่วนที่เขียนลง cache ใหม่แต่ละรอบคือสิ่งที่เพิ่งต่อท้าย (`usage` ของ event `assistant` seq 4, 8, 11, 14 ใน `session.jsonl`)

การ์ด request ในทัวร์นี้สร้างใหม่จาก session log ตอนเก็บผล (`requests.jsonl`) ส่วนการ์ดคำตอบและผลของ tool คือ event ที่ Geno บันทึกจริง

## อะไรทำให้ loop หยุด

loop หยุดเมื่อ `loopStep` คืน `done` เหตุผลมีไม่กี่แบบ: model ตอบจบ (`end_turn`) ครบ 40 ครั้งหรือเกินงบ $0.40
คุณกด Stop คุณปฏิเสธการ์ด หรือ error ที่ retry ไม่ได้ ดูทุกแบบในบท [Model หยุดแบบไหนบ้าง](/scenarios/#ch-3)

## ต่อในบทนี้

- [จาก output สู่หน้าจอ](/foundations/output-to-screen/) ถ้า turn นี้รันในแผงแชต แต่ละจังหวะจะขึ้นจออย่างไร
- [Memory และ context window](/foundations/memory-and-context/) เมื่อ loop วนนานจนบทสนทนายาวเกิน
