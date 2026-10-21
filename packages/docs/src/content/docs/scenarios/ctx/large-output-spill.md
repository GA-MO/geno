---
title: "ผลของ tool ยาวเกิน Geno เขียนลงไฟล์"
description: คำสั่งพิมพ์ผลออกมายาวเกินขีดของ model Geno เก็บทั้งหมดลงไฟล์ ส่งให้ model แค่ต้น ท้าย และที่อยู่ไฟล์ แล้ว model อ่านเฉพาะส่วนที่ต้องการ
scenario:
  surface: vscode
  given:
    - เปิด Geno ในแผงแชตของ VS Code มี turn ทำงานอยู่
    - model ขอรัน `bash` ด้วยคำสั่ง `pnpm test` ซึ่งอยู่ใน safe list จึงไม่ต้องขออนุญาต
  trigger: >-
    เทสต์ล้มหลายตัว คำสั่งพิมพ์ผลออกมาประมาณ 80,000 ตัวอักษร
  covers: [ctx.large-output-spill]
  related: [ctx.compaction-auto, tool.bash-safe-runs, ext.mcp-tool-call]
  steps:
    - use: tool-call-opens
      beat:
        title: "Geno เปิดขั้น pnpm test ในแชต"
        text: >-
          model ขอรัน `pnpm test` ซึ่งอยู่ในรายการคำสั่งปลอดภัย จึงไม่ต้องถามคุณ แชตขึ้นขั้นใหม่พร้อมจุดหมุน
        from: engine
        to: panel
        sees: { kind: step, label: pnpm test, status: running }

    - id: run
      lane: tool
      at: shell
      beat:
        title: "เทสต์ล้มหลายตัว ผลยาว 80,000 ตัวอักษร"
        text: >-
          `pnpm test` รันใน sandbox คือกรอบของระบบปฏิบัติการที่จำกัดว่าคำสั่งเขียนไฟล์และต่อเครือข่ายได้แค่ไหน
          เทสต์ล้มหลายตัว และพิมพ์ผลออกมาประมาณ 80,000 ตัวอักษร
        from: engine
        to: machine
      do: >-
        `bash` รัน `pnpm test` ใน sandbox ได้ข้อความผลลัพธ์ยาวประมาณ 80,000 ตัวอักษร ปิดท้ายด้วยบรรทัด `[exit code 1]`
      ref: "packages/engine/src/tools/agent.ts#\"tools.sandbox.run(command\""

    - id: settle
      lane: loop
      at: tools
      beat:
        title: "Geno เก็บผลทั้งหมดลงไฟล์"
        text: >-
          Geno มีขีดความยาวของผล tool ที่ส่งให้ model ได้ในครั้งเดียว ตั้งตาม model ค่าตั้งต้น 24,000 ตัวอักษร
          ผลนี้ยาวกว่า Geno จึงทำ spill คือเขียนทั้งหมดลงไฟล์ในโฟลเดอร์ของตัวเอง แล้วเก็บไว้แค่
          2,000 ตัวอักษรแรก 2,000 ตัวอักษรท้าย ขนาด และที่อยู่ไฟล์
        from: engine
        to: engine
      do: >-
        ก่อนบันทึกผล `settle` เทียบความยาวกับ `spillChars` ของ model (ค่าเริ่มต้น 24,000 ตัวอักษร)
        ยาวกว่าจึงเขียนข้อความทั้งหมดลงไฟล์ `spill/<session>/<seq>-bash.txt` ในโฟลเดอร์ของ Geno
        แล้วเก็บแค่ 2,000 ตัวอักษรแรก 2,000 ตัวอักษรท้าย ขนาด และที่อยู่ไฟล์
      ref: packages/engine/src/tools/spill.ts#settle
      emits: [spill]

    - use: tool-result-returns
      beat:
        title: "ผลกลับมาที่แชต"
        text: >-
          ขั้นของ `pnpm test` หยุดหมุน ผลพับอยู่ข้างใต้
        from: engine
        to: panel

    - id: notice
      lane: panel
      at: rail
      beat:
        title: "คุณเห็นสิ่งเดียวกับที่ model ได้"
        text: >-
          เมื่อเปิดผลของขั้นนั้น คุณเห็นประกาศว่าผลถูกเก็บลงไฟล์ ตามด้วยต้นและท้ายของผล
        from: panel
        to: you
        sees: { kind: step, label: pnpm test, status: done, output: "[The output was 80412 bytes, too long to show. The full text is in .../spill/<session>/12-bash.txt; read it with start_line and end_line to see more.]" }
      do: >-
        เมื่อผู้ใช้เปิดผลของขั้นนั้น จะเห็นข้อความเดียวกับที่ model ได้รับ คือประกาศว่าผลถูกเก็บลงไฟล์ ตามด้วยต้นและท้ายของผล
      sees: >-
        "[The output was 80412 bytes, too long to show. The full text is in .../spill/<session>/12-bash.txt;
        read it with start_line and end_line to see more.]" ตามด้วย "--- first 2000 characters ---" และ "--- last 2000 characters ---"
      ref: packages/core/src/tools.ts#spillNotice

    - use: model-call
      beat:
        title: "Geno ส่งต้นและท้ายของผลให้ model"
        text: >-
          คำขอถัดไปมีแค่ประกาศ ต้น และท้ายของผล ไม่ใช่ทั้ง 80,000 ตัวอักษร การ์ดด้านล่างมาจาก run จริงบน `qwen3.8-flash` (ขีด 24,000 ตัวอักษร)
          ที่ model สั่ง `bash` ให้ `cat` ไฟล์ทุกไฟล์ในโฟลเดอร์ออกมา ไม่ใช่ `pnpm test` แต่ประกาศมีรูปเดียวกันทุกคำสั่ง
          ดู `content` ที่ไฮไลต์ในบล็อก `tool_result` (บล็อกที่ส่งผลของ tool กลับให้ model)
          มันขึ้นต้นด้วย `[The output was 88719 bytes, too long to show. The full text is in ...` (แท็บแรก)
          แล้วจึงเป็นต้นของผลหลังบรรทัด `--- first 2000 characters ---` (แท็บสอง) และท้ายของผลหลังบรรทัด `--- last 2000 characters ---` (แท็บสาม)
          ทั้งสามแท็บคือ `content` อันเดียวกัน แต่ละแท็บแสดงคนละช่วง
          ประกาศนับขนาดเป็นไบต์ ส่วนขีดที่ตัดสินว่าจะ spill นับเป็นตัวอักษร
        from: engine
        to: model
        sees:
          - kind: payload
            source: docs/results/real-usecases/runs/A16-compaction-goal/2/requests.jsonl.gz#seq=11
            select: messages[-1].content[0]
            highlight:
              - content
            quote: "[The output was 88719 bytes"
          - kind: payload
            source: docs/results/real-usecases/runs/A16-compaction-goal/2/requests.jsonl.gz#seq=11
            select: messages[-1].content[0]
            highlight:
              - content
            quote: '--- first 2000 characters ---'
          - kind: payload
            source: docs/results/real-usecases/runs/A16-compaction-goal/2/requests.jsonl.gz#seq=11
            select: messages[-1].content[0]
            highlight:
              - content
            quote: '--- last 2000 characters ---'

    - id: reads
      lane: model
      beat:
        title: "Model ขออ่านเฉพาะช่วงที่ต้องการ"
        text: >-
          model เห็นสรุปเทสต์ที่ล้มในส่วนท้าย จึงขออ่านไฟล์นั้นทีละช่วงด้วยเลขบรรทัด เช่นบรรทัด 1 ถึง 160
          ใน run จริงที่ `bash` spill model ไม่ได้อ่านไฟล์ต่อ การ์ดข้างล่างจึงเป็นคำตอบจริงจากการรันอื่นที่ผลของ `skill` ยาวราว 25,600 ไบต์ถูก spill
          การรันนั้นเกิดก่อน Geno ให้ `skill` ได้ถึง 100,000 ตัวอักษร วันนี้ผล `skill` ขนาดนี้กลับมาทั้งก้อน ไม่ spill แล้ว
          แต่การ์ดยังแสดงรูปของการอ่านได้ถูก เพราะ tool ใดที่ผลยาวเกินขีดของตัวเองก็ได้ประกาศและไฟล์แบบเดียวกัน
          model ขอ `read` ไฟล์ spill ด้วย `start_line` และ `end_line` ดู `input` ที่ไฮไลต์ path ลงท้ายด้วย `spill/.../13-skill.txt` และขอบรรทัด 1 ถึง 160
        from: model
        to: engine
        sees:
          kind: payload
          source: docs/results/real-usecases/runs/A19-poteto-thai/1/session.jsonl#seq=17
          select: content
          collapse: ['[0].thinking']
          highlight: ['[2].input']
      do: >-
        `tool_result` ที่ model ได้รับมาจาก `toolResultText`: ประกาศ ต้น และท้ายของผล model เห็นสรุปเทสต์ที่ล้มในส่วนท้าย
        จึงขอเรียก `read` ไฟล์ spill ด้วย `start_line` และ `end_line` เฉพาะช่วงของเทสต์ตัวแรกที่ล้ม
      ref: packages/core/src/session.ts#toolResultText
      emits: [tool_use]

    - id: allowed
      lane: tool
      at: executor
      beat:
        title: "Geno ให้อ่านไฟล์นั้นโดยไม่ถาม"
        text: >-
          ไฟล์อยู่นอก workspace แต่เป็นโฟลเดอร์ของ session นี้ที่อ่านได้ การอ่านจึงผ่านโดยไม่ต้องขออนุญาต
          และได้เฉพาะบรรทัดที่ขอ
        from: engine
        to: machine
        end: "model อ่านทีละช่วง"
      do: >-
        `read` ตรวจ path ด้วย `resolveInside` โฟลเดอร์ spill ของ session นี้อยู่นอก workspace แต่เป็นที่ที่อ่านได้
        การอ่านจึงผ่านโดยไม่ต้องขออนุญาต และได้เฉพาะบรรทัดที่ขอ
      ref: packages/engine/src/tools/context.ts#resolveInside
      phase: running-tools
      end: { turn: continues }
