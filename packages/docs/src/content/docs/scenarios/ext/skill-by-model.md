---
title: "Model เรียก skill"
description: model เห็นรายชื่อสกิลในข้อความแรกของ session แล้วเรียก skill เพื่อโหลด SKILL.md สกิลที่ตั้ง context fork รันเป็น subagent แทน
scenario:
  surface: vscode
  given:
    - workspace มีสกิล `.claude/skills/release-notes/SKILL.md` ที่มี `description` ใน frontmatter
    - รายชื่อสกิลพร้อมคำอธิบายอยู่ในข้อความแรกของ session (Geno ใส่รายชื่อนี้ไว้ตอนเริ่ม session)
  trigger: >-
    ผู้ใช้ขอว่า "เขียน release notes ของ v1.4 ให้หน่อย" model เห็นว่าสกิล release-notes ตรงกับงาน
  covers: [ext.skill-by-model, ext.skill-fork]
  related: [ext.skill-typed, ext.slash-template, sub.blocking-report, ctx.large-output-spill]
  steps:
    - id: wants
      beat:
        title: Model เลือก skill release-notes
        text: skill คือไฟล์ `SKILL.md` ที่สอนวิธีทำงานแบบหนึ่ง model เห็นแค่ชื่อกับคำอธิบายสั้นในข้อความแรกของ session แล้วเรียก tool `skill` เพื่อโหลดเนื้อหาเต็มเมื่อต้องใช้ model เห็นว่า release-notes ตรงกับงาน การ์ดเป็น call จริงจากการรันที่ model โหลด skill changelog ดูบล็อก `tool_use` ที่ `name` คือ `skill` และ `input.name` คือชื่อ skill
        from: model
        to: engine
        sees:
          kind: payload
          source: docs/results/real-usecases/runs/A18-project-skill/fix-b2/session.jsonl#seq=15
          select: content[3]
      lane: model
      do: >-
        model เลือกสกิลจากรายชื่อที่เห็น แล้วขอเรียก `skill` ด้วย `name: "release-notes"` และ `args: "v1.4"`
        จบคำตอบด้วย `stop_reason: tool_use`
      ref: packages/core/src/context.ts#listingSection
      emits: [tool_use]
      phase: calling-model

    - use: tool-call-opens
      beat:
        title: แชตขึ้นขั้น skill
        text: แผงแชตขึ้นขั้นใหม่พร้อมจุดหมุน
        from: panel
        to: you
        sees:
          kind: step
          label: skill release-notes
          status: running

    - id: load
      beat:
        title: Geno โหลด skill จากโฟลเดอร์
        text: Geno อ่านโฟลเดอร์ skill ตามที่เป็นตอนนี้ และตรวจว่า model เรียก skill นี้ได้ ทางต่อไปขึ้นกับ frontmatter ของ skill (ส่วนหัว YAML ของไฟล์) ว่าตั้ง `context` เป็น `fork` ไหม
        from: engine
        to: engine
        ask: skill ตั้ง fork ไหม
      lane: tool
      at: executor
      do: >-
        `skillExecutor` อ่านโฟลเดอร์สกิลตามที่เป็นตอนนี้ หา `release-notes` ตรวจว่า model เรียกได้
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
                beat:
                  title: ข้อความของ skill เป็นผลของ call
                  text: Geno เขียนข้อความผลไว้ใน log ผลนี้ถึง model ตอนเรียกครั้งถัดไป ระหว่างนี้ model ไม่ได้ตอบอะไร ผลยาวได้ถึง 100,000 ตัวอักษรก่อนถูกเก็บลงไฟล์ model จึงอ่านคำสั่งของ skill ได้ทั้งก้อน การ์ดเป็นผลจริงของ skill changelog ดู `content` ซึ่งขึ้นต้นด้วยที่อยู่ของไฟล์ ตามด้วยเนื้อหา SKILL.md
                  from: engine
                  to: engine
                  sees:
                    kind: payload
                    source: docs/results/real-usecases/runs/A18-project-skill/fix-b2/wire.jsonl#line=9
                    select: messages[-1].content[1]
                    highlight: [content]
                at: tools
                do: >-
                  ข้อความของสกิลเป็นผลของ call โดยตรง ผลของ `skill` ยาวได้ถึง 100,000 ตัวอักษรก่อนถูกเก็บลงไฟล์
                  เพื่อให้ model อ่านคำสั่งของสกิลได้ทั้งก้อน
                ref: packages/core/src/tools.ts#spillLimitOf
              - use: tool-result-returns
              - lane: loop
                beat:
                  title: Geno เรียก model อีกครั้งพร้อมข้อความของ skill
                  text: Geno ส่งบทสนทนาทั้งหมดไปให้ model อีกครั้งในคำขอใหม่ ท้ายคำขอคือคำขอ `skill` ของ model (การ์ดแรก) และข้อความของ skill ที่ Geno เตรียมไว้ (การ์ดที่สอง) model จึงทำตามขั้น เช่นรัน `git log` และเขียนไฟล์ release notes ด้วย tool ของตัวเอง การ์ดข้างล่างเป็นคำขอจริงจากการรันเดียวกันที่โหลด skill changelog
                  from: engine
                  to: model
                  sees:
                    - kind: payload
                      source: docs/results/real-usecases/runs/A18-project-skill/fix-b2/wire.jsonl#line=9
                      select: messages[-2]
                      collapse: ['content[0]']
                      highlight: ['content[3]']
                    - kind: payload
                      source: docs/results/real-usecases/runs/A18-project-skill/fix-b2/wire.jsonl#line=9
                      select: messages[-1]
                      highlight: ['content[1]']
                  end: Model ทำตาม skill
                at: step
                do: >-
                  `loopStep` ตัดสิน `call-model` model อ่าน "Skill release-notes, from ..." แล้วทำตามขั้นในสกิล
                  เช่นรัน `git log` และเขียนไฟล์ release notes ด้วย tool ของตัวเอง ภายใต้สิทธิ์เดิมของ session
                ref: packages/core/src/loop.ts#loopStep
                emits: [call-model]
                phase: calling-model
                end: { turn: continues, reason: call-model }

          - id: fork
            label: "context: fork (รันเป็น subagent)"
            steps:
              - lane: tool
                beat:
                  title: Geno ส่ง skill เป็นงานให้ worker
                  text: "skill ตั้ง `context: fork` Geno ไม่คืนข้อความ แต่ส่งข้อความของ skill เป็นงานให้ subagent ชื่อ `worker` subagent คือ session ลูกที่มีบทสนทนาของตัวเองและต้องส่งรายงานกลับ ทางนี้ทำงานแม้ model จะเรียก tool `agent` เองไม่ได้ งานไปถึง model ของ worker เป็นข้อความแรกของ session ใหม่ การ์ดในทางนี้เป็นการบันทึกที่รัน Geno จริงกับ model จำลองที่ตอบตามบทที่เขียนไว้ก่อน ในการบันทึกนั้น model ของแม่เรียก `agent` เองแทนการเรียก skill การ์ดข้างล่างคือคำขอแรกของ worker ดูบล็อก `text` อันสุดท้าย ซึ่งเป็นงานที่ worker ได้ ในการ์ดนี้เป็นข้อความตามบทของ model ของแม่ ไม่ใช่ข้อความของ skill"
                  from: engine
                  to: model
                  sees:
                    kind: payload
                    source: packages/docs/src/data/recorded/worker-blocking.jsonl#line=4
                    select: messages[0]
                    highlight: ['content[1].text']
                at: executor
                do: >-
                  สกิลตั้ง `context: fork` executor จึงไม่คืนข้อความ แต่ส่งข้อความของสกิลเป็นงานให้ลูก
                  ชื่อ `agent` ในสกิล หรือ `worker` ถ้าไม่ระบุ ทางนี้ทำงานแม้ `agentTool` ไม่ได้เปิด
                  เพราะเรียก executor ของลูกตรงๆ (ในตัวลูกเองซึ่งสร้างลูกไม่ได้ สกิลจะโหลดเข้า context แทน)
                ref: "packages/engine/src/tools/skill.ts#\"return start(skill.fork.agent ?? 'worker', text, ctx);\""
              - lane: loop
                beat:
                  title: แชตขึ้นแถวของ worker
                  text: worker เปิดเป็น session ใหม่ แม่รอผลของมันก่อนทำต่อ worker แบบนี้รันทีละตัว และทำงานในโฟลเดอร์หลักของ repo ไม่ได้แยกไปโฟลเดอร์อื่น
                  from: panel
                  to: you
                  sees:
                    kind: task
                    title: worker
                    status: running
                at: tools
                do: >-
                  `launch` เปิด `worker` เป็น session ใหม่ แบบรอผล รันทีละตัวบน checkout หลัก แถวของลูกขึ้นใต้ขั้น `skill`
                ref: packages/engine/src/subagents.ts#runChild
                emits: [child-start, subagent_update]
              - lane: child@worker
                beat:
                  title: worker ทำตาม skill แล้วรายงาน
                  text: >-
                    worker ได้ข้อความของ skill เป็นงาน ทำตามขั้นใน session ของตัวเอง แล้วส่งรายงาน
                    การ์ดข้างล่างเป็น event หนึ่งใน stream ของคำตอบตามบทของ worker ในการบันทึกเดียวกับการ์ดก่อนหน้า event นี้เปิดบล็อก `tool_use` ใหม่
                    ดู `name` ซึ่งเป็น `report` คือ tool ที่ subagent ใช้ส่งรายงานกลับ คำตอบนี้จบด้วย `stop_reason: tool_use`
                  from: model
                  to: engine
                  sees:
                    kind: payload
                    source: packages/docs/src/data/recorded/worker-blocking.jsonl#line=9
                    select: '[1]'
                    highlight: [data.content_block.name]
                at: model
                do: >-
                  ลูกได้ข้อความของสกิลเป็นงาน ทำตามขั้นในสกิลใน session ของตัวเอง แล้วเรียก `report`
                ref: packages/core/src/subagent.ts#childSystemPrompt
                emits: [report]
              - lane: loop
                beat:
                  title: รายงานกลับมาแทน SKILL.md
                  text: Geno เขียนข้อความผลไว้ใน log ผลนี้ถึง model ตอนเรียกครั้งถัดไป ระหว่างนี้ model ไม่ได้ตอบอะไร ผลของ call คือรายงานที่ห่อด้วยแท็ก `<subagent_report>` ไม่ใช่เนื้อหา SKILL.md บทสนทนาของแม่จึงไม่บวมด้วยคำสั่งของ skill และงานระหว่างทาง
                  from: engine
                  to: engine
                at: tools
                do: >-
                  ผลของ call `skill` คือรายงานในรั้ว `<subagent_report agent="worker" ...>` ไม่ใช่เนื้อหา SKILL.md
                  context ของแม่จึงไม่บวมด้วยคำสั่งของสกิลและงานระหว่างทาง
                ref: packages/core/src/subagent.ts#childReport
                emits: [subagent_report, child-end]
              - use: tool-result-returns
              - lane: loop
                beat:
                  title: Geno ส่งรายงานให้ model ของแม่
                  text: Geno ส่งบทสนทนาทั้งหมดไปให้ model ของแม่อีกครั้งในคำขอใหม่ ท้ายคำขอคือ call ของ model และรายงานของ worker model จะอ่านรายงานแล้วเล่าให้คุณ การ์ดข้างล่างเป็นคำขอจากการบันทึกเดียวกัน ที่ model เรียก `agent` ให้ worker ทำงานตรงๆ แทนการเรียก skill รายงานกลับมาแบบเดียวกัน ดูบล็อก `tool_result` ที่ `content` ขึ้นต้นด้วย `<subagent_report` และบอกสถานะ จำนวน turn และค่าใช้จ่ายของ worker
                  from: engine
                  to: model
                  sees:
                    kind: payload
                    source: packages/docs/src/data/recorded/worker-blocking.jsonl#line=10
                    select: messages
                    collapse: ['[0]']
                    highlight: ['[1].content[1]', '[2].content[0]']
                  end: Model เล่ารายงาน
                at: step
                do: >-
                  `loopStep` ตัดสิน `call-model` model ของแม่อ่านรายงานแล้วเล่าให้ผู้ใช้
                ref: packages/core/src/loop.ts#loopStep
                emits: [call-model]
                phase: calling-model
                end: { turn: continues, reason: call-model }
