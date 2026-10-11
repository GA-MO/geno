---
title: ผลลัพธ์ยาวเกินถูกเขียนลงไฟล์
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

    - id: run
      lane: tool
      at: shell
      do: >-
        `bash` รัน `pnpm test` ใน sandbox ได้ข้อความผลลัพธ์ยาวประมาณ 80,000 ตัวอักษร ปิดท้ายด้วยบรรทัด `[exit code 1]`
      ref: "packages/engine/src/tools/agent.ts#\"tools.sandbox.run(command\""

    - id: settle
      lane: loop
      at: tools
      do: >-
        ก่อนบันทึกผล `settle` เทียบความยาวกับ `spillChars` ของโมเดล (ค่าเริ่มต้น 24,000 ตัวอักษร)
        ยาวกว่าจึงเขียนข้อความทั้งหมดลงไฟล์ `spill/<session>/<seq>-bash.txt` ในโฟลเดอร์ของ Geno
        แล้วเก็บแค่ 2,000 ตัวอักษรแรก 2,000 ตัวอักษรท้าย ขนาด และที่อยู่ไฟล์
      ref: packages/engine/src/tools/spill.ts#settle
      emits: [spill]

    - use: tool-result-returns

    - id: notice
      lane: panel
      at: rail
      do: >-
        เมื่อผู้ใช้เปิดผลของขั้นนั้น จะเห็นข้อความเดียวกับที่โมเดลได้รับ คือประกาศว่าผลถูกเก็บลงไฟล์ ตามด้วยต้นและท้ายของผล
      sees: >-
        "[The output was 80412 bytes, too long to show. The full text is in .../spill/<session>/12-bash.txt;
        read it with start_line and end_line to see more.]" ตามด้วย "--- first 2000 characters ---" และ "--- last 2000 characters ---"
      ref: packages/core/src/tools.ts#spillNotice

    - use: model-call

    - id: reads
      lane: model
      do: >-
        `tool_result` ที่โมเดลได้รับมาจาก `toolResultText`: ประกาศ ต้น และท้ายของผล โมเดลเห็นสรุปเทสต์ที่ล้มในส่วนท้าย
        จึงขอเรียก `read` ไฟล์ spill ด้วย `start_line` และ `end_line` เฉพาะช่วงของเทสต์ตัวแรกที่ล้ม
      ref: packages/core/src/session.ts#toolResultText
      emits: [tool_use]

    - id: allowed
      lane: tool
      at: executor
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

- **ขีดเป็นของโมเดล ไม่ใช่ของเครื่องมือ** `spillChars` มาจาก `capabilitiesOf(provider, model)` ทุกเครื่องมือใช้ขีดเดียวกัน
  ยกเว้น `skill` ที่ได้ถึง 100,000 ตัวอักษร เพราะสกิลที่ถูกตัดทำให้โมเดลต้องอ่านคำสั่งของตัวเองเป็นท่อนๆ
- **ผลจากเครื่องมือ MCP มีคำแนะนำเพิ่ม** `toolResultText` ต่อท้ายด้วย `MCP_SPILL_NOTE` ให้โมเดลลองเรียกเครื่องมือใหม่
  ด้วย filter หรือหน้าที่แคบลงก่อนจะอ่านไฟล์ทั้งไฟล์
- **การตัดสินเกิดหลัง PostToolUse hook** hook เห็นข้อความเต็มก่อนจะถูกเขียนลงไฟล์
- **log เก็บแค่ต้นและท้าย** event `tool-result` มี `spill` แทน `output` ไฟล์ spill จึงเป็นที่เดียวที่มีข้อความเต็ม