---

ผลที่ยาวเกินไม่ถูกตัดทิ้ง และไม่ถูกส่งทั้งก้อนเข้า context ข้อความเต็มอยู่ในไฟล์ model เลือกอ่านส่วนที่ต้องการเอง
ทำให้ผลก้อนเดียวไม่ดัน context จนต้อง [สรุปบริบท](/scenarios/ctx/compaction-auto/)

สิ่งที่ควรสังเกต

- **ขีดเป็นของ model ไม่ใช่ของ tool** `spillChars` มาจาก `capabilitiesOf(provider, model)` ทุก tool ใช้ขีดเดียวกัน
  ยกเว้น `skill` ที่ได้ถึง 100,000 ตัวอักษร เพราะสกิลที่ถูกตัดทำให้ model ต้องอ่านคำสั่งของตัวเองเป็นท่อนๆ
- **ผลจาก tool ของ [MCP](/start/glossary/) มีคำแนะนำเพิ่ม** `toolResultText` ต่อท้ายด้วย `MCP_SPILL_NOTE` ให้ model ลองเรียก tool ใหม่
  ด้วย filter หรือหน้าที่แคบลงก่อนจะอ่านไฟล์ทั้งไฟล์
- **การตัดสินเกิดหลัง PostToolUse hook** [hook](/start/glossary/) คือคำสั่ง shell ที่คุณตั้งให้รันหลัง tool จบ มันเห็นข้อความเต็มก่อนจะถูกเขียนลงไฟล์
- **log เก็บแค่ต้นและท้าย** event `tool-result` มี `spill` แทน `output` ไฟล์ spill จึงเป็นที่เดียวที่มีข้อความเต็ม

ผลที่ยาวแต่ไม่ถึงขีดยังกิน context ดู [Compaction อัตโนมัติก่อนเรียก model](/scenarios/ctx/compaction-auto/)
