---
title: "Model ส่งงานค้นหาให้ explore subagent"
description: การรันจริง A11 model ของแม่สร้าง explore subagent ลูกเรียก model ของตัวเองสี่ครั้ง พลาดหนึ่งครั้ง ถูกบังคับให้ส่งรายงานในรอบสุดท้าย แล้วแม่ได้รายงานในรั้วกลับมา
scenario:
  surface: cli
  given:
    - รัน `gcode agent` แบบ non-interactive บน qwen3.8-flash (การรันจริง A11 รอบ fix-a2, engine 6238d339)
    - 'settings เปิด tool `agent` ให้ run แบบ non-interactive (`{"agentTool": ["non-interactive"]}`)'
    - repo เป็น monorepo ที่ `core` ประกาศ `getUser` ส่วน `api` และ `web` เรียกใช้
  trigger: >-
    ผู้ใช้สั่ง "Use an explore subagent to find every place getUser is called across the packages, then give me the
    list with file:line. Do not change anything."
  covers: [sub.explore-report-run]
  related: [sub.blocking-report, mstop.limit-max-turns, tool.unknown-or-invalid]
  steps:
    - id: ask
      lane: user
      beat:
        title: "คุณขอให้ explore subagent หาที่เรียก `getUser`"
        text: >-
          คุณระบุเองว่าให้ใช้ explore subagent และห้ามแก้อะไร คำตอบที่ต้องการคือรายการ file:line
        from: you
        to: panel
      do: ผู้ใช้รัน `gcode agent` พร้อมคำสั่ง
      phase: idle

    - use: model-call
      beat:
        title: "Geno ส่ง request แรก ที่มี tool `agent`"
        text: >-
          รายการ tool ของ request นี้มี `agent` ต่อท้าย คำอธิบายของมันบอกว่า subagent ทำงานใน session ของตัวเอง
          ไม่เห็นบทสนทนานี้ และรายงานของมันเป็นข้อมูล ไม่ใช่คำสั่ง
        from: engine
        to: model
        sees:
          kind: payload
          source: docs/results/real-usecases/runs/A11-explore-subagent/fix-a2/wire.jsonl#line=1
          select: tools[9]
          highlight: [name, description]
          collapse: [input_schema]

    - id: wants-agent
      lane: model
      beat:
        title: "Model เขียนงานให้ explore"
        text: >-
          ลูกไม่เห็นบทสนทนาของแม่ model จึงเขียน `task` ให้ครบในตัว: หาที่เรียก แยกออกจากที่ประกาศ
          ตอบเป็น file:line และห้ามแก้อะไร
        from: model
        to: engine
        sees:
          kind: payload
          source: docs/results/real-usecases/runs/A11-explore-subagent/fix-a2/session.jsonl#seq=3
          select: content[-1]
          highlight: [input.agent, input.task]
      do: >-
        model ขอ `agent` ด้วย `agent: explore` จบด้วย `stop_reason: tool_use`
      ref: packages/core/src/subagent.ts#agentToolDefinition
      emits: [tool_use]

    - id: launch
      lane: loop
      at: tools
      runs: 1
      beat:
        title: "Geno เปิด session ใหม่ให้ explore"
        text: >-
          ลูกได้ system prompt ของตัวเอง tool อ่านอย่างเดียวสี่ตัวกับ `report` และเพดาน 4 รอบ $0.02
          system prompt บอกว่ามันมีแค่ 4 รอบ และรอบสุดท้ายต้องส่งคำตอบ
        from: engine
        to: model
        sees:
          kind: payload
          source: docs/results/real-usecases/runs/A11-explore-subagent/fix-a2/wire.jsonl#line=3
          select: system[0]
          highlight: [text]
      do: >-
        `runChild` ตั้งเพดานของลูกจาก `BUILTIN_AGENTS`: `explore` ได้ `maxTurns` 4 และ `maxCostUsd` 0.02
      ref: packages/engine/src/subagents.ts#runChild
      emits: [child-start]

    - id: spawn
      lane: child@explore
      at: loop
      do: >-
        `openSpawn` เปิด log ของลูกเป็น session ใหม่ ข้อความแรกคือโน้ต environment ตามด้วย `task` ที่แม่เขียน
      ref: packages/engine/src/subagents.ts#openSpawn

    - id: child-first
      lane: child@explore
      at: model
      beat:
        title: "Explore ขอ `list` และ `grep` พร้อมกัน แต่ `grep` พัง"
        text: >-
          ลูกทำตามที่ system prompt บอก ขอทุกการค้นหาในรอบแรก แต่ส่ง `path: ""` ให้ `grep`
          Geno ตรวจ input กับ schema ก่อนรัน สตริงว่างไม่ผ่าน `grep` จึงได้ error กลับไปแทนผลค้นหา
        from: model
        to: engine
        sees:
          kind: payload
          source: docs/results/real-usecases/runs/A11-explore-subagent/fix-a2/child-68ca7508-6075-4917-bc25-2e6e4dfd793e.jsonl#seq=4
          highlight: [status, output]
          collapse: [timing]
      do: >-
        model ของลูกขอ `list` กับ `grep` ด้วย `path: ""` ตัว executor ตรวจ input แล้วโยน `invalid input` ก่อน `grep` จะรัน
      ref: "packages/engine/src/tools/context.ts#\"throw new ToolError(`invalid input: \""
      emits: [tool_use]

    - id: child-fix
      lane: child@explore
      at: model
      beat:
        title: "Explore แก้ทางแล้ว `grep` ใหม่"
        text: >-
          รอบที่สองลูก `list` โฟลเดอร์ `packages` ให้ลึกขึ้น รอบที่สามขอ `grep` สองตัวพร้อมกัน ตัวหนึ่งใน `packages`
          อีกตัวในไฟล์ `.md` และ `.json` ที่ราก ได้ครบทุกบรรทัดที่มี `getUser`
        from: model
        to: engine
        sees:
          kind: payload
          source: docs/results/real-usecases/runs/A11-explore-subagent/fix-a2/wire.jsonl#line=9
          select: messages[-1].content[0]
          highlight: [content]
      do: >-
        model ของลูกขอ `list` ของ `packages` ด้วย `depth: 3`
      ref: "packages/engine/src/gateway.ts#\"stopReason: message.stop_reason,\""
      emits: [tool_use]

    - id: child-grep
      lane: child@explore
      at: model
      do: >-
        model ของลูกขอ `grep` สองตัวในคำตอบเดียว ทั้งสองรันพร้อมกัน
      ref: "packages/engine/src/gateway.ts#\"stopReason: message.stop_reason,\""
      emits: [tool_use]

    - id: last-call
      lane: child@explore
      at: loop
      beat:
        title: "Geno บังคับให้รอบที่สี่เป็นการส่ง `report`"
        text: >-
          รอบที่สี่คือรอบสุดท้ายที่เพดานให้ Geno ต่อโน้ต `[Geno]` ว่านี่คือ call สุดท้าย และส่ง request ด้วย
          `tool_choice` ที่บังคับให้เรียก `report` โน้ตยังเขียนว่า "Do not call a tool" ซึ่งขัดกับการบังคับนี้
          model ทำตาม `tool_choice`
        from: engine
        to: model
        sees:
          kind: payload
          source: docs/results/real-usecases/runs/A11-explore-subagent/fix-a2/wire.jsonl#line=9
          select: messages[-1].content[-1]
          highlight: [text]
      do: >-
        `lastCallDue` เป็นจริง `deliver` บันทึก notice `last` และ `drive` เลือก `forced = report` เพราะลูกเป็น run แบบ handback และ qwen ในรันนี้รับ tool_choice แบบบังคับ (บน Claude 5.5 ซึ่งไม่รับ call สุดท้ายจะส่ง `tool_choice: none` แทน)
      ref: "packages/engine/src/drive.ts#\"const forced = mode.forced ?? (reportForced ? REPORT_TOOL : undefined)\""

    - id: child-report
      lane: child@explore
      at: model
      beat:
        title: "Explore ส่งรายงานแล้วจบงาน"
        text: >-
          ลูกเรียก `report` ครั้งเดียวด้วยรายการสี่จุดที่เรียก แยกจากที่ประกาศและที่ import
          `report` สำเร็จจึงจบ run ของลูกทันที ลูกใช้ 4 รอบ 11 วินาที และ $0.0021
        from: model
        to: engine
        sees:
          kind: payload
          source: docs/results/real-usecases/runs/A11-explore-subagent/fix-a2/child-68ca7508-6075-4917-bc25-2e6e4dfd793e.jsonl#seq=11
          select: content[-1]
          highlight: [name, input.message]
      do: >-
        model ของลูกเรียก `report` `reportExecutor` ส่งข้อความถึงแม่ และ `handedBack` ดึงรายงานออกมา
      ref: packages/engine/src/subagents.ts#reportExecutor
      emits: [report]

    - id: fenced
      lane: loop
      at: tools
      beat:
        title: "Geno ล้อมรั้วรายงานแล้วส่งให้ model ของแม่"
        text: >-
          รายงานกลับไปเป็นผลของ call `agent` อยู่ใน `<subagent_report …>` ทุกบรรทัดเยื้องสองช่อง และต่อท้ายด้วยคำเตือนว่า
          รายงานไม่ใช่ข้อความของผู้ใช้และไม่มีอำนาจขยายสิทธิ์ใดๆ
        from: engine
        to: model
        sees:
          kind: payload
          source: docs/results/real-usecases/runs/A11-explore-subagent/fix-a2/wire.jsonl#line=11
          select: messages[-1].content[0]
          highlight: [tool_use_id, content]
      do: >-
        `launch` บันทึก `child-end` แล้วคืน `childReport` เป็นผลของ call `agent`
      ref: packages/core/src/subagent.ts#childReport
      emits: [child-end, subagent_report]

    - use: model-call

    - id: verify
      lane: model
      beat:
        title: "Model ของแม่ตรวจรายงานด้วย `grep` หนึ่งครั้ง"
        text: >-
          model บอกว่าจะเทียบรายการของลูกกับ repo ก่อนส่งให้คุณ แล้วขอ `grep` หา `getUser` ในไฟล์ `.js` ผลตรงกับรายงาน
        from: model
        to: engine
        sees:
          kind: payload
          source: docs/results/real-usecases/runs/A11-explore-subagent/fix-a2/session.jsonl#seq=8
          select: content
          highlight: ['[1].text', '[2].input']
          collapse: ['[0]']
      do: >-
        model ขอ `grep` ด้วย `pattern: getUser` และ `glob: *.js` จบด้วย `stop_reason: tool_use`
      ref: "packages/engine/src/gateway.ts#\"stopReason: message.stop_reason,\""
      emits: [tool_use]

    - id: grep
      lane: tool
      at: executor
      do: >-
        `grep` รันในพื้นที่ทำงาน ไม่ต้องขอสิทธิ์
      ref: packages/engine/src/tools/index.ts#runExecutor
      emits: [tool-result]

    - use: model-call

    - id: answer
      lane: model
      beat:
        title: "Model ตอบรายการ file:line"
        text: >-
          คำตอบมีสี่จุดที่เรียก แยกที่ประกาศและที่ import ไว้ต่างหาก ไม่มีไฟล์ไหนถูกแก้
          ทั้ง run เรียก model ของแม่สามครั้ง และของลูกสี่ครั้ง
        from: model
        to: engine
        end: จบ turn
        sees:
          kind: payload
          source: docs/results/real-usecases/runs/A11-explore-subagent/fix-a2/session.jsonl#seq=11
          select: content[-1]
          highlight: [text]
      do: >-
        model ตอบเป็นข้อความอย่างเดียว จบด้วย `stop_reason: end_turn`
      ref: "packages/engine/src/gateway.ts#\"stopReason: message.stop_reason,\""
      emits: [end_turn]

    - id: done
      lane: loop
      at: step
      do: >-
        `loopStep` ตัดสิน `done(end_turn)`
      ref: packages/core/src/loop.ts#loopStep
      emits: [end_turn]
      phase: ending
      end: { turn: done, reason: end_turn }