---

สกิล ([skill](/start/glossary/)) คือคำแนะนำที่โหลดเมื่อต้องใช้: ข้อความแรกของ session มีแค่ชื่อกับคำอธิบาย (รวมไม่เกิน 8,000 ตัวอักษร)
เนื้อหาเต็มเข้ามาเมื่อ model เรียก `skill` หรือเมื่อผู้ใช้พิมพ์ `/ชื่อสกิล` ([คำสั่ง / ที่กลายเป็น prompt](/scenarios/ext/slash-template/))

สิ่งที่ควรสังเกต

- **`context: fork` มีผลเฉพาะเมื่อ model เรียก** ผู้ใช้ที่พิมพ์ `/release-notes` ได้สกิลเป็น [context item](/scenarios/ext/slash-template/) ใน turn ของตัวเองเสมอ
- **สกิลไม่ขยายสิทธิ์** คำอธิบายของ tool บอก model ว่าสกิลเป็นข้อมูลจากไฟล์ คำสั่งในสกิลยังต้องผ่านกฎ การ์ด และ sandbox เหมือนเดิม
- **สกิลของ plugin** ชื่อขึ้นต้นด้วยชื่อ plugin เช่น `pstack:how` โฟลเดอร์ของ plugin อ่านได้แต่แก้ไม่ได้
- **ไม่เจอสกิล** model ได้ error ที่บอกรายชื่อสกิลที่เรียกได้ แล้วเลือกใหม่ได้ในรอบถัดไป
