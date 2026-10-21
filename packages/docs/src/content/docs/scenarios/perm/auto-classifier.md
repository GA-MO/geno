---
title: "โหมด Auto ให้ classifier ตัดสินคำสั่ง"
description: ในโหมด Auto คำสั่งที่ไม่อยู่ใน safe list ไปถึง classifier ไม่ใช่ผู้ใช้ classifier อนุญาต ปฏิเสธ หรือไม่แน่ใจ และแต่ละทางให้ผลต่างกัน
scenario:
  surface: vscode
  given:
    - session อยู่ในโหมด Auto
    - ไม่มี hook ที่ตั้งไว้ และไม่มีกฎของ workspace ที่ตรงกับคำสั่ง
  trigger: >-
    model ขอเรียก `bash` ด้วยคำสั่ง `node scripts/build-icons.mjs` ซึ่งไม่อยู่ใน safe list
  covers: [perm.auto-classifier-allows, perm.auto-classifier-denies, perm.classifier-unavailable]
  related: [perm.ask-allow, tool.bash-safe-runs, perm.auto-classifier-asks-user, perm.auto-hard-ask]
  steps:
    - id: asks
      lane: model
      beat:
        title: "Model ขอรัน node scripts/build-icons.mjs"
        text: >-
          session อยู่ในโหมด Auto model ขอรันคำสั่งที่ไม่อยู่ใน safe list (รายการคำสั่งที่ Geno รันได้โดยไม่ถาม)
          ในโหมดนี้ Geno ไม่ถามคุณ แต่ให้ classifier ตัดสิน classifier คือการเรียก model แยกอีกครั้ง
          ที่อ่านคำสั่งแล้วตอบว่า allow (รัน) ask (ถามคุณ) หรือ deny (ปฏิเสธ)
          การ์ดข้างล่างเป็นคำตอบจริงจาก run เดียวกับการ์ดอื่นในหน้านี้ model ขอรัน `ps aux` ซึ่งไม่อยู่ในรายการเช่นกัน
          ดู `input` ที่ไฮไลต์
        from: model
        to: engine
        sees:
          kind: payload
          source: docs/results/real-usecases/runs/A09-auto-classifier/1/session.jsonl#seq=18
          select: content
          collapse: ['[0].thinking']
          highlight: ['[1].input']
      do: >-
        model ขอเรียก `bash` ด้วยคำสั่ง `node scripts/build-icons.mjs` และจบคำตอบด้วย `stop_reason: tool_use`
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
        sees: { kind: step, label: node scripts/build-icons.mjs, status: running }

    - id: rules
      lane: policy
      at: rules
      beat:
        title: "Geno ตรวจคำสั่งกับกฎของคุณ"
        text: >-
          ไม่มีกฎของ workspace ตรง และคำสั่งไม่อยู่ในรายการคำสั่งปลอดภัย (safe list) ในโหมด Ask แปลว่าถามคุณ แต่ในโหมด Auto แปลว่าให้ classifier ตัดสิน
        from: engine
        to: engine
      do: >-
        `approveCommand` ส่งคำสั่งให้ `ruledDenial` คำสั่งไม่อยู่ใน safe list จึงติดกฎ `unlisted`
        ซึ่งในโหมด Ask แปลว่าถามผู้ใช้ แต่ในโหมด Auto แปลว่า `classify`
      ref: packages/core/src/permission-rules.ts#ruledDenial
      emits: [unlisted, classify]

    - id: input
      lane: policy
      at: settle
      beat:
        title: "Geno เตรียมข้อมูลให้ classifier"
        text: >-
          classifier ได้ข้อความล่าสุดที่คุณพิมพ์ ข้อความล่าสุดของ model คำสั่ง กฎที่ติด เนื้อหาไฟล์ที่ session
          นี้แก้แล้วคำสั่งจะรัน และโดเมนที่ workspace อนุญาต
        from: engine
        to: engine
      do: >-
        `settle` เห็นคำตัดสิน `classify` จึงเตรียมข้อมูลให้ classifier: ข้อความล่าสุดที่ผู้ใช้พิมพ์ ข้อความล่าสุดของ model
        คำสั่ง กฎที่ติด เนื้อหาไฟล์ที่ session นี้แก้แล้วคำสั่งจะรัน และโดเมนที่ workspace อนุญาต
      ref: packages/engine/src/tools/agent.ts#settle

    - id: classify
      lane: policy
      at: classifier
      beat:
        title: "Classifier ตัดสินคำสั่ง"
        text: >-
          Geno เรียก model classifier และบังคับให้ตอบผ่าน tool `verdict` เป็นคำตัดสินพร้อมเหตุผล แต่ละครั้งรอได้ 8 วินาที
          ถ้าหมดเวลาหรือไม่ได้คำตัดสินที่ถูกรูป Geno ลองอีกหนึ่งครั้ง ถ้ายังไม่ได้ นับเป็นไม่แน่ใจ
          ค่าใช้จ่ายนับรวมในงบของ turn ลองเลือกคำตอบของ classifier
        from: engine
        to: engine
        ask: "classifier ตอบอะไร"
      do: >-
        `commandClassifier` เรียก model classifier (ค่าเริ่มต้น `qwen3.8-flash` บน Model Studio)
        บังคับให้ตอบผ่าน tool `verdict` ภายใน 8 วินาทีต่อครั้ง ถ้าหมดเวลาหรือไม่ได้คำตัดสินที่ถูกรูป จะลองอีกหนึ่งครั้ง
        ถ้ายังไม่ได้ หรือเกิด error อื่น เช่น key ถูกปฏิเสธ จะนับเป็น `ask`
        ค่าใช้จ่ายของการเรียกนี้นับรวมในงบ $0.40 ของ turn
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
                    การ์ดเป็นบันทึกจาก run จริงที่ classifier อนุญาต `ps aux` ดู `verdict` ที่เป็น `allow`
                    และ `reason` ซึ่งเป็นเหตุผลของมัน
                  from: engine
                  to: panel
                  sees:
                    kind: payload
                    source: docs/results/real-usecases/runs/A09-auto-classifier/1/session.jsonl#seq=19
                    highlight: [approval.classifier.verdict, approval.classifier.reason]
                do: >-
                  `settle` คืนบันทึก `decidedBy: classifier, verdict: allow` พร้อมเหตุผลของ classifier ไม่มีการ์ดและไม่ถามใคร
                ref: packages/engine/src/tools/agent.ts#settle
              - lane: tool
                at: shell
                beat:
                  title: "คำสั่งรันใน sandbox"
                  text: >-
                    การอนุญาตของ classifier ไม่ได้ยกเว้น sandbox (กรอบของระบบปฏิบัติการที่ให้คำสั่งเขียนไฟล์ได้แค่ใน workspace
                    กับโฟลเดอร์ชั่วคราว และต่อเครือข่ายได้แค่ host ที่อนุญาต) คำสั่งรันเหมือนคำสั่งที่คุณอนุญาตเอง แล้วผลกลับมาที่แชต
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
                  sees: { kind: step, label: node scripts/build-icons.mjs, status: done, note: Auto-approved · Runs a local build script that only writes inside the workspace. }
                do: >-
                  `autoOf` อ่านบันทึกการอนุญาตใน `APPROVAL_META` แล้วติดป้าย Auto พร้อมเหตุผลไว้ใต้ขั้นของคำสั่ง
                  ป้ายแสดงเมื่อแผงวาดทุกขั้น (ตั้ง detail เป็น full หรือเปิด turn ออก)
                sees: >-
                  ป้าย "Auto-approved" ตามด้วยเหตุผลของ classifier เช่น "Runs a local build script that only writes inside the workspace."
                ref: packages/extension/src/chat/render.ts#autoNote
              - lane: loop
                at: step
                beat:
                  title: "Model อ่านผลของคำสั่ง"
                  text: >-
                    Geno ส่งบทสนทนาทั้งหมดไปให้ model อีกครั้งในคำขอใหม่ ข้อความสุดท้ายของคำขอคือผลของคำสั่ง
                    ใน run จริงด้านล่าง classifier อนุญาต `ps aux` แต่ sandbox ไม่ให้รัน `/bin/ps`
                    ดู `tool_result` ที่ไฮไลต์ มันมี `is_error: true` และข้อความ `Operation not permitted`
                  from: engine
                  to: model
                  sees:
                    kind: payload
                    source: docs/results/real-usecases/runs/A09-auto-classifier/1/requests.jsonl#seq=22
                    select: messages[8]
                    highlight: ['content[0]']
                  end: "classifier อนุญาต turn ทำต่อ"
                do: >-
                  `loopStep` เห็น `tool-result` ล่าสุดจึงตัดสิน `call-model` model ได้อ่านผลของคำสั่ง
                ref: packages/core/src/loop.ts#loopStep
                emits: [call-model]
                phase: calling-model
                end: { turn: continues, reason: call-model }
          - id: deny
            label: deny
            steps:
              - lane: policy
                at: settle
                beat:
                  title: "Classifier ปฏิเสธ"
                  text: >-
                    คำสั่งไม่ได้รัน แต่ turn ไม่จบ ต่างจากตอนคุณกด Deny บนการ์ดซึ่งจบ turn
                    การ์ดเป็นบันทึกจาก run จริงที่ classifier ปฏิเสธคำสั่ง `grep` ที่อ่านไฟล์ `.env`
                    ดู `verdict` ที่เป็น `deny` และ `reason`
                  from: engine
                  to: model
                  sees:
                    kind: payload
                    source: docs/results/real-usecases/runs/A09-auto-classifier/1/session.jsonl#seq=24
                    highlight: [approval.classifier.verdict, approval.classifier.reason]
                do: >-
                  `settle` คืนบันทึก `decidedBy: classifier, verdict: deny`
                  `refusalOf` สร้าง `ToolDenied` ไม่ใช่ `ToolRejected` คำสั่งไม่ได้รัน แต่ turn ไม่จบ
                ref: packages/engine/src/tools/agent.ts#refusalOf
                emits: [ToolDenied]
              - lane: loop
                at: tools
                beat:
                  title: "Geno เตรียมผลที่บอกให้หาทางอื่น"
                  text: >-
                    Geno เขียนข้อความผลไว้ใน log ผลนี้ถึง model ตอนเรียกครั้งถัดไป ระหว่างนี้ model ไม่ได้ตอบอะไร
                    ผลบอกว่า classifier ปฏิเสธพร้อมเหตุผล ห้ามลองซ้ำ ให้หาทางอื่น แล้วผลกลับมาที่แชต
                  from: engine
                  to: engine
                do: >-
                  ผลของ call มีสถานะ `denied` ข้อความบอก model ว่า classifier ปฏิเสธพร้อมเหตุผล ห้ามลองซ้ำ ให้หาทางอื่น
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
                  sees: { kind: step, label: node scripts/build-icons.mjs, status: denied, note: Denied by Auto · Show details }
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
                    Geno ส่งบทสนทนาทั้งหมดไปให้ model อีกครั้งในคำขอใหม่ ข้อความสุดท้ายของคำขอคือผลที่บอกว่า classifier ปฏิเสธ
                    model อ่านคำปฏิเสธแล้วหาทางอื่น การ์ดข้างล่างเป็นข้อความนั้นจากคำขอจริงของ run เดียวกับการ์ดก่อนหน้า
                    ดู `tool_result` ที่ไฮไลต์ ข้อความขึ้นต้นด้วย `denied:` ตามด้วยเหตุผลของ classifier (แท็บแรก)
                    และจบด้วย `Do not retry it; find another way.` (แท็บสอง แสดงท้ายของข้อความเดียวกัน)
                  from: engine
                  to: model
                  sees:
                    - kind: payload
                      source: docs/results/real-usecases/runs/A09-auto-classifier/1/requests.jsonl#seq=26
                      select: messages[10]
                      highlight: ['content[1]']
                      quote: "denied:"
                    - kind: payload
                      source: docs/results/real-usecases/runs/A09-auto-classifier/1/requests.jsonl#seq=26
                      select: messages[10]
                      highlight: ['content[1]']
                      quote: Do not retry it; find another way.
                  end: "classifier ปฏิเสธ turn ทำต่อ"
                do: >-
                  `loopStep` ตัดสิน `call-model` model อ่านคำปฏิเสธแล้วหาทางอื่นต่อ
                ref: packages/core/src/loop.ts#loopStep
                emits: [call-model]
                phase: calling-model
                end: { turn: continues, reason: call-model }
          - id: ask
            label: ask (ไม่แน่ใจ)
            steps:
              - lane: policy
                at: settle
                beat:
                  title: "Classifier ไม่แน่ใจ Geno จึงถามคุณ"
                  text: >-
                    ความไม่แน่ใจของ classifier ไปถึงคุณเป็นการ์ดพร้อมเหตุผลของมัน คุณอนุญาต อนุญาตตลอด หรือปฏิเสธได้เหมือนในโหมด Ask
                  from: engine
                  to: panel
                do: >-
                  `settle` ส่งคำตอบ `ask` ของ classifier ให้ผู้ใช้ตัดสินผ่าน `approve` พร้อมเหตุผลของ classifier
                  ไม่มีคำสั่งไหนถูกบล็อกโดยไม่ถาม
                ref: packages/engine/src/tools/agent.ts#settle
                emits: [ask-user]
                phase: waiting-user
                goto: perm.auto-classifier-asks-user
          - id: unavailable
            label: ตอบไม่ได้ (ปิด ไม่มี key หรือช้าเกิน)
            steps:
              - lane: policy
                at: classifier
                beat:
                  title: "Classifier ตอบไม่ได้"
                  text: >-
                    classifier ถูกปิด ไม่มี key หรือลองสองครั้งแล้วยังช้าเกิน 8 วินาทีหรือตอบผิดรูป Geno ไม่เดาว่าคำสั่งปลอดภัย
                    แต่นับเป็นไม่แน่ใจพร้อมเหตุผลที่ล้ม ถ้า classifier ใช้ไม่ได้เลย เช่นไม่มี key หรือ key ผิด
                    แชตขึ้นข้อความครั้งเดียวว่า classifier ของ Auto ใช้ไม่ได้
                  from: engine
                  to: engine
                do: >-
                  `commandClassifier` ไม่ได้คำตัดสินจริง: `GCODE_CLASSIFIER_MODEL=off`, ผู้ให้บริการของ classifier ไม่มี key,
                  เกิน 8 วินาทีหรือคำตอบผิดรูปทั้งสองครั้ง หรือผู้ให้บริการปฏิเสธ ทุกกรณีคืน `ask` พร้อมเหตุผลว่าอะไรล้ม
                  ไม่มีการเดาว่าคำสั่งปลอดภัย เมื่อตั้งค่าไม่ได้ หรือผู้ให้บริการปฏิเสธ key หรือ model `onBroken` แจ้ง engine
                  ซึ่งบอกผู้ใช้ครั้งเดียวต่อ session
                ref: packages/engine/src/classifier.ts#commandClassifier
                emits: [ask]
              - lane: policy
                at: settle
                beat:
                  title: "Geno ถามคุณแทน"
                  text: >-
                    เหมือนตอน classifier ไม่แน่ใจ คำสั่งขึ้นการ์ดถามคุณพร้อมบรรทัดว่าอะไรล้ม
                  from: engine
                  to: panel
                do: >-
                  `settle` ส่ง `ask` ที่มาจากความล้มเหลวให้ผู้ใช้เหมือนคำตอบ `ask` จริง
                ref: packages/engine/src/tools/agent.ts#settle
                emits: [ask-user]
                phase: waiting-user
                goto: perm.auto-classifier-asks-user
