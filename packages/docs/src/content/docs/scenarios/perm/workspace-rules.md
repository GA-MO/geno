---
title: "กฎของ workspace อนุญาตหรือปฏิเสธคำสั่ง"
description: กฎ allow ที่ผู้ใช้บันทึกไว้ทำให้คำสั่งรันโดยไม่ถาม กฎ deny ปฏิเสธคำสั่งก่อนถึงการ์ดหรือ classifier และแผงขึ้นป้าย Denied by a rule
scenario:
  surface: vscode
  given:
    - turn กำลังทำงานในโหมด Ask (โหมด Auto ได้ผลเหมือนกัน)
    - workspace มีกฎสองข้อที่ผู้ใช้ตั้งใน Settings ส่วน Permissions คือ allow `make` และ deny `git push`
    - ไม่มี hook ที่ตั้งไว้
  trigger: >-
    model ขอเรียก `bash` ด้วยคำสั่งที่กฎข้อใดข้อหนึ่งครอบคลุม
  covers: [perm.allow-rule-covers, perm.deny-rule]
  related: [perm.always-allow-workspace, perm.ask-allow, perm.auto-classifier-allows, tool.bash-safe-runs]
  steps:
    - id: asks
      lane: model
      beat:
        title: "Model ขอรันคำสั่ง"
        text: >-
          คุณตั้งกฎไว้ใน Settings ส่วน Permissions สองข้อ อนุญาต `make` และห้าม `git push`
          model ขอรันคำสั่งที่กฎข้อใดข้อหนึ่งครอบ แชตขึ้นขั้นใหม่พร้อมจุดหมุน การ์ดข้างล่างเป็นคำตอบจริงของ model
          ในการรันที่ใช้ในทางกฎห้าม model ขอ `bash` ที่จะ `ls` โฟลเดอร์ `secrets` ซึ่งกฎห้ามของ workspace ครอบ
          ดู `input` ที่ไฮไลต์
        from: model
        to: engine
        sees:
          kind: payload
          source: docs/results/real-usecases/runs/A14-deny-rules/1/session.jsonl#seq=4
          select: content
          collapse: ['[0].thinking']
          highlight: ['[2].input']
      do: >-
        model ขอเรียก `bash` และจบคำตอบด้วย `stop_reason: tool_use`
      ref: "packages/engine/src/gateway.ts#\"stopReason: message.stop_reason,\""
      emits: [tool_use]
      phase: calling-model

    - id: logged
      lane: loop
      at: drive
      do: >-
        `drive` บันทึก event `assistant` ที่มีบล็อก `tool_use` ลง log
      ref: "packages/engine/src/drive.ts#\"await record({ kind: 'assistant', seq: nextSeq(events), at, ...result.turn\""
      emits: [assistant]

    - use: tool-call-opens

    - id: rules
      lane: policy
      at: rules
      beat:
        title: "Geno ตรวจกฎตามลำดับ"
        text: >-
          Geno ดูกฎห้ามก่อน แล้วกฎถาม แล้วกฎในตัวของ Geno (เช่น safe list) แล้วจึงกฎอนุญาต ลองเลือกคำสั่ง
        from: engine
        to: engine
        ask: "คำสั่งไหน"
      do: >-
        `approveCommand` อ่านกฎของ workspace แล้วให้ `ruledDenial` ตัดสินตามลำดับ: กฎ deny ก่อน แล้วกฎ ask
        แล้วกฎในตัวของ Geno แล้วจึงกฎ allow
      ref: packages/core/src/permission-rules.ts#ruledDenial
      fork:
        ask: model ขอรันคำสั่งไหน
        options:
          - id: allow
            label: make check (กฎ allow ครอบคลุม)
            steps:
              - lane: policy
                at: rules
                beat:
                  title: "กฎอนุญาตของคุณครอบ make check"
                  text: >-
                    `make check` ไม่อยู่ในรายการคำสั่งปลอดภัย แต่กฎ `make` ของคุณครอบคำสั่งนี้ จึงไม่มีการ์ด ไม่มี classifier
                    และไม่มีบันทึกการอนุญาตติดไปกับผล
                  from: engine
                  to: engine
                do: >-
                  ไม่มีกฎ deny หรือ ask ตรง กฎในตัวติดธง `make check` ว่า `unlisted` เพราะไม่อยู่ใน safe list
                  แต่กฎ allow `make` ครอบคลุมคำสั่งนี้ (คำของคำสั่งขึ้นต้นด้วยรูปแบบของกฎ และไม่ใช่คำสั่งที่ต้องถามเสมอ)
                  `ruledDenial` จึงคืนว่าไม่มี denial ไม่มีการ์ด ไม่มี classifier และไม่มีบันทึกการอนุญาตติดไปกับผล
                ref: "packages/core/src/permission-rules.ts#\"if ([...flagged].every(isCovered)) return undefined;\""
              - lane: tool
                at: shell
                beat:
                  title: "make check รันใน sandbox"
                  text: >-
                    กฎอนุญาตไม่ได้ยกเว้น sandbox (กรอบของระบบปฏิบัติการที่ให้คำสั่งเขียนไฟล์ได้แค่ใน workspace กับโฟลเดอร์ชั่วคราว)
                    คำสั่งรันเหมือนคำสั่งในรายการปลอดภัย แล้วผลกลับมาที่แชต
                  from: engine
                  to: machine
                  sees: { kind: step, label: make check, status: done }
                do: >-
                  `bash` รัน `make check` ใน sandbox เหมือนคำสั่งใน safe list กฎ allow ไม่ได้ยกเว้น sandbox
                ref: "packages/engine/src/tools/agent.ts#\"const result = await tools.sandbox.run(command, {\""
              - use: tool-result-returns
              - lane: loop
                at: step
                beat:
                  title: "Model อ่านผลของคำสั่ง"
                  text: >-
                    Geno ส่งบทสนทนาทั้งหมดไปให้ model อีกครั้งในคำขอใหม่ ท้ายคำขอคือคำขอ `bash` ของ model และผลของคำสั่ง
                    model ได้อ่านผลตรงนี้ การ์ดข้างล่างเป็นข้อความท้ายสุดของคำขอจริงจากการรันเดียวกับการ์ดอื่นในหน้านี้
                    บทสนทนาก่อนหน้ายาวเกินกว่าจะแสดงทั้งหมด คำสั่งในรอบนั้นคือ
                    `git ls-files` ซึ่งรันโดยไม่มีการ์ดเหมือนกัน แต่ผ่านเพราะอยู่ในรายการคำสั่งปลอดภัย ไม่ใช่เพราะกฎอนุญาต
                    ดู `tool_result` ที่ไฮไลต์ ซึ่งเป็นรายชื่อไฟล์ที่คำสั่งพิมพ์ออกมา
                  from: engine
                  to: model
                  end: "กฎอนุญาต turn ทำต่อ"
                  sees:
                    kind: payload
                    source: docs/results/real-usecases/runs/A14-deny-rules/1/requests.jsonl#seq=33
                    select: messages[-1]
                    highlight: ['content[0]']
                do: >-
                  `loopStep` เห็น `tool-result` ล่าสุดจึงตัดสิน `call-model`
                ref: packages/core/src/loop.ts#loopStep
                emits: [call-model]
                phase: calling-model
                end: { turn: continues, reason: call-model }
          - id: deny
            label: git push origin main (กฎ deny ตรง)
            steps:
              - lane: policy
                at: rules
                beat:
                  title: "กฎห้าม git push ตรงก่อนกฎอื่น"
                  text: >-
                    กฎห้ามของคุณตรงกับ `git push origin main` ก่อนถึงกฎในตัว Geno จดรูปแบบของกฎและที่เก็บกฎไว้
                    การ์ดเป็นบันทึกจาก run จริงที่โดนกฎห้ามของ workspace แบบเดียวกัน ในรันนั้นกฎคือ `Read(secrets/**)` และรันนั้นเป็นแบบไม่มีคนดู ช่อง `mode` จึงเป็น `non-interactive` ผลเหมือนกันในทุกโหมดที่อ่านกฎ
                    ดู `rule` ที่เป็น `workspace-deny` และ `reason` ที่บอกว่ากฎไหนและเก็บไว้ที่ไหน
                  from: engine
                  to: engine
                  sees:
                    kind: payload
                    source: docs/results/real-usecases/runs/A14-deny-rules/1/session.jsonl#seq=5
                    highlight: [approval.rule, approval.reason]
                do: >-
                  กฎ deny `git push` ตรงกับคำสั่งก่อนจะถึงกฎในตัว `userRuleDenial` สร้าง denial ชนิด `workspace-deny`
                  ที่บอกรูปแบบของกฎและที่เก็บกฎ ("the workspace rule that denies `git push`, which the user set in Settings under Permissions")
                ref: packages/core/src/permission-rules.ts#userRuleDenial
                emits: [workspace-deny]
              - lane: policy
                at: settle
                beat:
                  title: "Geno ปฏิเสธเองโดยไม่ถามใคร"
                  text: >-
                    ไม่ถามคุณ ไม่ส่งให้ classifier (การเรียก model แยกที่ตัดสินแทนคุณในโหมด Auto)
                    และ hook (คำสั่ง shell ที่คุณตั้งให้ตอบคำถามสิทธิ์แทนได้) ก็ตอบแทนไม่ได้ การปฏิเสธนี้ไม่จบ turn
                  from: engine
                  to: engine
                do: >-
                  `settle` เห็น verdict `deny` จึงปฏิเสธเองโดยไม่ถามใคร ไม่ส่งให้ classifier และ PermissionRequest hook ก็ตอบแทนไม่ได้
                  บันทึก `decidedBy: rule` แล้ว `refusalOf` สร้าง `ToolDenied` ซึ่งไม่จบ turn
                ref: packages/engine/src/tools/agent.ts#refusalOf
                emits: [ToolDenied]
              - lane: tool
                at: executor
                beat:
                  title: "คำสั่งไม่รัน Geno เตรียมผลว่าอย่าลองซ้ำ"
                  text: >-
                    Geno เขียนข้อความผลไว้ใน log ผลนี้ถึง model ตอนเรียกครั้งถัดไป ระหว่างนี้ model ไม่ได้ตอบอะไร
                    คำสั่งไม่รัน ผลบอกว่ากฎของ workspace ห้ามคำสั่งนี้ อย่าลองซ้ำ ให้หาทางอื่นหรือบอกว่ากฎหยุดไว้ Geno
                    บันทึกผลพร้อมบันทึกการปฏิเสธแล้วส่งไปที่แชต
                  from: engine
                  to: engine
                runs: 0
                do: >-
                  คำสั่งไม่ได้รัน ข้อความผลบอก model ว่าอย่าลองซ้ำ ("denied: `git push origin main` matches the workspace rule
                  that denies `git push`, ... Do not retry it; find another way, or say in your answer that the rule stops you.")
                ref: packages/engine/src/tools/agent.ts#denialText
                emits: [denied]
              - lane: loop
                at: tools
                do: >-
                  `runTools` บันทึก `tool-result` สถานะ `denied` พร้อมบันทึกการปฏิเสธ
                ref: "packages/engine/src/drive.ts#\"for (const result of outcome.results) if (result !== undefined) await record(result);\""
                emits: [tool-result]
              - lane: server
                at: updates
                do: >-
                  `toolResultUpdate` ส่ง `tool_call_update` สถานะ `failed` พร้อม `APPROVAL_META`
                ref: packages/engine/src/session-replay.ts#toolResultUpdate
                emits: [tool_call_update, APPROVAL_META]
              - lane: editor
                at: chat
                alongside: true
                do: >-
                  `denialOf` อ่านบันทึกแล้วรู้ว่าเป็นกฎของผู้ใช้เอง จึงดึงรูปแบบ `git push` และที่เก็บกฎออกมาเป็นคำอธิบาย
                ref: packages/extension/src/chat/session-updates.ts#denialOf
              - lane: panel
                at: rail
                beat:
                  title: "แชตขึ้นป้าย Denied by a rule (git push)"
                  text: >-
                    VS Code รู้ว่าเป็นกฎของคุณเอง จึงแสดงชื่อกฎ คำอธิบาย และปุ่มดูข้อความที่ model ได้รับ
                  from: panel
                  to: you
                  sees: { kind: step, label: git push origin main, status: denied, note: Denied by a rule (git push) · Your rule in Settings under Permissions blocks it. }
                alongside: true
                do: >-
                  ขั้นของคำสั่งขึ้นป้ายปฏิเสธพร้อมชื่อกฎ คำอธิบาย และปุ่มดูข้อความที่ model ได้รับ
                sees: >-
                  ป้าย "Denied by a rule (git push)" ใต้ขั้นมี "Your rule in Settings under Permissions blocks it." และลิงก์ Show details
                ref: packages/extension/src/chat/render.ts#DENIED_BY
              - lane: loop
                at: step
                beat:
                  title: "Model หาทางอื่นหรือบอกคุณ"
                  text: >-
                    คุณไม่ได้เป็นคนปฏิเสธ turn จึงไม่จบ Geno ส่งบทสนทนาทั้งหมดไปให้ model อีกครั้งในคำขอใหม่
                    ท้ายคำขอคือคำขอ `bash` ของ model และผลปฏิเสธที่ Geno เตรียมไว้ model อ่านว่ากฎหยุดมันไว้
                    การ์ดข้างล่างเป็นคำขอจริงจากการรันเดียวกับการ์ดก่อนหน้า ในรอบนั้น model ขอ `bash` คู่กับ `glob`
                    ข้อความท้ายจึงมีผลสองชิ้น ชิ้นแรกคือคำปฏิเสธ
                  from: engine
                  to: model
                  end: "กฎห้าม turn ทำต่อ"
                  sees:
                    kind: payload
                    source: docs/results/real-usecases/runs/A14-deny-rules/1/requests.jsonl#seq=8
                    select: messages
                    collapse: ['[0]']
                    highlight: ['[1].content[2]', '[2].content[0]']
                do: >-
                  `loopStep` เห็น `tool-result` ล่าสุดและไม่มีการปฏิเสธจากผู้ใช้ จึงตัดสิน `call-model`
                  model อ่านว่ากฎหยุดมันไว้ แล้วหาทางอื่นหรือบอกผู้ใช้
                ref: packages/core/src/loop.ts#loopStep
                emits: [call-model]
                phase: calling-model
                end: { turn: continues, reason: call-model }
---

กฎของ workspace คือคำตอบที่ผู้ใช้ให้ไว้ล่วงหน้า มาได้สองที่
กฎจากปุ่ม "Always allow in this workspace" บนการ์ด และจาก Settings ส่วน Permissions เก็บในที่เก็บของ Geno ต่อ workspace ไม่ได้อยู่ใน repository
อีกที่คือไฟล์ settings ในโปรเจกต์ เช่น `.g-code/settings.json` ของ Geno หรือ `.claude/settings.json` ของ Claude Code
ซึ่งอยู่ใน repository run จริงในการ์ดของหน้านี้ใช้กฎจาก `.g-code/settings.json`
repository ที่คุณ clone มาจึงสั่งให้คำสั่งรันโดยไม่ถามเองไม่ได้ กฎ allow จากไฟล์ในโปรเจกต์รอจนคุณเชื่อถือ workspace
ใน VS Code (workspace trust) ส่วนกฎ deny และ ask จากไฟล์เหล่านั้นใช้ทันที
คำอย่าง classifier, hook และ sandbox ดูได้ที่ [คำศัพท์](/start/glossary/)

| ลำดับ | กฎ | ผล |
| --- | --- | --- |
| 1 | deny ตรง | ปฏิเสธ ไม่ถามใคร |
| 2 | ask ตรง | ถามผู้ใช้ แม้ในโหมด Auto |
| 3 | กฎในตัวไม่ติดธง | รัน |
| 4 | allow ครอบคลุมทุกคำสั่งที่ติดธง | รัน ไม่ถาม ไม่ส่ง classifier |
| 5 | ไม่ครอบคลุม | ตามกฎในตัว: การ์ดใน Ask, classifier ใน Auto |

สิ่งที่ควรสังเกต

- **deny ไม่จบ turn** การปฏิเสธโดยกฎเป็น `ToolDenied` model ทำต่อ ต่างจากผู้ใช้กด Deny บนการ์ดซึ่งเป็น `ToolRejected` และจบ turn
- **allow ไม่ครอบคลุมทุกอย่าง** คำสั่งที่ต้องถามเสมอ เช่น `rm -rf` ของ workspace หรือคำสั่งที่มี path นอก workspace ซึ่งรูปแบบของกฎไม่ได้ครอบคลุม ยังถามอยู่
  `pnpm vitest run ../../x` จึงไม่ผ่านด้วยกฎ `pnpm vitest run`
- **Plan ไม่อ่านกฎเลย** โหมด Plan ใช้เฉพาะคำตัดสินในตัว กฎ allow จึงไม่ทำให้คำสั่งรันใน Plan
- **ไม่มีคนดูแล้วไม่ใช้ allow** รอบที่ไม่มีคนดู (การรันที่ไม่มีใครตอบการ์ด เช่น `gcode agent --non-interactive` ในสคริปต์) ยังเคารพ deny และ ask แต่ไม่ใช้ allow เพราะผู้ใช้บันทึก allow ไว้ตอนที่ดูอยู่

กฎที่ห้าม tool ทั้งตัว ดู [Geno ปฏิเสธก่อนถึงการถาม](/scenarios/perm/refused-before-asking/)
