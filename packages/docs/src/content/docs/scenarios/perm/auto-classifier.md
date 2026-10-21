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
          ในโหมดนี้ Geno ไม่ถามคุณก่อน แต่ให้ classifier ตัดสินคำสั่งที่กฎติดธง classifier คือการเรียก model แยกอีกครั้ง
          ที่อ่านคำสั่งแล้วตอบว่า allow (รัน) ask (ควรถามคุณ) หรือ deny (ปฏิเสธ)
          การ์ดในหน้านี้มาจากการบันทึกที่รัน Geno จริงกับ model จำลอง ในทางนี้คุณพิมพ์ว่า "Delete the dist folder. It only holds stale build output."
          การ์ดนี้คือข้อความของ model ที่ Geno ส่งกลับไปในคำขอถัดไป ดู `input` ของบล็อก `tool_use` ที่ไฮไลต์
        from: model
        to: engine
        sees:
          kind: payload
          source: packages/docs/src/data/recorded/perm-auto-classifier-allow.jsonl#line=6
          select: messages[1].content
          highlight: ['[1].input']
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
          (คำสั่งที่มีแค่กฎ `unlisted` ซึ่งเป็นกฎของคำสั่งที่แค่ไม่อยู่ใน safe list ติดธง เช่น `make build` รันใน sandbox เลยโดยไม่ถึง classifier)
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
          การ์ดคือข้อความที่ classifier ได้จริง แท็บแรกแสดงแท็ก `<user_request>` กับ `<agent_text>`
          แท็บสองแสดงท้ายของข้อความเดียวกัน คือ `<flagged_by>` (กฎที่ติด) และ `<command>`
          classifier ไม่เห็นบทสนทนาทั้งหมด และไม่เห็นผลของ tool ถ้า session มีข้อความก่อนหน้านี้
          ข้อความยังขึ้นต้นด้วยแท็ก `<conversation>` ที่มีข้อความเก่าของคุณไม่เกิน 6 ข้อความ ข้อความของ model ก่อนแต่ละข้อความนั้น และสรุปของ compaction ถ้ามี
          (การบันทึกนี้เป็นข้อความแรกของ session จึงไม่มีแท็กนี้)
        from: engine
        to: engine
        sees:
          - kind: payload
            source: packages/docs/src/data/recorded/perm-auto-classifier-allow.jsonl#line=4
            select: messages[0]
            highlight: ['content[0].text']
          - kind: payload
            source: packages/docs/src/data/recorded/perm-auto-classifier-allow.jsonl#line=4
            select: messages[0]
            highlight: ['content[0].text']
            quote: "<command>"
      do: >-
        `settle` เห็นคำตัดสิน `classify` จึงเตรียมข้อมูลให้ classifier: ข้อความล่าสุดที่ผู้ใช้พิมพ์ ข้อความล่าสุดของ model
        คำสั่ง กฎที่ติด เนื้อหาไฟล์ที่ session นี้แก้แล้วคำสั่งจะรัน (ถ้ามี) และโดเมนที่ workspace อนุญาต
        และถ้ามีข้อความก่อนหน้า `conversationOf` ใส่ `<conversation>` ที่มีข้อความเก่าของผู้ใช้ไม่เกิน `CONVERSATION_MESSAGES` (6) ข้อความ และสรุปของ compaction
      ref: packages/engine/src/tools/agent.ts#settle

    - id: classify
      lane: policy
      at: classifier
      beat:
        title: "Classifier ตัดสินคำสั่ง"
        text: >-
          Geno เรียก model classifier ให้ตอบผ่าน tool `verdict` เป็นคำตัดสินพร้อมเหตุผล (บังคับเมื่อ model รองรับ) แต่ละครั้งรอได้ 8 วินาที
          ถ้าหมดเวลาหรือตอบไม่มีคำตัดสิน Geno ลองอีกครั้งเดียว
          ค่าใช้จ่ายนับรวมในงบของ turn ลองเลือกคำตอบของ classifier
        from: engine
        to: engine
        ask: "classifier ตอบอะไร"
      do: >-
        `commandClassifier` เรียก model classifier (ค่าเริ่มต้น `qwen3.8-flash` บน Model Studio)
        ให้ตอบผ่าน tool `verdict` ภายใน 8 วินาที (บังคับด้วย `tool_choice` เมื่อ model รองรับ `forcesTool`) ถ้าหมดเวลาหรือตอบไม่มีคำตัดสินจะลองอีกครั้ง
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
                    การ์ดคือคำตอบของ classifier ซึ่งเรียก tool `verdict` และ stream ค่า input เป็น JSON ทีละท่อน
                    ท่อนสุดท้ายนี้มี `"verdict":"allow"` และท้ายของ `reason`
                  from: engine
                  to: panel
                  sees:
                    kind: payload
                    source: packages/docs/src/data/recorded/perm-auto-classifier-allow.jsonl#line=5
                    select: '[3]'
                    highlight: [data.delta.partial_json]
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
                  sees: { kind: step, label: rm -rf dist, status: done, note: "Auto-approved · Deletes dist, build output the user asked to remove." }
                do: >-
                  `autoOf` อ่านบันทึกการอนุญาตใน `APPROVAL_META` แล้วติดป้าย Auto พร้อมเหตุผลไว้ใต้ขั้นของคำสั่ง
                  ป้ายแสดงเมื่อแผงวาดทุกขั้น (ตั้ง detail เป็น full หรือเปิด turn ออก)
                sees: >-
                  ป้าย "Auto-approved" ตามด้วยเหตุผลของ classifier เช่น "Deletes dist, build output the user asked to remove."
                ref: packages/extension/src/chat/render.ts#autoNote
              - lane: loop
                at: step
                beat:
                  title: "Model อ่านผลของคำสั่ง"
                  text: >-
                    Geno ส่งบทสนทนาทั้งหมดไปให้ model อีกครั้งในคำขอใหม่ ข้อความสุดท้ายของคำขอคือผลของคำสั่ง
                    การ์ดคือข้อความนั้น `tool_result` ของ `rm -rf dist` คือ `[exit code 0]`
                  from: engine
                  to: model
                  sees:
                    kind: payload
                    source: packages/docs/src/data/recorded/perm-auto-classifier-allow.jsonl#line=6
                    select: messages[2]
                    highlight: ['content[0].content']
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
                    classifier ตอบ `deny` หรือ `ask` ก็ตาม คำสั่งไม่ได้รัน ไม่มีการ์ดขึ้น และ turn ไม่จบ ต่างจากตอนคุณกด Deny บนการ์ดซึ่งจบ turn
                    การปฏิเสธแบบนี้เรียกว่า block ถ้า session นี้มี block ติดกันครบ 3 ครั้งหรือรวมครบ 20 ครั้งแล้ว block ถัดไปจะขึ้นการ์ดถามคุณแทน
                    การ์ดในทางนี้มาจากอีกการบันทึกหนึ่ง คุณถามแค่ว่า "Is dist/version.js out of date with src/version.ts?"
                    แต่ model จะลบ `dist` แล้ว build ใหม่ classifier จึงตอบ `"verdict":"deny"` พร้อมเหตุผลว่าคุณไม่ได้ขอให้ลบ (ท่อนสุดท้ายของ JSON ที่ stream มา)
                  from: engine
                  to: engine
                  sees:
                    kind: payload
                    source: packages/docs/src/data/recorded/perm-auto-classifier-deny.jsonl#line=5
                    select: '[3]'
                    highlight: [data.delta.partial_json]
                do: >-
                  `settle` นับ block ของ session จาก log ด้วย `autoBlocksOf` ถ้า `autoFallsBack` ยังไม่จริง
                  ก็คืนบันทึก `decidedBy: classifier, verdict: deny` โดยเก็บคำตอบของ classifier เองไว้ใน `classifier`
                  PermissionRequest hook ไม่ถูกถามเพราะไม่มีการ์ด `refusalOf` สร้าง `ToolDenied` ไม่ใช่ `ToolRejected`
                ref: packages/engine/src/tools/agent.ts#settle
                emits: [ToolDenied]
              - lane: loop
                at: tools
                beat:
                  title: "Geno เตรียมผลที่บอกเหตุผล"
                  text: >-
                    Geno เขียนข้อความผลไว้ใน log ผลนี้ถึง model ตอนเรียกครั้งถัดไป ระหว่างนี้ model ไม่ได้ตอบอะไร
                    ผลบอกว่า classifier ของ Auto ปฏิเสธพร้อมเหตุผล และบอกให้ model หาทางอื่นที่สมเหตุผล
                    หรือหยุดอธิบายให้คุณฟังในคำตอบว่าต้องการสิทธิ์อะไร แล้วผลกลับมาที่แชต
                  from: engine
                  to: engine
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
                    Geno ส่งบทสนทนาทั้งหมดไปให้ model อีกครั้งในคำขอใหม่ ข้อความสุดท้ายของคำขอคือผลที่บอกว่า classifier ปฏิเสธ
                    model อ่านคำปฏิเสธแล้วหาทางอื่น หรือถามคุณเป็นข้อความ
                    แท็บแรกคือข้อความนั้น ขึ้นต้นด้วย `denied: Auto mode's safety classifier refused` ตามด้วยเหตุผลของ classifier
                    แท็บสองคือท้ายของข้อความเดียวกัน เป็นถ้อยคำแบบ dontAsk ที่บอกให้หาทางอื่นอย่างสมเหตุผล หรือหยุดอธิบายให้คุณฟัง
                    แท็บสามคือคำตอบถัดไปของ model ซึ่งเปลี่ยนไปอ่าน `dist/version.js` กับ `src/version.ts` เพื่อเทียบกันแทน
                  from: engine
                  to: model
                  sees:
                    - kind: payload
                      source: packages/docs/src/data/recorded/perm-auto-classifier-deny.jsonl#line=6
                      select: messages[2]
                      highlight: ['content[0].content']
                      quote: "Auto mode's safety classifier refused"
                    - kind: payload
                      source: packages/docs/src/data/recorded/perm-auto-classifier-deny.jsonl#line=6
                      select: messages[2]
                      highlight: ['content[0].content']
                      quote: "STOP and explain to the user"
                    - kind: payload
                      source: packages/docs/src/data/recorded/perm-auto-classifier-deny.jsonl#line=7
                      select: '[2]'
                      highlight: [data.delta.text]
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
                    การ์ดในทางนี้มาจากการบันทึกที่ตั้ง `GCODE_CLASSIFIER_PROVIDER=anthropic` classifier จึงเป็น `claude-sonnet-5-5`
                    ซึ่งคำขอบอกให้ตอบด้วย tool `verdict` แต่ไม่บังคับ (ส่วน `qwen3.8-flash` ที่เป็นค่าเริ่มต้นถูกบังคับให้เรียก tool จึงตอบเป็นข้อความเปล่าไม่ได้)
                    ทั้งสองครั้ง classifier ตอบเป็นข้อความ ไม่เรียก `verdict` การ์ดคือท้ายคำตอบครั้งแรก ดู `stop_reason` ที่เป็น `end_turn` ไม่ใช่ `tool_use`
                  from: engine
                  to: engine
                  sees:
                    kind: payload
                    source: packages/docs/src/data/recorded/perm-auto-classifier-unevaluated.jsonl#line=5
                    select: '[-2]'
                    highlight: [data.delta.stop_reason]
                do: >-
                  `commandClassifier` คืน `ask` ที่มี `failure: 'unevaluated'` พร้อมเหตุผลว่าอะไรล้ม
                ref: packages/engine/src/classifier.ts#commandClassifier
                emits: [ask]
              - lane: policy
                at: settle
                beat:
                  title: "Geno ปฏิเสธและนับเป็น block"
                  text: >-
                    คำสั่งไม่ได้รันและไม่มีการ์ด ผลของ call บอกว่า Auto ประเมินคำสั่งไม่ได้ ผลนี้ถึง model ตอนเรียกครั้งถัดไป
                    ครั้งนี้นับเป็น block classifier ที่ล้มซ้ำๆ จึงยังมาถึงการ์ดของคุณหลังครบ 3 ครั้งติดกัน
                  from: engine
                  to: engine
                do: >-
                  `settle` ปฏิเสธเหมือนคำตอบ `deny` (`decidedBy: classifier, verdict: deny`) จนกว่า `autoFallsBack`
                  `denialText` เขียนว่า "Auto mode could not evaluate `rm -rf dist` (...), so it did not run." ตามด้วย `DONT_ASK`
                ref: packages/engine/src/tools/agent.ts#denialText
                emits: [ToolDenied, denied]
              - lane: loop
                at: step
                beat:
                  title: "Model อ่านว่า Auto ประเมินไม่ได้"
                  text: >-
                    Geno ส่งบทสนทนาทั้งหมดไปให้ model อีกครั้งในคำขอใหม่ ข้อความสุดท้ายคือผลที่ขึ้นต้นด้วย `denied: Auto mode could not evaluate`
                    พร้อมสาเหตุ `(the classifier gave no verdict)` ในการบันทึกนี้ model ตอบคุณว่าลบไม่ได้
                    และบอกให้คุณรัน `rm -rf dist` เอง หรือบอกให้มันลองอีกครั้ง
                  from: engine
                  to: model
                  sees:
                    kind: payload
                    source: packages/docs/src/data/recorded/perm-auto-classifier-unevaluated.jsonl#line=8
                    select: messages[2]
                    highlight: ['content[0].content']
                  end: "classifier ประเมินไม่ได้ turn ทำต่อ"
                do: >-
                  `loopStep` ตัดสิน `call-model` model อ่านผลที่บอกว่า Auto ประเมินคำสั่งไม่ได้
                ref: packages/core/src/loop.ts#loopStep
                emits: [call-model]
                phase: calling-model
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
                    ถ้าไม่มี key หรือ key ถูกปฏิเสธ แชตขึ้นข้อความครั้งเดียวว่า classifier ของ Auto ใช้ไม่ได้ (ถ้าคุณปิดเองด้วย `GCODE_CLASSIFIER_MODEL=off` จะไม่มีข้อความนี้)
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
                    ถ้าปฏิเสธแทน ทุกคำสั่งที่ติดธงจะไม่ได้รันเลย Geno จึงขึ้นการ์ดถามคุณทันทีทุกครั้ง ไม่ต้องรอให้ block ครบ และไม่นับเป็น block
                    การ์ดเป็นแบบเดียวกับโหมด Ask turn รอจนคุณกด Allow หรือ Deny
                  from: engine
                  to: panel
                  end: "classifier ใช้ไม่ได้ turn รอคุณตอบการ์ด"
                do: >-
                  `settle` ส่ง `ask` ที่มี `failure: 'unavailable'` ให้ PermissionRequest hook แล้วให้ผู้ใช้ผ่าน `approve`
                  และไม่นับเป็น block
                ref: packages/engine/src/tools/agent.ts#settle
                emits: [ask-user]
                phase: waiting-user
                end: { turn: waits, reason: ask-user }
---

คำว่า classifier, safe list และ sandbox ดูความหมายได้ที่ [คำศัพท์](/start/glossary/)

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
- **คำปฏิเสธของ classifier ไม่จบ turn** ต่างจากปุ่ม Deny บนการ์ด คำปฏิเสธของ classifier เป็น `ToolDenied`
  ซึ่งเป็นผลธรรมดาที่ model อ่านเหตุผลแล้วทำต่อ
- **ป้าย Auto-approved ซ่อนในมุมมองย่อ** แผงแสดงป้ายนี้เฉพาะเมื่อวาดทุกขั้น ส่วนป้าย "Denied by Auto" แสดงเสมอ

เมื่อ Auto ยังต้องถามคุณ ดู [โหมด Auto ยังขึ้นการ์ดถามคุณ](/scenarios/perm/auto-still-asks/)
