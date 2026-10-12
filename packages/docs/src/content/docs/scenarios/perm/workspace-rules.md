---
title: "กฎของ workspace อนุญาตหรือปฏิเสธคำสั่ง"
description: กฎ allow ที่ผู้ใช้บันทึกไว้ทำให้คำสั่งรันโดยไม่ถาม กฎ deny ปฏิเสธคำสั่งก่อนถึงการ์ดหรือ classifier และแผงขึ้นป้าย Denied by a rule
tableOfContents: false
sidebar:
  order: 4
scenario:
  surface: vscode
  given:
    - turn กำลังทำงานในโหมด Ask (โหมด Auto ได้ผลเหมือนกัน)
    - workspace มีกฎสองข้อที่ผู้ใช้ตั้งใน Settings ส่วน Permissions คือ allow `make` และ deny `git push`
    - ไม่มี hook ที่ตั้งไว้
  trigger: >-
    โมเดลขอเรียก `bash` ด้วยคำสั่งที่กฎข้อใดข้อหนึ่งครอบคลุม
  covers: [perm.allow-rule-covers, perm.deny-rule]
  related: [perm.always-allow-workspace, perm.ask-allow, perm.auto-classifier-allows, tool.bash-safe-runs]
  steps:
    - id: asks
      lane: model
      beat:
        title: "Model ขอรันคำสั่ง"
        text: >-
          คุณตั้งกฎไว้ใน Settings ส่วน Permissions สองข้อ อนุญาต `make` และห้าม `git push`
          โมเดลขอรันคำสั่งที่กฎข้อใดข้อหนึ่งครอบ แชตขึ้นขั้นใหม่พร้อมจุดหมุน
        from: model
        to: engine
      do: >-
        โมเดลขอเรียก `bash` และจบคำตอบด้วย `stop_reason: tool_use`
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
          Geno ดูกฎห้ามก่อน แล้วกฎถาม แล้วกฎในตัวของ Geno แล้วจึงกฎอนุญาต ลองเลือกคำสั่ง
        from: engine
        to: engine
        ask: "คำสั่งไหน"
      do: >-
        `approveCommand` อ่านกฎของ workspace แล้วให้ `ruledDenial` ตัดสินตามลำดับ: กฎ deny ก่อน แล้วกฎ ask
        แล้วกฎในตัวของ Geno แล้วจึงกฎ allow
      ref: packages/core/src/permission-rules.ts#ruledDenial
      fork:
        ask: โมเดลขอรันคำสั่งไหน
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
                    กฎอนุญาตไม่ได้ยกเว้น sandbox คำสั่งรันเหมือนคำสั่งในรายการปลอดภัย แล้วผลกลับมาที่แชต
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
                    Geno เรียกโมเดลต่อ โมเดลได้อ่านผล
                  from: engine
                  to: model
                  end: "กฎอนุญาต turn ทำต่อ"
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
                    กฎห้ามของคุณตรงกับ `git push origin main` ก่อนถึงกฎในตัว Geno จดรูปแบบของกฎและที่เก็บกฎไว้ run
                    จริงด้านล่างโดนกฎห้ามของ workspace แบบเดียวกัน
                  from: engine
                  to: engine
                  sees:
                    kind: payload
                    direction: tool_result
                    source: docs/results/real-usecases/runs/A14-deny-rules/1/session.jsonl#seq=5
                    select: approval
                    highlight:
                      - rule
                      - reason
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
                    ไม่ถามคุณ ไม่ส่งให้ classifier และ hook ก็ตอบแทนไม่ได้ การปฏิเสธนี้ไม่จบ turn
                  from: engine
                  to: model
                do: >-
                  `settle` เห็น verdict `deny` จึงปฏิเสธเองโดยไม่ถามใคร ไม่ส่งให้ classifier และ PermissionRequest hook ก็ตอบแทนไม่ได้
                  บันทึก `decidedBy: rule` แล้ว `refusalOf` สร้าง `ToolDenied` ซึ่งไม่จบ turn
                ref: packages/engine/src/tools/agent.ts#refusalOf
                emits: [ToolDenied]
              - lane: tool
                at: executor
                beat:
                  title: "คำสั่งไม่รัน ผลบอกให้อย่าลองซ้ำ"
                  text: >-
                    ผลบอกโมเดลว่ากฎของ workspace ห้ามคำสั่งนี้ อย่าลองซ้ำ ให้หาทางอื่นหรือบอกว่ากฎหยุดไว้ Geno
                    บันทึกผลพร้อมบันทึกการปฏิเสธแล้วส่งไปที่แชต
                  from: engine
                  to: model
                runs: 0
                do: >-
                  คำสั่งไม่ได้รัน ข้อความผลบอกโมเดลว่าอย่าลองซ้ำ ("denied: `git push origin main` matches the workspace rule
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
                    VS Code รู้ว่าเป็นกฎของคุณเอง จึงแสดงชื่อกฎ คำอธิบาย และปุ่มดูข้อความที่โมเดลได้รับ
                  from: panel
                  to: you
                  sees: { kind: step, label: git push origin main, status: denied, note: Denied by a rule (git push) · Your rule in Settings under Permissions blocks it. }
                alongside: true
                do: >-
                  ขั้นของคำสั่งขึ้นป้ายปฏิเสธพร้อมชื่อกฎ คำอธิบาย และปุ่มดูข้อความที่โมเดลได้รับ
                sees: >-
                  ป้าย "Denied by a rule (git push)" ใต้ขั้นมี "Your rule in Settings under Permissions blocks it." และลิงก์ Show details
                ref: packages/extension/src/chat/render.ts#DENIED_BY
              - lane: loop
                at: step
                beat:
                  title: "Model หาทางอื่นหรือบอกคุณ"
                  text: >-
                    คุณไม่ได้เป็นคนปฏิเสธ turn จึงไม่จบ Geno เรียกโมเดลต่อ โมเดลอ่านว่ากฎหยุดมันไว้
                  from: engine
                  to: model
                  end: "กฎห้าม turn ทำต่อ"
                do: >-
                  `loopStep` เห็น `tool-result` ล่าสุดและไม่มีการปฏิเสธจากผู้ใช้ จึงตัดสิน `call-model`
                  โมเดลอ่านว่ากฎหยุดมันไว้ แล้วหาทางอื่นหรือบอกผู้ใช้
                ref: packages/core/src/loop.ts#loopStep
                emits: [call-model]
                phase: calling-model
                end: { turn: continues, reason: call-model }
---

กฎของ workspace คือคำตอบที่ผู้ใช้ให้ไว้ล่วงหน้า เก็บในที่เก็บของ Geno ต่อ workspace ไม่ได้อยู่ใน repository
กฎมาได้จากปุ่ม "Always allow in this workspace" บนการ์ด จาก Settings ส่วน Permissions หรือนำเข้าจากไฟล์ settings ของ Claude Code

| ลำดับ | กฎ | ผล |
| --- | --- | --- |
| 1 | deny ตรง | ปฏิเสธ ไม่ถามใคร |
| 2 | ask ตรง | ถามผู้ใช้ แม้ในโหมด Auto |
| 3 | กฎในตัวไม่ติดธง | รัน |
| 4 | allow ครอบคลุมทุกคำสั่งที่ติดธง | รัน ไม่ถาม ไม่ส่ง classifier |
| 5 | ไม่ครอบคลุม | ตามกฎในตัว: การ์ดใน Ask, classifier ใน Auto |

สิ่งที่ควรสังเกต

- **deny ไม่จบ turn** การปฏิเสธโดยกฎเป็น `ToolDenied` โมเดลทำต่อ ต่างจากผู้ใช้กด Deny บนการ์ดซึ่งเป็น `ToolRejected` และจบ turn
- **allow ไม่ครอบคลุมทุกอย่าง** คำสั่งที่ต้องถามเสมอ เช่น `rm -rf` ของ workspace หรือคำสั่งที่มี path นอก workspace ซึ่งรูปแบบของกฎไม่ได้ครอบคลุม ยังถามอยู่
  `pnpm vitest run ../../x` จึงไม่ผ่านด้วยกฎ `pnpm vitest run`
- **Plan ไม่อ่านกฎเลย** โหมด Plan ใช้เฉพาะคำตัดสินในตัว กฎ allow จึงไม่ทำให้คำสั่งรันใน Plan
- **ไม่มีคนดูแล้วไม่ใช้ allow** รอบที่ไม่มีคนดูยังเคารพ deny และ ask แต่ไม่ใช้ allow เพราะผู้ใช้บันทึก allow ไว้ตอนที่ดูอยู่

กฎที่ห้าม tool ทั้งตัว ดู [Geno ปฏิเสธก่อนถึงการถาม](/scenarios/perm/refused-before-asking/)