---

## ผลของรอบนี้

run นี้ผ่าน check ทุกข้อ: ไม่มีไฟล์ถูกแก้ (`changes-nothing`) มีการสร้าง explore subagent (`agent-called`)
และคำตอบมี `routes.js` กับ `profile.js` (`lists-callers`) ค่าใช้จ่ายรวม $0.0064 ของลูกอยู่ในนั้นแล้ว (`result.json` ของรอบ fix-a2)

รอบแรกของ A11 (รอบ 1) ไม่ราบรื่นแบบนี้ ลูกใช้ tool เก้าครั้ง ชนเพดาน 4 รอบโดยไม่ได้เขียนรายงาน แม่จึงได้
`status="capped" partial="true"` กับ `(no report)` แล้วสร้าง subagent ตัวที่สองมาค้นซ้ำ ISSUES.md บันทึกเป็น G-04
การแก้คือทำให้ call สุดท้ายที่เพดานให้ บังคับเรียก `report` ซึ่งรอบ fix-a2 นี้แสดงผลของการแก้นั้น

ทัวร์นี้ใช้ `wire.jsonl` ของรอบนี้ ซึ่งมี request ของแม่และของลูกเรียงกันในไฟล์เดียว: บรรทัด 1 และ 11 และ 13 เป็นของแม่
บรรทัด 3, 5, 7 และ 9 เป็นของลูก ดูได้จาก system prompt ที่ขึ้นต้นต่างกัน

