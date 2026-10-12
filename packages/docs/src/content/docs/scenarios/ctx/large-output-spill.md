---
title: "ผลของ tool ยาวเกิน Geno เขียนลงไฟล์"
description: คำสั่งพิมพ์ผลออกมายาวเกินขีดของโมเดล Geno เก็บทั้งหมดลงไฟล์ ส่งให้โมเดลแค่ต้น ท้าย และที่อยู่ไฟล์ แล้วโมเดลอ่านเฉพาะส่วนที่ต้องการ
tableOfContents: false
sidebar:
  order: 4
scenario:
  surface: vscode
  given:
    - เปิด Geno ในแผงแชตของ VS Code มี turn ทำงานอยู่
    - โมเดลขอรัน `bash` ด้วยคำสั่ง `pnpm test` ซึ่งอยู่ใน safe list จึงไม่ต้องขออนุญาต
  trigger: >-
    เทสต์ล้มหลายตัว คำสั่งพิมพ์ผลออกมาประมาณ 80,000 ตัวอักษร
  covers: [ctx.large-output-spill]
  related: [ctx.compaction-auto, tool.bash-safe-runs, ext.mcp-tool-call]
  steps:
    - use: tool-call-opens
      beat:
        title: "Geno เปิดขั้น pnpm test ในแชต"
        text: >-
          โมเดลขอรัน `pnpm test` ซึ่งอยู่ในรายการคำสั่งปลอดภัย จึงไม่ต้องถามคุณ แชตขึ้นขั้นใหม่พร้อมจุดหมุน
        sees: { kind: step, label: pnpm test, status: running }

    - id: run
      lane: tool
      at: shell
      beat:
        title: "เทสต์ล้มหลายตัว ผลยาว 80,000 ตัวอักษร"
        text: >-
          `pnpm test` รันใน sandbox เทสต์ล้มหลายตัว และพิมพ์ผลออกมาประมาณ 80,000 ตัวอักษร
        from: machine
      do: >-
        `bash` รัน `pnpm test` ใน sandbox ได้ข้อความผลลัพธ์ยาวประมาณ 80,000 ตัวอักษร ปิดท้ายด้วยบรรทัด `[exit code 1]`
      ref: "packages/engine/src/tools/agent.ts#\"tools.sandbox.run(command\""

    - id: settle
      lane: loop
      at: tools
      beat:
        title: "Geno เก็บผลทั้งหมดลงไฟล์"
        text: >-
          ผลยาวกว่าขีดของโมเดล ค่าตั้งต้น 24,000 ตัวอักษร Geno จึงเขียนทั้งหมดลงไฟล์ในโฟลเดอร์ของตัวเอง แล้วเก็บไว้แค่
          2,000 ตัวอักษรแรก 2,000 ตัวอักษรท้าย ขนาด และที่อยู่ไฟล์
      do: >-
        ก่อนบันทึกผล `settle` เทียบความยาวกับ `spillChars` ของโมเดล (ค่าเริ่มต้น 24,000 ตัวอักษร)
        ยาวกว่าจึงเขียนข้อความทั้งหมดลงไฟล์ `spill/<session>/<seq>-bash.txt` ในโฟลเดอร์ของ Geno
        แล้วเก็บแค่ 2,000 ตัวอักษรแรก 2,000 ตัวอักษรท้าย ขนาด และที่อยู่ไฟล์
      ref: packages/engine/src/tools/spill.ts#settle
      emits: [spill]

    - use: tool-result-returns
      beat:
        title: "ผลกลับมาที่แชต"
        text: >-
          ขั้นของ `pnpm test` หยุดหมุน ผลพับอยู่ข้างใต้
        to: panel

    - id: notice
      lane: panel
      at: rail
      beat:
        title: "คุณเห็นสิ่งเดียวกับที่ model ได้"
        text: >-
          เมื่อเปิดผลของขั้นนั้น คุณเห็นประกาศว่าผลถูกเก็บลงไฟล์ ตามด้วยต้นและท้ายของผล
        sees: { kind: step, label: pnpm test, status: done, output: "[The output was 80412 bytes, too long to show. The full text is in .../spill/<session>/12-bash.txt; read it with start_line and end_line to see more.]" }
      do: >-
        เมื่อผู้ใช้เปิดผลของขั้นนั้น จะเห็นข้อความเดียวกับที่โมเดลได้รับ คือประกาศว่าผลถูกเก็บลงไฟล์ ตามด้วยต้นและท้ายของผล
      sees: >-
        "[The output was 80412 bytes, too long to show. The full text is in .../spill/<session>/12-bash.txt;
        read it with start_line and end_line to see more.]" ตามด้วย "--- first 2000 characters ---" และ "--- last 2000 characters ---"
      ref: packages/core/src/tools.ts#spillNotice

    - use: model-call
      beat:
        title: "Geno ส่งต้นและท้ายของผลให้ model"
        text: >-
          คำขอถัดไปมีแค่ประกาศ ต้น และท้ายของผล ไม่ใช่ทั้ง 80,000 ตัวอักษร ใน run จริงด้านล่าง ผลที่ยาวเกินมาจาก tool
          อีกตัว แต่ประกาศมีรูปเดียวกัน
        to: model
        sees:
          kind: payload
          direction: tool_result
          source: docs/results/real-usecases/runs/A07-multi-step-todo/1/requests.jsonl#seq=17
          select: messages[-1].content[0]
          highlight:
            - content

    - id: reads
      lane: model
      beat:
        title: "Model ขออ่านเฉพาะช่วงที่ต้องการ"
        text: >-
          โมเดลเห็นสรุปเทสต์ที่ล้มในส่วนท้าย จึงขออ่านไฟล์นั้นเฉพาะบรรทัดของเทสต์ตัวแรกที่ล้ม
      do: >-
        `tool_result` ที่โมเดลได้รับมาจาก `toolResultText`: ประกาศ ต้น และท้ายของผล โมเดลเห็นสรุปเทสต์ที่ล้มในส่วนท้าย
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
        end: "model อ่านทีละช่วง"
      do: >-
        `read` ตรวจ path ด้วย `resolveInside` โฟลเดอร์ spill ของ session นี้อยู่นอก workspace แต่เป็นที่ที่อ่านได้
        การอ่านจึงผ่านโดยไม่ต้องขออนุญาต และได้เฉพาะบรรทัดที่ขอ
      ref: packages/engine/src/tools/context.ts#resolveInside
      phase: running-tools
      end: { turn: continues }
