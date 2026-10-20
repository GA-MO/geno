---
title: "โหมด Auto ให้ classifier ตัดสินคำสั่ง"
description: ในโหมด Auto คำสั่งที่กฎติดธงไปถึง classifier ไม่ใช่ผู้ใช้ classifier อนุญาต ปฏิเสธ ไม่แน่ใจ หรือตอบไม่ได้ และแต่ละทางให้ผลต่างกัน
scenario:
  surface: vscode
  given:
    - session อยู่ในโหมด Auto
    - ไม่มี hook ที่ตั้งไว้ และไม่มีกฎของ workspace ที่ตรงกับคำสั่ง
  trigger: >-
    model ขอเรียก `bash` ด้วยคำสั่ง `rm -rf dist` ซึ่งลบ path ใน workspace
  covers: [perm.auto-classifier-allows, perm.auto-classifier-denies, perm.classifier-unavailable]
  related: [perm.ask-allow, tool.bash-safe-runs, perm.auto-classifier-asks-user, perm.auto-hard-ask]
  steps:
    - id: asks
      lane: model
      beat:
        title: "Model ขอรัน rm -rf dist"
        text: >-
          session อยู่ในโหมด Auto model ขอลบโฟลเดอร์ `dist` ใน workspace
        from: model
        to: engine
      do: >-
        model ขอเรียก `bash` ด้วยคำสั่ง `rm -rf dist` และจบคำตอบด้วย `stop_reason: tool_use`
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
      beat:
        title: "แชตขึ้นขั้นของคำสั่ง"
        text: >-
          Geno จัดคิว `bash` ให้รันทีละตัว แชตขึ้นขั้นใหม่พร้อมจุดหมุน
        from: engine
        to: panel
        sees: { kind: step, label: rm -rf dist, status: running }

    - id: rules
      lane: policy
      at: rules
      beat:
        title: "Geno ตรวจคำสั่งกับกฎของคุณ"
        text: >-
          คำสั่งลบ path ใน workspace ในโหมด Ask แปลว่าถามคุณ แต่ในโหมด Auto แปลว่าให้ classifier ตัดสิน
          (คำสั่งที่มีแค่กฎ `unlisted` ติดธง เช่น `make build` รันใน sandbox เลยโดยไม่ถึง classifier)
        from: engine
        to: engine
      do: >-
        `approveCommand` ส่งคำสั่งให้ `ruledDenial` คำสั่งติดกฎ `rm-rf-in-workspace`
        ซึ่งในโหมด Ask แปลว่าถามผู้ใช้ แต่ในโหมด Auto แปลว่า `classify`
        ส่วนกฎ `unlisted` ในโหมด Auto คือ `allow` คำสั่งใน sandbox ที่มีแค่กฎนี้ติดธงจึงรันโดยไม่มี classifier
      ref: "packages/core/src/approval.ts#\"reason: 'rm -rf of a path inside the workspace',\""
      emits: [rm-rf-in-workspace, classify]

    - id: input
      lane: policy
      at: settle
      beat:
        title: "Geno เตรียมข้อมูลให้ classifier"
        text: >-
          classifier ได้ข้อความล่าสุดที่คุณพิมพ์ ข้อความล่าสุดของ model คำสั่ง กฎที่ติด เนื้อหาไฟล์ที่ session
          นี้แก้แล้วคำสั่งจะรัน (ถ้ามี) และโดเมนที่ workspace อนุญาต
        from: engine
        to: engine
      do: >-
        `settle` เห็นคำตัดสิน `classify` จึงเตรียมข้อมูลให้ classifier: ข้อความล่าสุดที่ผู้ใช้พิมพ์ ข้อความล่าสุดของ model
        คำสั่ง กฎที่ติด เนื้อหาไฟล์ที่ session นี้แก้แล้วคำสั่งจะรัน (ถ้ามี) และโดเมนที่ workspace อนุญาต
      ref: packages/engine/src/tools/agent.ts#settle

    - id: classify
      lane: policy
      at: classifier
      beat:
        title: "Classifier ตัดสินภายใน 8 วินาที"
        text: >-
          Geno เรียก model classifier บังคับให้ตอบเป็นคำตัดสิน ถ้าหมดเวลาหรือตอบไม่มีคำตัดสิน Geno ลองอีกครั้งเดียว
          ค่าใช้จ่ายนับรวมในงบของ turn ลองเลือกคำตอบของ classifier
        from: engine
        to: engine
        ask: "classifier ตอบอะไร"
      do: >-
        `commandClassifier` เรียก model classifier (ค่าเริ่มต้น `qwen3.8-flash` บน Model Studio)
        บังคับให้ตอบผ่าน tool `verdict` ภายใน 8 วินาที ถ้าหมดเวลาหรือตอบไม่มีคำตัดสินจะลองอีกครั้ง
        คำตอบ `ask` หรือ `deny` จริงไม่ลองซ้ำ ค่าใช้จ่ายของการเรียกนี้นับรวมในงบ $0.40 ของ turn
      ref: packages/engine/src/classifier.ts#commandClassifier
      fork:
        ask: classifier ตอบว่าอะไร
        options:
          - id: allow
            label: allow
            steps:
              - lane: policy
                at: settle
                beat:
                  title: "Classifier อนุญาต"
                  text: >-
                    คำสั่งรันได้โดยไม่มีการ์ด Geno จดว่า classifier เป็นผู้อนุญาตพร้อมเหตุผล
                  from: engine
                  to: panel
                do: >-
                  `settle` คืนบันทึก `decidedBy: classifier, verdict: allow` พร้อมเหตุผลของ classifier ไม่มีการ์ดและไม่ถามใคร
                ref: packages/engine/src/tools/agent.ts#settle
              - lane: tool
                at: shell
                beat:
                  title: "คำสั่งรันใน sandbox"
                  text: >-
                    การอนุญาตของ classifier ไม่ได้ยกเว้น sandbox คำสั่งรันเหมือนคำสั่งที่คุณอนุญาตเอง แล้วผลกลับมาที่แชต
                  from: engine
                  to: machine
                do: >-
                  `bash` รันคำสั่งใน sandbox เหมือนคำสั่งที่ผู้ใช้อนุญาต การอนุญาตของ classifier ไม่ได้ยกเว้น sandbox
                ref: "packages/engine/src/tools/agent.ts#\"const result = await tools.sandbox.run(command, {\""
              - use: tool-result-returns
              - lane: panel
                at: rail
                beat:
                  title: "แชตติดป้าย Auto-approved"
                  text: >-
                    ใต้ขั้นของคำสั่งมีป้ายพร้อมเหตุผลของ classifier ป้ายแสดงเมื่อแชตวาดทุกขั้น
                  from: panel
                  to: you
                  sees: { kind: step, label: rm -rf dist, status: done, note: Auto-approved · Removes build output that the build regenerates. }
                do: >-
                  `autoOf` อ่านบันทึกการอนุญาตใน `APPROVAL_META` แล้วติดป้าย Auto พร้อมเหตุผลไว้ใต้ขั้นของคำสั่ง
                  ป้ายแสดงเมื่อแผงวาดทุกขั้น (ตั้ง detail เป็น full หรือเปิด turn ออก)
                sees: >-
                  ป้าย "Auto-approved" ตามด้วยเหตุผลของ classifier เช่น "Removes build output that the build regenerates."
                ref: packages/extension/src/chat/render.ts#autoNote
              - lane: loop
                at: step
                beat:
                  title: "Model อ่านผลของคำสั่ง"
                  text: >-
                    Geno เรียก model ต่อ model ได้อ่านผลของคำสั่ง
                  from: engine
                  to: model
                  end: "classifier อนุญาต turn ทำต่อ"
                do: >-
                  `loopStep` เห็น `tool-result` ล่าสุดจึงตัดสิน `call-model` model ได้อ่านผลของคำสั่ง
                ref: packages/core/src/loop.ts#loopStep
                emits: [call-model]
                phase: calling-model
                end: { turn: continues, reason: call-model }
          - id: deny
            label: deny หรือ ask
            steps:
              - lane: policy
                at: settle
                beat:
                  title: "Classifier ไม่ยอม คำสั่งถูกปฏิเสธโดยไม่มีการ์ด"
                  text: >-
                    classifier ตอบ `deny` หรือ `ask` ก็ตาม คำสั่งไม่ได้รัน ไม่มีการ์ดขึ้น และ turn ไม่จบ ต่างจากตอนคุณกด Deny
                    ถ้า session นี้ถูกปฏิเสธแบบนี้ติดกันครบ 3 ครั้งหรือรวมครบ 20 ครั้งแล้ว ครั้งถัดไปจะขึ้นการ์ดถามคุณแทน
                  from: engine
                  to: model
                do: >-
                  `settle` นับ block ของ session จาก log ด้วย `autoBlocksOf` ถ้า `autoFallsBack` ยังไม่จริง
                  ก็คืนบันทึก `decidedBy: classifier, verdict: deny` โดยเก็บคำตอบของ classifier เองไว้ใน `classifier`
                  PermissionRequest hook ไม่ถูกถามเพราะไม่มีการ์ด `refusalOf` สร้าง `ToolDenied` ไม่ใช่ `ToolRejected`
                ref: packages/engine/src/tools/agent.ts#settle
                emits: [ToolDenied]
              - lane: loop
                at: tools
                beat:
                  title: "Geno ส่งเหตุผลกลับไปหา model"
                  text: >-
                    ผลของ call บอก model ว่า classifier ของ Auto ปฏิเสธพร้อมเหตุผล model หาทางอื่นที่สมเหตุผลได้
                    หรือหยุดอธิบายให้คุณฟังในคำตอบว่าต้องการสิทธิ์อะไร แล้วผลกลับมาที่แชต
                  from: engine
                  to: model
                do: >-
                  ผลของ call มีสถานะ `denied` ข้อความเป็น "Auto mode's safety classifier refused `rm -rf dist`, so it did not run:"
                  ตามด้วยเหตุผล และถ้อยคำแบบ dontAsk ของ Claude Code (`DONT_ASK`)
                ref: packages/engine/src/tools/agent.ts#denialText
                emits: [denied]
              - use: tool-result-returns
              - lane: panel
                at: rail
                beat:
                  title: "แชตขึ้น Denied by Auto"
                  text: >-
                    ขั้นของคำสั่งขึ้นป้ายปฏิเสธของ Auto พร้อมเหตุผล ข้อความเต็มที่ model ได้อยู่หลัง Show details
                  from: panel
                  to: you
                  sees: { kind: step, label: rm -rf dist, status: denied, note: Denied by Auto · Show details }
                do: >-
                  `denialOf` เห็นว่าผู้ปฏิเสธคือ classifier จึงแสดงป้ายปฏิเสธของ Auto พร้อมเหตุผล
                  ข้อความเต็มที่ model ได้อยู่หลัง Show details
                sees: '"Denied by Auto" ตามด้วยเหตุผลของ classifier และลิงก์ "Show details"'
                ref: packages/extension/src/chat/session-updates.ts#denialOf
              - lane: loop
                at: step
                beat:
                  title: "Model หาทางอื่น"
                  text: >-
                    Geno เรียก model ต่อ model อ่านคำปฏิเสธแล้วหาทางอื่น หรือถามคุณเป็นข้อความ
                  from: engine
                  to: model
                  end: "classifier ไม่ยอม turn ทำต่อ"
                do: >-
                  `loopStep` ตัดสิน `call-model` model อ่านคำปฏิเสธแล้วหาทางอื่นต่อ หรือถามผู้ใช้ในคำตอบ
                ref: packages/core/src/loop.ts#loopStep
                emits: [call-model]
                phase: calling-model
                end: { turn: continues, reason: call-model }
          - id: unevaluated
            label: ประเมินไม่ได้ (ช้าเกินหรือไม่มีคำตัดสินทั้งสองครั้ง)
            steps:
              - lane: policy
                at: classifier
                beat:
                  title: "Classifier ประเมินคำสั่งนี้ไม่ได้"
                  text: >-
                    classifier ช้าเกิน 8 วินาทีหรือตอบไม่มีคำตัดสินทั้งสองครั้ง หรือ request ล้มเหลว
                    Geno ไม่เดาว่าคำสั่งปลอดภัย
                  from: engine
                  to: engine
                do: >-
                  `commandClassifier` คืน `ask` ที่มี `failure: 'unevaluated'` พร้อมเหตุผลว่าอะไรล้ม
                ref: packages/engine/src/classifier.ts#commandClassifier
                emits: [ask]
              - lane: policy
                at: settle
                beat:
                  title: "Geno ปฏิเสธและนับเป็น block"
                  text: >-
                    คำสั่งไม่ได้รันและไม่มีการ์ด model ได้ข้อความว่า Auto ประเมินคำสั่งไม่ได้ ครั้งนี้นับเป็น block
                    classifier ที่ล้มซ้ำๆ จึงยังมาถึงการ์ดของคุณหลังครบ 3 ครั้งติดกัน
                  from: engine
                  to: model
                  end: "classifier ประเมินไม่ได้ turn ทำต่อ"
                do: >-
                  `settle` ปฏิเสธเหมือนคำตอบ `deny` (`decidedBy: classifier, verdict: deny`) จนกว่า `autoFallsBack`
                  `denialText` เขียนว่า "Auto mode could not evaluate `rm -rf dist` (...), so it did not run." ตามด้วย `DONT_ASK`
                ref: packages/engine/src/tools/agent.ts#denialText
                emits: [ToolDenied, denied]
                end: { turn: continues, reason: call-model }
          - id: unavailable
            label: ใช้ไม่ได้ (ปิด ไม่มี key หรือ key ถูกปฏิเสธ)
            steps:
              - lane: policy
                at: classifier
                beat:
                  title: "Classifier ใช้ไม่ได้เลย"
                  text: >-
                    classifier ถูกปิด ไม่มี key หรือผู้ให้บริการปฏิเสธ key หรือ model Geno ไม่เดาว่าคำสั่งปลอดภัย
                    แชตขึ้นข้อความครั้งเดียวว่า classifier ของ Auto ใช้ไม่ได้
                  from: engine
                  to: engine
                do: >-
                  `commandClassifier` ไม่ได้คำตัดสินจริง: `GCODE_CLASSIFIER_MODEL=off`, ผู้ให้บริการของ classifier ไม่มี key
                  หรือผู้ให้บริการปฏิเสธ key หรือ model ทุกกรณีคืน `ask` ที่มี `failure: 'unavailable'`
                  เมื่อตั้งค่าไม่ได้ หรือผู้ให้บริการปฏิเสธ key หรือ model `onBroken` แจ้ง engine ซึ่งบอกผู้ใช้ครั้งเดียวต่อ session
                ref: packages/engine/src/classifier.ts#commandClassifier
                emits: [ask]
              - lane: policy
                at: settle
                beat:
                  title: "Geno ถามคุณแทน"
                  text: >-
                    ถ้าปฏิเสธแทน ทุกคำสั่งที่ติดธงจะไม่ได้รันเลย Geno จึงขึ้นการ์ดถามคุณทุกครั้ง และไม่นับเป็น block
                  from: engine
                  to: panel
                do: >-
                  `settle` ส่ง `ask` ที่มี `failure: 'unavailable'` ให้ PermissionRequest hook แล้วให้ผู้ใช้ผ่าน `approve`
                  และไม่นับเป็น block
                ref: packages/engine/src/tools/agent.ts#settle
                emits: [ask-user]
                phase: waiting-user
                goto: perm.auto-classifier-asks-user
