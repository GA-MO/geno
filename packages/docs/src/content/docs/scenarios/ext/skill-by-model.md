---
title: โมเดลเรียกสกิล
description: โมเดลเห็นรายชื่อสกิลในข้อความแรกของ session แล้วเรียก skill เพื่อโหลด SKILL.md สกิลที่ตั้ง context fork รันเป็นเอเจนต์ลูกแทน
tableOfContents: false
sidebar:
  order: 3
scenario:
  surface: vscode
  given:
    - workspace มีสกิล `.claude/skills/release-notes/SKILL.md` ที่มี `description` ใน frontmatter
    - รายชื่อสกิลพร้อมคำอธิบายอยู่ในข้อความแรกของ session (ส่วน skill listing ที่ถูกตรึงไว้ใน `session-start`)
  trigger: >-
    ผู้ใช้ขอว่า "เขียน release notes ของ v1.4 ให้หน่อย" โมเดลเห็นว่าสกิล release-notes ตรงกับงาน
  covers: [ext.skill-by-model, ext.skill-fork]
  related: [ext.skill-typed, ext.slash-template, sub.blocking-report, ctx.large-output-spill]
  steps:
    - id: wants
      lane: model
      do: >-
        โมเดลเลือกสกิลจากรายชื่อที่เห็น แล้วขอเรียก `skill` ด้วย `name: "release-notes"` และ `args: "v1.4"`
        จบคำตอบด้วย `stop_reason: tool_use`
      ref: packages/core/src/context.ts#listingSection
      emits: [tool_use]
      phase: calling-model

    - use: tool-call-opens

    - id: load
      lane: tool
      at: executor
      do: >-
        `skillExecutor` อ่านโฟลเดอร์สกิลตามที่เป็นตอนนี้ หา `release-notes` ตรวจว่าโมเดลเรียกได้
        (สกิลที่ตั้ง `disable-model-invocation` ถูกปฏิเสธ เว้นแต่ผู้ใช้พิมพ์ `/release-notes` เองใน session นี้)
        แล้วประกอบข้อความ: ที่อยู่ของไฟล์ โฟลเดอร์ที่ใช้แปลง path สัมพัทธ์ และเนื้อหา SKILL.md ที่แทน `$ARGUMENTS` ด้วย `v1.4`
      ref: packages/engine/src/tools/skill.ts#skillExecutor
      fork:
        ask: frontmatter ของสกิลตั้ง context fork ไหม
        options:
          - id: inline
            label: ไม่ตั้ง (โหลดเข้า context)
            steps:
              - lane: loop
                at: tools
                do: >-
                  ข้อความของสกิลเป็นผลของ call โดยตรง ผลของ `skill` ยาวได้ถึง 100,000 ตัวอักษรก่อนถูกเก็บลงไฟล์
                  เพื่อให้โมเดลอ่านคำสั่งของสกิลได้ทั้งก้อน
                ref: packages/core/src/tools.ts#spillLimitOf
              - use: tool-result-returns
              - lane: loop
                at: step
                do: >-
                  `loopStep` ตัดสิน `call-model` โมเดลอ่าน "Skill release-notes, from ..." แล้วทำตามขั้นในสกิล
                  เช่นรัน `git log` และเขียนไฟล์ release notes ด้วยเครื่องมือของตัวเอง ภายใต้สิทธิ์เดิมของ session
                ref: packages/core/src/loop.ts#loopStep
                emits: [call-model]
                phase: calling-model
                end: { turn: continues, reason: call-model }

          - id: fork
            label: "context: fork (รันเป็นเอเจนต์ลูก)"
            steps:
              - lane: tool
                at: executor
                do: >-
                  สกิลตั้ง `context: fork` executor จึงไม่คืนข้อความ แต่ส่งข้อความของสกิลเป็นงานให้ลูก
                  ชื่อ `agent` ในสกิล หรือ `worker` ถ้าไม่ระบุ ทางนี้ทำงานแม้ `agentTool` ไม่ได้เปิด
                  เพราะเรียก executor ของลูกตรงๆ (ในตัวลูกเองซึ่งสร้างลูกไม่ได้ สกิลจะโหลดเข้า context แทน)
                ref: "packages/engine/src/tools/skill.ts#\"return start(skill.fork.agent ?? 'worker', text, ctx);\""
              - lane: loop
                at: tools
                do: >-
                  `launch` เปิด `worker` เป็น session ใหม่ แบบรอผล รันทีละตัวบน checkout หลัก แถวของลูกขึ้นใต้ขั้น `skill`
                ref: packages/engine/src/subagents.ts#runChild
                emits: [child-start, subagent_update]
              - lane: child@worker
                at: model
                do: >-
                  ลูกได้ข้อความของสกิลเป็นงาน ทำตามขั้นในสกิลใน session ของตัวเอง แล้วเรียก `report`
                ref: packages/core/src/subagent.ts#childSystemPrompt
                emits: [report]
              - lane: loop
                at: tools
                do: >-
                  ผลของ call `skill` คือรายงานในรั้ว `<subagent_report agent="worker" ...>` ไม่ใช่เนื้อหา SKILL.md
                  context ของแม่จึงไม่บวมด้วยคำสั่งของสกิลและงานระหว่างทาง
                ref: packages/core/src/subagent.ts#childReport
                emits: [subagent_report, child-end]
              - use: tool-result-returns
              - lane: loop
                at: step
                do: >-
                  `loopStep` ตัดสิน `call-model` โมเดลของแม่อ่านรายงานแล้วเล่าให้ผู้ใช้
                ref: packages/core/src/loop.ts#loopStep
                emits: [call-model]
                phase: calling-model
                end: { turn: continues, reason: call-model }
---

สกิลคือคำแนะนำที่โหลดเมื่อต้องใช้: ข้อความแรกของ session มีแค่ชื่อกับคำอธิบาย (รวมไม่เกิน 8,000 ตัวอักษร)
เนื้อหาเต็มเข้ามาเมื่อโมเดลเรียก `skill` หรือเมื่อผู้ใช้พิมพ์ `/ชื่อสกิล` ([คำสั่ง / ที่กลายเป็น prompt](/scenarios/ext/slash-template/))

สิ่งที่ควรสังเกต

- **`context: fork` มีผลเฉพาะเมื่อโมเดลเรียก** ผู้ใช้ที่พิมพ์ `/release-notes` ได้สกิลเป็น context item ใน turn ของตัวเองเสมอ
- **สกิลไม่ขยายสิทธิ์** คำอธิบายของเครื่องมือบอกโมเดลว่าสกิลเป็นข้อมูลจากไฟล์ คำสั่งในสกิลยังต้องผ่านกฎ การ์ด และ sandbox เหมือนเดิม
- **สกิลของ plugin** ชื่อขึ้นต้นด้วยชื่อ plugin เช่น `pstack:how` โฟลเดอร์ของ plugin อ่านได้แต่แก้ไม่ได้
- **ไม่เจอสกิล** โมเดลได้ error ที่บอกรายชื่อสกิลที่เรียกได้ แล้วเลือกใหม่ได้ในรอบถัดไป
