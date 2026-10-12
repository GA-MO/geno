---
title: "โหมด Auto ให้ classifier ตัดสินคำสั่ง"
description: ในโหมด Auto คำสั่งที่ไม่อยู่ใน safe list ไปถึง classifier ไม่ใช่ผู้ใช้ classifier อนุญาต ปฏิเสธ หรือไม่แน่ใจ และแต่ละทางให้ผลต่างกัน
tableOfContents: false
sidebar:
  order: 2
scenario:
  surface: vscode
  given:
    - session อยู่ในโหมด Auto และ Auto ยังไม่ถูกพัก (classifier ยังไม่บล็อกครบ 3 ครั้งติดกัน)
    - ไม่มี hook ที่ตั้งไว้ และไม่มีกฎของ workspace ที่ตรงกับคำสั่ง
  trigger: >-
    model ขอเรียก `bash` ด้วยคำสั่ง `node scripts/build-icons.mjs` ซึ่งไม่อยู่ใน safe list
  covers: [perm.auto-classifier-allows, perm.auto-classifier-denies, perm.auto-classifier-blocks, perm.classifier-unavailable]
  related: [perm.ask-allow, tool.bash-safe-runs, perm.auto-paused-asks-user, perm.auto-hard-ask]
  steps:
    - id: asks
      lane: model
      beat:
        title: "Model ขอรัน node scripts/build-icons.mjs"
        text: >-
          session อยู่ในโหมด Auto model ขอรันคำสั่งที่ไม่อยู่ในรายการคำสั่งปลอดภัย
        from: model
        to: engine
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
          คำสั่งไม่อยู่ในรายการคำสั่งปลอดภัย ในโหมด Ask แปลว่าถามคุณ แต่ในโหมด Auto แปลว่าให้ classifier ตัดสิน
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
        title: "Classifier ตัดสินภายใน 8 วินาที"
        text: >-
          Geno เรียก model classifier ครั้งเดียว บังคับให้ตอบเป็นคำตัดสิน ถ้าหมดเวลาหรือตอบผิดรูป นับเป็นไม่แน่ใจ
          ค่าใช้จ่ายนับรวมในงบของ turn ลองเลือกคำตอบของ classifier
        from: engine
        to: engine
        ask: "classifier ตอบอะไร"
      do: >-
        `commandClassifier` เรียก model classifier (ค่าเริ่มต้น `qwen3.8-flash` บน Model Studio) ครั้งเดียว
        บังคับให้ตอบผ่าน tool `verdict` ภายใน 8 วินาที ถ้าหมดเวลา ล้มเหลว หรือตอบผิดรูป จะนับเป็น `ask`
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
                    คำสั่งรันได้โดยไม่มีการ์ด ตัวนับการบล็อกติดกันเริ่มใหม่ Geno จดว่า classifier เป็นผู้อนุญาตพร้อมเหตุผล
                    บันทึกจาก run จริงด้านล่างเป็นแบบนี้
                  from: engine
                  to: panel
                  sees:
                    kind: payload
                    source: docs/results/real-usecases/runs/A09-auto-classifier/1/session.jsonl#seq=19
                    highlight: [approval.classifier.verdict, approval.classifier.reason]
                do: >-
                  `CLASSIFIER_OUTCOMES` ให้ `allow` เป็น `run` สถานะ Auto รีเซ็ตตัวนับการบล็อกติดกัน
                  `settle` คืนบันทึก `decidedBy: classifier, verdict: allow` พร้อมเหตุผลของ classifier ไม่มีการ์ดและไม่ถามใคร
                ref: packages/core/src/auto.ts#CLASSIFIER_OUTCOMES
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
            label: deny
            steps:
              - lane: policy
                at: settle
                beat:
                  title: "Classifier ปฏิเสธ"
                  text: >-
                    คำสั่งไม่ได้รัน แต่ turn ไม่จบ ต่างจากตอนคุณกด Deny บันทึกจาก run จริงด้านล่างคือการปฏิเสธแบบนี้
                  from: engine
                  to: model
                  sees:
                    kind: payload
                    source: docs/results/real-usecases/runs/A09-auto-classifier/1/session.jsonl#seq=24
                    highlight: [approval.classifier.verdict, approval.classifier.reason]
                do: >-
                  `CLASSIFIER_OUTCOMES` ให้ `deny` เป็น `refuse` `settle` คืนบันทึก `decidedBy: classifier, verdict: deny`
                  `refusalOf` สร้าง `ToolDenied` ไม่ใช่ `ToolRejected` คำสั่งไม่ได้รัน แต่ turn ไม่จบ
                ref: packages/engine/src/tools/agent.ts#refusalOf
                emits: [ToolDenied]
              - lane: loop
                at: tools
                beat:
                  title: "Geno บอก model ให้หาทางอื่น"
                  text: >-
                    ผลของ call บอก model ว่า classifier ปฏิเสธพร้อมเหตุผล ห้ามลองซ้ำ ให้หาทางอื่น แล้วผลกลับมาที่แชต
                  from: engine
                  to: model
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
                    Geno เรียก model ต่อ model อ่านคำปฏิเสธแล้วหาทางอื่น
                  from: engine
                  to: model
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
                  title: "Classifier ไม่แน่ใจ Auto บล็อกแทน"
                  text: >-
                    ขณะ Auto ยังไม่พัก ความไม่แน่ใจไม่ไปถึงคุณ คำสั่งถูกบล็อกและ Geno นับครั้ง ครบ 3 ครั้งติดกันหรือ 20 ครั้งรวม
                    Auto จะพัก ผลบอก model ให้หาทางอื่น หรือบอกว่าต้องให้คุณอนุญาตอะไร
                  from: engine
                  to: model
                do: >-
                  ขณะ Auto ยังไม่ถูกพัก `ask` ไม่ไปถึงผู้ใช้ `CLASSIFIER_OUTCOMES` ให้เป็น `block`
                  คำสั่งถูกปฏิเสธเป็น `ToolDenied` และ `nextAutoState` นับการบล็อก ครบ 3 ครั้งติดกันหรือ 20 ครั้งรวม Auto จะพัก
                ref: packages/core/src/auto.ts#nextAutoState
                emits: [ToolDenied]
              - lane: loop
                at: tools
                do: >-
                  ผลของ call มีสถานะ `denied` ข้อความบอก model ว่า Auto บล็อกคำสั่งโดยไม่ถามผู้ใช้เพราะ classifier ไม่ยอม
                  ห้ามลองซ้ำ ให้หาทางอื่นหรือบอกในคำตอบว่าต้องให้ผู้ใช้อนุญาตอะไร
                ref: packages/engine/src/tools/agent.ts#denialText
                emits: [denied]
              - use: tool-result-returns
              - lane: panel
                at: rail
                beat:
                  title: "แชตขึ้น Denied by Auto"
                  text: >-
                    แชตแสดงป้ายปฏิเสธของ Auto เหมือนตอน classifier ปฏิเสธ เพราะทั้งสองมาจาก classifier
                  from: panel
                  to: you
                  sees: { kind: step, label: node scripts/build-icons.mjs, status: denied, note: Denied by Auto }
                do: >-
                  แผงแสดงป้ายปฏิเสธของ Auto เหมือนกรณี deny เพราะทั้งสองมาจาก classifier
                sees: '"Denied by Auto" ตามด้วยเหตุผลของ classifier'
                ref: packages/extension/src/chat/session-updates.ts#denialOf
              - lane: loop
                at: step
                beat:
                  title: "Turn ทำต่อ"
                  text: >-
                    Geno เรียก model ต่อ ถ้า Auto พักแล้ว คำสั่งถัดไปที่ classifier ไม่แน่ใจจะขึ้นการ์ดถามคุณแทน
                  from: engine
                  to: model
                  end: "Auto บล็อก turn ทำต่อ"
                do: >-
                  `loopStep` ตัดสิน `call-model` turn ทำงานต่อ ถ้า Auto พักแล้ว คำสั่งถัดไปที่ classifier ตอบ `ask`
                  จะขึ้นการ์ดถามผู้ใช้แทน จนกว่าผู้ใช้จะอนุญาตหนึ่งครั้ง
                ref: packages/core/src/loop.ts#loopStep
                emits: [call-model]
                phase: calling-model
                end: { turn: continues, reason: call-model }
          - id: unavailable
            label: ตอบไม่ได้ (ปิด ไม่มี key หรือช้าเกิน)
            steps:
              - lane: policy
                at: classifier
                beat:
                  title: "Classifier ตอบไม่ได้"
                  text: >-
                    classifier ถูกปิด ไม่มี key ช้าเกิน 8 วินาที หรือตอบผิดรูป Geno ไม่เดาว่าคำสั่งปลอดภัย
                    แต่นับเป็นไม่แน่ใจพร้อมเหตุผลที่ล้ม
                  from: engine
                  to: engine
                do: >-
                  `commandClassifier` ไม่ได้คำตัดสินจริง: `GCODE_CLASSIFIER_MODEL=off`, ผู้ให้บริการของ classifier ไม่มี key,
                  เกิน 8 วินาที, ผู้ให้บริการปฏิเสธ หรือคำตอบผิดรูป ทุกกรณีคืน `ask` พร้อมเหตุผลว่าอะไรล้ม
                  เช่น "the classifier is off" หรือ "the classifier timed out after 8s" ไม่มีการเดาว่าคำสั่งปลอดภัย
                ref: "packages/engine/src/classifier.ts#\"if (model === 'off') return always('the classifier is off');\""
                emits: [the classifier is off]
              - lane: policy
                at: settle
                beat:
                  title: "Geno บล็อกและนับครั้ง"
                  text: >-
                    เหมือนตอน classifier ไม่แน่ใจ คำสั่งถูกบล็อกและนับครั้ง classifier ที่ปิดอยู่จึงบล็อกทุกคำสั่งนอกรายการปลอดภัย
                    ครั้งที่สามติดกันทำให้ Auto พัก
                  from: engine
                  to: model
                do: >-
                  `ask` ระหว่างที่ Auto ยังไม่พักเป็น `block` เหมือนคำตอบ `ask` จริง คำสั่งถูกปฏิเสธเป็น `ToolDenied` และนับการบล็อก
                  classifier ที่ปิดอยู่บล็อกทุกคำสั่งนอก safe list ครั้งที่สามติดกันทำให้ Auto พัก
                ref: packages/core/src/auto.ts#CLASSIFIER_OUTCOMES
                emits: [ToolDenied]
              - use: tool-result-returns
              - lane: panel
                at: rail
                beat:
                  title: "แชตขึ้นเหตุผลของความล้มเหลว"
                  text: >-
                    ป้ายปฏิเสธของ Auto แสดงว่าอะไรล้ม แทนเหตุผลของ classifier
                  from: panel
                  to: you
                  sees: { kind: step, label: node scripts/build-icons.mjs, status: denied, note: Denied by Auto · the classifier is off }
                do: >-
                  ป้ายปฏิเสธของ Auto แสดงเหตุผลของความล้มเหลวแทนเหตุผลของ classifier
                sees: '"Denied by Auto" ตามด้วย "the classifier is off"'
                ref: packages/extension/src/chat/session-updates.ts#denialOf
              - lane: loop
                at: step
                beat:
                  title: "Turn ทำต่อ แล้ว Auto พักและถามคุณ"
                  text: >-
                    Geno เรียก model ต่อ เมื่อ Auto พักแล้ว คำสั่งถัดไปขึ้นการ์ดถามคุณพร้อมบรรทัดว่า Auto ตัดสินไม่ได้เพราะอะไร
                  from: engine
                  to: model
                  end: "Auto พักแล้วถามคุณ"
                do: >-
                  `loopStep` ตัดสิน `call-model` turn ทำงานต่อ เมื่อ Auto พักแล้ว คำสั่งถัดไปที่ได้ `ask` จะขึ้นการ์ดถามผู้ใช้
                  พร้อมบรรทัด "Auto could not decide: the classifier is off."
                ref: packages/core/src/loop.ts#loopStep
                emits: [call-model]
                phase: calling-model
                goto: perm.auto-paused-asks-user