---

โหมด Auto ไม่ได้แปลว่าทุกอย่างผ่าน มันแปลว่า**ไม่มีใครถูกถาม**จนกว่าจะจำเป็น
คำสั่งใน safe list ยังรันทันทีเหมือนโหมด Ask คำสั่งใน sandbox ที่มีแค่กฎ `unlisted` ติดธง และ `git push` ธรรมดาไป branch ของ repo
รันตามกฎโดยไม่มี classifier ส่วนคำสั่งที่กฎอื่นติดธงไปที่ classifier คำสั่งที่ย้อนไม่ได้ เช่น `rm -rf` ของ workspace ทั้งก้อน ยังขึ้นการ์ดถามผู้ใช้เสมอ

| classifier ตอบ | Auto ทำอะไร |
| --- | --- |
| `allow` | รัน |
| `deny` หรือ `ask` | ปฏิเสธ ส่งเหตุผลกลับไปหา model นับเป็น block |
| ประเมินไม่ได้ | ปฏิเสธ บอก model ว่า Auto ประเมินไม่ได้ นับเป็น block |
| ใช้ไม่ได้เลย | ขึ้นการ์ดถามผู้ใช้ ไม่นับ |

สิ่งที่ควรสังเกต

- **block ครบแล้วการ์ดจึงขึ้น** block ติดกัน 3 ครั้งหรือรวม 20 ครั้งใน session ทำให้ block ถัดไปขึ้นการ์ดถามผู้ใช้แทน
  call ที่ได้รันตัดแถว block ที่ติดกัน subagent นับจาก log ของตัวเอง
- **classifier ที่ล่มไม่ได้แปลว่าอนุญาต** ประเมินไม่ได้ก็ปฏิเสธ ใช้ไม่ได้เลยก็ถามผู้ใช้ Geno จึงไม่รันคำสั่งที่ไม่มีใครตัดสิน
- **คำปฏิเสธของ classifier ไม่จบ turn** ต่างจากปุ่ม Reject บนการ์ด คำปฏิเสธของ classifier เป็น `ToolDenied`
  model อ่านเหตุผลแล้วทำต่อ
- **ป้าย Auto-approved ซ่อนในมุมมองย่อ** แผงแสดงป้ายนี้เฉพาะเมื่อวาดทุกขั้น ส่วนป้าย "Denied by Auto" แสดงเสมอ

เมื่อ Auto ยังต้องถามคุณ ดู [โหมด Auto ยังขึ้นการ์ดถามคุณ](/scenarios/perm/auto-still-asks/)