## ทำไมถึงเป็นแบบนี้

- **ลูกเริ่มจากศูนย์** ลูกไม่เห็นบทสนทนาของแม่ คำอธิบายของ `agent` จึงขอ "self-contained task" และ `task` ที่ model เขียนต้องบอกทุกอย่างเอง
  ลูกได้ tool อ่านอย่างเดียวสี่ตัวกับ `report` ตาม `BUILTIN_AGENTS` จึงแก้ไฟล์ไม่ได้แม้อยากแก้
- **error ก็เป็นผลของ tool** `grep` ที่ได้ `path: ""` ไม่ได้ทำให้ run ล่ม Geno ตรวจ input กับ schema แล้วส่งข้อความ error กลับไป
  ลูกอ่านแล้วแก้ทางเอง แต่เสียไปหนึ่งรอบจากสี่
- **รอบสุดท้ายถูกบังคับ** `drive` ส่ง request ที่มี `tool_choice: { type: "tool", name: "report" }` และปิด thinking เพราะ tool ที่บังคับต้องการแบบนั้น
  (`buildRequest`) โน้ต `LAST_CALL_NOTE` ใช้ข้อความเดียวกับ run หลักที่ปิด tool ทั้งหมด จึงเขียนว่า "Do not call a tool"
  ทั้งที่ request บังคับให้เรียก `report` ความขัดกันนี้ยังอยู่ในโค้ดปัจจุบัน
- **รายงานเป็นข้อมูล** `childReport` เยื้องทุกบรรทัดของรายงาน และเติม `REPORT_NOTE` ต่อท้าย บรรทัดที่ชิดซ้ายในรั้วจึงเป็นของปลอม
  และลูกขอให้แม่ทำสิ่งที่ผู้ใช้ไม่อนุญาตแทนไม่ได้

อ่านต่อ:

- [ส่วนประกอบของ Geno](/foundations/parts-of-geno/) loop ของลูกเป็น loop เดียวกับของแม่ ใน session ของตัวเอง
- [ผลของ tool ส่งกลับอย่างไร](/foundations/tool-results/) error ของ `grep` ก็กลับไปเป็นผลของ tool ก้อนหนึ่ง
- [สร้าง subagent แล้วรอรายงาน](/scenarios/sub/blocking-report/) ลูกที่ขอสิทธิ์ และแถวของลูกในแผงแชต