---

โหมด Auto ไม่ได้แปลว่าทุกอย่างผ่าน มันแปลว่า**ไม่มีใครถูกถาม** สำหรับคำสั่งกลุ่มที่ classifier ตัดสินได้
คำสั่งใน safe list ยังรันทันทีเหมือนโหมด Ask คำสั่งที่ย้อนไม่ได้ เช่น `rm -rf` ของ workspace ยังขึ้นการ์ดถามผู้ใช้เสมอ

| classifier ตอบ | Auto ยังทำงาน | Auto พักแล้ว |
| --- | --- | --- |
| `allow` | รัน | รัน |
| `deny` | ปฏิเสธ | ปฏิเสธ |
| `ask` | บล็อก (ปฏิเสธและนับ) | ขึ้นการ์ดถามผู้ใช้ |

สิ่งที่ควรสังเกต

- **classifier ที่ล่มเท่ากับ `ask`** หมดเวลา ไม่ได้ตั้งค่า หรือตอบผิดรูป ทั้งหมดกลายเป็น `ask` ซึ่งบล็อกคำสั่ง
  เมื่อบล็อกครบ 3 ครั้งติดกัน Auto พัก และคำถามไปถึงผู้ใช้ Geno จึงไม่รันคำสั่งที่ไม่มีใครตัดสิน
- **ทุกทางไม่จบ turn** ต่างจากปุ่ม Reject บนการ์ดของโหมด Ask คำปฏิเสธของ classifier เป็น `ToolDenied`
  model อ่านเหตุผลแล้วทำต่อ
- **ป้าย Auto-approved ซ่อนในมุมมองย่อ** แผงแสดงป้ายนี้เฉพาะเมื่อวาดทุกขั้น ส่วนป้าย "Denied by Auto" แสดงเสมอ

เมื่อ Auto ยังต้องถามคุณ ดู [โหมด Auto ยังขึ้นการ์ดถามคุณ](/scenarios/perm/auto-still-asks/)