---

ผลที่ยาวเกินไม่ถูกตัดทิ้ง และไม่ถูกส่งทั้งก้อนเข้า context ข้อความเต็มอยู่ในไฟล์ โมเดลเลือกอ่านส่วนที่ต้องการเอง
ทำให้ผลก้อนเดียวไม่ดัน context จนต้อง [สรุปบริบท](/scenarios/ctx/compaction-auto/)

สิ่งที่ควรสังเกต

- **ขีดเป็นของโมเดล ไม่ใช่ของ tool** `spillChars` มาจาก `capabilitiesOf(provider, model)` ทุก tool ใช้ขีดเดียวกัน
  ยกเว้น `skill` ที่ได้ถึง 100,000 ตัวอักษร เพราะสกิลที่ถูกตัดทำให้โมเดลต้องอ่านคำสั่งของตัวเองเป็นท่อนๆ
- **ผลจาก tool MCP มีคำแนะนำเพิ่ม** `toolResultText` ต่อท้ายด้วย `MCP_SPILL_NOTE` ให้โมเดลลองเรียก tool ใหม่
  ด้วย filter หรือหน้าที่แคบลงก่อนจะอ่านไฟล์ทั้งไฟล์
- **การตัดสินเกิดหลัง PostToolUse hook** hook เห็นข้อความเต็มก่อนจะถูกเขียนลงไฟล์
- **log เก็บแค่ต้นและท้าย** event `tool-result` มี `spill` แทน `output` ไฟล์ spill จึงเป็นที่เดียวที่มีข้อความเต็ม

ผลที่ยาวแต่ไม่ถึงขีดยังกิน context ดู [Compaction อัตโนมัติก่อนเรียก model](/scenarios/ctx/compaction-auto/)