---

คำว่า classifier, safe list และ sandbox ดูความหมายได้ที่ [คำศัพท์](/start/glossary/)

โหมด Auto ไม่ได้แปลว่าทุกอย่างผ่าน มันแปลว่า**ไม่มีใครถูกถาม** สำหรับคำสั่งที่ classifier อนุญาตหรือปฏิเสธ
คำสั่งใน safe list ยังรันทันทีเหมือนโหมด Ask คำสั่งที่ย้อนไม่ได้ เช่น `rm -rf` ของ workspace ยังขึ้นการ์ดถามผู้ใช้เสมอ

| classifier ตอบ | Auto ทำอะไร |
| --- | --- |
| `allow` | รัน |
| `deny` | ปฏิเสธ |
| `ask` | ขึ้นการ์ดถามผู้ใช้ |

สิ่งที่ควรสังเกต

- **classifier ที่ล่มเท่ากับ `ask`** หมดเวลาหรือตอบผิดรูปซ้ำในครั้งที่สอง หรือไม่ได้ตั้งค่า ทั้งหมดกลายเป็น `ask` ซึ่งขึ้นการ์ดถามผู้ใช้
  Geno จึงไม่รันคำสั่งที่ไม่มีใครตัดสิน
- **คำปฏิเสธของ classifier ไม่จบ turn** ต่างจากปุ่ม Deny บนการ์ด คำปฏิเสธของ classifier เป็น `ToolDenied`
  ซึ่งเป็นผลธรรมดาที่ model อ่านเหตุผลแล้วทำต่อ
- **ป้าย Auto-approved ซ่อนในมุมมองย่อ** แผงแสดงป้ายนี้เฉพาะเมื่อวาดทุกขั้น ส่วนป้าย "Denied by Auto" แสดงเสมอ

เมื่อ Auto ยังต้องถามคุณ ดู [โหมด Auto ยังขึ้นการ์ดถามคุณ](/scenarios/perm/auto-still-asks/)
