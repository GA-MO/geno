---
title: โหมด Auto ให้ classifier ตัดสินคำสั่ง
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
    โมเดลขอเรียก `bash` ด้วยคำสั่ง `node scripts/build-icons.mjs` ซึ่งไม่อยู่ใน safe list
  covers: [perm.auto-classifier-allows, perm.auto-classifier-denies, perm.auto-classifier-blocks]
  related: [perm.ask-allow, tool.bash-safe-runs, perm.auto-paused-asks-user, perm.classifier-unavailable]
  steps:
    - id: asks
      lane: model
      do: >-
        โมเดลขอเรียก `bash` ด้วยคำสั่ง `node scripts/build-icons.mjs` และจบคำตอบด้วย `stop_reason: tool_use`
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
      do: >-
        `approveCommand` ส่งคำสั่งให้ `ruledDenial` คำสั่งไม่อยู่ใน safe list จึงติดกฎ `unlisted`
        ซึ่งในโหมด Ask แปลว่าถามผู้ใช้ แต่ในโหมด Auto แปลว่า `classify`
      ref: packages/core/src/permission-rules.ts#ruledDenial
      emits: [unlisted, classify]

    - id: input
      lane: policy
      at: settle
      do: >-
        `settle` เห็นคำตัดสิน `classify` จึงเตรียมข้อมูลให้ classifier: ข้อความล่าสุดที่ผู้ใช้พิมพ์ ข้อความล่าสุดของโมเดล
        คำสั่ง กฎที่ติด เนื้อหาไฟล์ที่ session นี้แก้แล้วคำสั่งจะรัน และโดเมนที่ workspace อนุญาต
      ref: packages/engine/src/tools/agent.ts#settle

    - id: classify
      lane: policy
      at: classifier
      do: >-
        `commandClassifier` เรียกโมเดล classifier (ค่าเริ่มต้น `qwen3.8-flash` บน Model Studio) ครั้งเดียว
        บังคับให้ตอบผ่านเครื่องมือ `verdict` ภายใน 8 วินาที ถ้าหมดเวลา ล้มเหลว หรือตอบผิดรูป จะนับเป็น `ask`
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
                do: >-
                  `CLASSIFIER_OUTCOMES` ให้ `allow` เป็น `run` สถานะ Auto รีเซ็ตตัวนับการบล็อกติดกัน
                  `settle` บันทึก `decidedBy: classifier, verdict: allow` พร้อมเหตุผลของ classifier ไม่มีการ์ดและไม่ถามใคร
                ref: packages/core/src/auto.ts#CLASSIFIER_OUTCOMES
              - lane: tool
                at: shell
                do: >-
                  `bash` รันคำสั่งใน sandbox เหมือนคำสั่งที่ผู้ใช้อนุญาต การอนุญาตของ classifier ไม่ได้ยกเว้น sandbox
                ref: "packages/engine/src/tools/agent.ts#\"const result = await tools.sandbox.run(command, {\""
              - use: tool-result-returns
              - lane: panel
                at: rail
                do: >-
                  `autoOf` อ่านบันทึกการอนุญาตใน `APPROVAL_META` แล้วติดป้าย Auto พร้อมเหตุผลไว้ใต้ขั้นของคำสั่ง
                  ป้ายแสดงเมื่อแผงวาดทุกขั้น (ตั้ง detail เป็น full หรือเปิด turn ออก)
                sees: >-
                  ป้าย "Auto-approved" ตามด้วยเหตุผลของ classifier เช่น "Runs a local build script that only writes inside the workspace."
                ref: packages/extension/src/chat/render.ts#autoNote
              - lane: loop
                at: step
                do: >-
                  `loopStep` เห็น `tool-result` ล่าสุดจึงตัดสิน `call-model` โมเดลได้อ่านผลของคำสั่ง
                ref: packages/core/src/loop.ts#loopStep
                emits: [call-model]
                phase: calling-model
                end: { turn: continues, reason: call-model }
          - id: deny
            label: deny
            steps:
              - lane: policy
                at: settle
                do: >-
                  `CLASSIFIER_OUTCOMES` ให้ `deny` เป็น `refuse` `settle` บันทึก `decidedBy: classifier, verdict: deny`
                  `refusalOf` สร้าง `ToolDenied` ไม่ใช่ `ToolRejected` คำสั่งไม่ได้รัน แต่ turn ไม่จบ
                ref: packages/engine/src/tools/agent.ts#refusalOf
                emits: [ToolDenied]
              - lane: loop
                at: tools
                do: >-
                  ผลของ call มีสถานะ `denied` ข้อความบอกโมเดลว่า classifier ปฏิเสธพร้อมเหตุผล ห้ามลองซ้ำ ให้หาทางอื่น
                ref: packages/engine/src/tools/agent.ts#denialText
                emits: [denied]
              - use: tool-result-returns
              - lane: panel
                at: rail
                do: >-
                  `denialOf` เห็นว่าผู้ปฏิเสธคือ classifier จึงแสดงป้ายปฏิเสธของ Auto พร้อมเหตุผล
                  ข้อความเต็มที่โมเดลได้อยู่หลัง Show details
                sees: '"Denied by Auto" ตามด้วยเหตุผลของ classifier และลิงก์ "Show details"'
                ref: packages/extension/src/chat/session-updates.ts#denialOf
              - lane: loop
                at: step
                do: >-
                  `loopStep` ตัดสิน `call-model` โมเดลอ่านคำปฏิเสธแล้วหาทางอื่นต่อ
                ref: packages/core/src/loop.ts#loopStep
                emits: [call-model]
                phase: calling-model
                end: { turn: continues, reason: call-model }
          - id: ask
            label: ask (ไม่แน่ใจ)
            steps:
              - lane: policy
                at: settle
                do: >-
                  ขณะ Auto ยังไม่ถูกพัก `ask` ไม่ไปถึงผู้ใช้ `CLASSIFIER_OUTCOMES` ให้เป็น `block`
                  คำสั่งถูกปฏิเสธเป็น `ToolDenied` และ `nextAutoState` นับการบล็อก ครบ 3 ครั้งติดกันหรือ 20 ครั้งรวม Auto จะพัก
                ref: packages/core/src/auto.ts#nextAutoState
                emits: [ToolDenied]
              - lane: loop
                at: tools
                do: >-
                  ผลของ call มีสถานะ `denied` ข้อความบอกโมเดลว่า Auto บล็อกคำสั่งโดยไม่ถามผู้ใช้เพราะ classifier ไม่ยอม
                  ห้ามลองซ้ำ ให้หาทางอื่นหรือบอกในคำตอบว่าต้องให้ผู้ใช้อนุญาตอะไร
                ref: packages/engine/src/tools/agent.ts#denialText
                emits: [denied]
              - use: tool-result-returns
              - lane: panel
                at: rail
                do: >-
                  แผงแสดงป้ายปฏิเสธของ Auto เหมือนกรณี deny เพราะทั้งสองมาจาก classifier
                sees: '"Denied by Auto" ตามด้วยเหตุผลของ classifier'
                ref: packages/extension/src/chat/session-updates.ts#denialOf
              - lane: loop
                at: step
                do: >-
                  `loopStep` ตัดสิน `call-model` turn ทำงานต่อ ถ้า Auto พักแล้ว คำสั่งถัดไปที่ classifier ตอบ `ask`
                  จะขึ้นการ์ดถามผู้ใช้แทน จนกว่าผู้ใช้จะอนุญาตหนึ่งครั้ง
                ref: packages/core/src/loop.ts#loopStep
                emits: [call-model]
                phase: calling-model
                end: { turn: continues, reason: call-model }
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
  โมเดลอ่านเหตุผลแล้วทำต่อ
- **ป้าย Auto-approved ซ่อนในมุมมองย่อ** แผงแสดงป้ายนี้เฉพาะเมื่อวาดทุกขั้น ส่วนป้าย "Denied by Auto" แสดงเสมอ
