---
title: "โหมด Plan ปฏิเสธคำสั่งและการแก้ไฟล์"
description: ในโหมด Plan คำสั่งนอก safe list ถูกปฏิเสธด้วยกฎ การแก้ไฟล์และงานเบื้องหลังถูกปฏิเสธเป็น error และโมเดลทำงานต่อโดยไม่จบ turn
tableOfContents: false
sidebar:
  order: 5
scenario:
  surface: vscode
  given:
    - session อยู่ในโหมด Plan และ turn กำลังทำงาน
    - ไม่มี hook ที่ตั้งไว้
  trigger: >-
    โมเดลขอเรียกเครื่องมือที่เปลี่ยนอะไรบางอย่าง ทั้งที่ประกาศของโหมด Plan บอกแล้วว่าทำไม่ได้
  covers: [perm.plan-command-denied, perm.plan-edit-refused]
  related: [perm.plan-start-building, perm.mode-switch-mid-turn, perm.deny-rule, tool.bash-background]
  steps:
    - id: asks
      lane: model
      beat:
        title: "Model ขอ tool ที่เปลี่ยนอะไรบางอย่าง"
        text: >-
          ทุกโหมดได้ tool ชุดเดียวกัน `edit` จึงอยู่ในคำขอแม้ในโหมด Plan และโมเดลเรียกได้ ทั้งที่ประกาศของโหมด Plan
          บอกแล้วว่าทำไม่ได้ ประกาศจาก run จริงด้านล่างเป็นแบบนี้
        from: model
        to: engine
        sees:
          kind: payload
          direction: request
          source: docs/results/real-usecases/runs/A10-plan-mode/1/requests.jsonl#seq=6
          select: messages[-1].content[3]
      do: >-
        โมเดลขอเรียกเครื่องมือหนึ่งตัวและจบคำตอบด้วย `stop_reason: tool_use`
      ref: "packages/engine/src/gateway.ts#\"stopReason: message.stop_reason,\""
      emits: [tool_use]
      phase: calling-model

    - id: logged
      lane: loop
      at: drive
      do: >-
        `drive` บันทึก event `assistant` ที่มีบล็อก `tool_use` ลง log ทุกโหมดได้เครื่องมือชุดเดียวกัน
        `edit` จึงอยู่ในคำขอแม้ในโหมด Plan และโมเดลเรียกมันได้
      ref: "packages/engine/src/drive.ts#\"await record({ kind: 'assistant', seq: nextSeq(events), at, ...result.turn\""
      emits: [assistant]

    - use: tool-call-opens
      beat:
        title: "แชตขึ้นขั้นของ call"
        text: >-
          Geno จัดคิว call แล้วแชตขึ้นขั้นใหม่พร้อมจุดหมุน
        from: engine
        to: panel

    - id: which
      lane: tool
      at: executor
      beat:
        title: "Geno อ่านโหมดตอน call รัน"
        text: >-
          Geno อ่านโหมดของ session ตอนที่ call รัน ได้ Plan ลองเลือกว่าโมเดลเรียกอะไร
        from: engine
        to: engine
        ask: "โมเดลเรียกอะไร"
      runs: 0
      do: >-
        executor อ่านโหมดของ session ตอน call รัน ได้ `plan`
      ref: packages/engine/src/tools/agent.ts#inMode
      fork:
        ask: โมเดลเรียกอะไร
        options:
          - id: command
            label: bash pnpm add zod
            then: denied
            steps:
              - lane: policy
                at: rules
                beat:
                  title: "กฎในตัวของโหมด Plan ปฏิเสธคำสั่ง"
                  text: >-
                    โหมด Plan ใช้แค่กฎในตัว ไม่อ่านกฎของ workspace `pnpm add zod` ไม่อยู่ในรายการคำสั่งปลอดภัยจึงถูกปฏิเสธ
                    ไม่ถามคุณและไม่มี classifier ผลบอกให้เปลี่ยนเป็น Ask หรือ Auto ถ้าจะแก้อะไร
                  from: engine
                  to: model
                do: >-
                  `ruledDenial` ในโหมด Plan ใช้แค่คำตัดสินในตัว ไม่อ่านกฎของ workspace กฎ `unlisted` ในโหมด Plan คือ `deny`
                ref: packages/core/src/permission-rules.ts#ruledDenial
                emits: [unlisted]
              - lane: policy
                at: settle
                do: >-
                  `settle` ปฏิเสธเองโดยไม่ถามผู้ใช้และไม่ส่ง classifier บันทึก `decidedBy: rule`
                  `refusalOf` สร้าง `ToolDenied` ข้อความผลบอกเหตุผลของโหมด
                  ("denied: `pnpm add zod` uses a command not on the safe list. Plan mode is read-only; switch to Ask or Auto to make changes. ...")
                ref: packages/engine/src/tools/agent.ts#denialText
                emits: [ToolDenied]
              - lane: server
                at: updates
                do: >-
                  หลังผลลง log `toolResultUpdate` ส่ง `tool_call_update` สถานะ `failed` พร้อม `APPROVAL_META`
                ref: packages/engine/src/session-replay.ts#toolResultUpdate
                emits: [APPROVAL_META]
              - lane: panel
                at: rail
                beat:
                  title: "แชตขึ้นป้าย Denied by a rule"
                  text: >-
                    แชตเห็นว่าการปฏิเสธมาจากกฎ ไม่ใช่จากคุณ จึงขึ้นป้ายปฏิเสธพร้อมเหตุผล
                  from: panel
                  to: you
                  sees: { kind: step, label: pnpm add zod, status: denied, note: Denied by a rule · A command not on the safe list is not allowed here. }
                alongside: true
                do: >-
                  `denialOf` เห็นการปฏิเสธโดยกฎที่ไม่ใช่ของผู้ใช้ แผงขึ้นป้ายปฏิเสธพร้อมเหตุผล
                sees: ป้าย "Denied by a rule" และ "A command not on the safe list is not allowed here."
                ref: packages/extension/src/chat/session-updates.ts#denialOf
          - id: edit
            label: edit src/date.ts
            then: denied
            steps:
              - lane: tool
                at: executor
                beat:
                  title: "โหมด Plan ไม่มี edit ให้ใช้"
                  text: >-
                    `edit` ไม่อยู่ในรายการ tool ของโหมด Plan call ล้มเหลวทันทีก่อนอ่านไฟล์หรือดูกฎใดๆ และไม่มีบันทึกการปฏิเสธ
                  from: engine
                  to: model
                do: >-
                  `inMode` เห็นว่า `AGENT_MODE_TOOLS.plan` ไม่มี `edit` จึงโยน `ToolError`
                  "edit is not available: Plan mode is read-only; switch to Ask or Auto to make changes. Do not retry it."
                  ก่อนอ่านไฟล์หรือดูกฎใดๆ ไม่มีบันทึกการปฏิเสธ
                ref: packages/core/src/agent.ts#AGENT_MODE_TOOLS
                emits: [ToolError]
              - lane: server
                at: updates
                do: >-
                  หลังผลลง log `toolResultUpdate` ส่ง `tool_call_update` สถานะ `failed` โดยไม่มี `APPROVAL_META`
                ref: packages/engine/src/session-replay.ts#toolResultUpdate
                emits: [tool_call_update]
              - lane: panel
                at: rail
                beat:
                  title: "แชตขึ้นขั้นล้มเหลวธรรมดา"
                  text: >-
                    ผลเป็น error ไม่ใช่การปฏิเสธ แชตจึงแสดงขั้นเป็นล้มเหลวธรรมดาโดยไม่มีป้าย
                  from: panel
                  to: you
                  sees: { kind: step, label: edit src/date.ts, status: failed, output: "edit is not available: Plan mode is read-only; switch to Ask or Auto to make changes. Do not retry it." }
                alongside: true
                do: >-
                  ผลมีสถานะ `error` ไม่ใช่ `denied` แผงจึงแสดงขั้นเป็นล้มเหลวธรรมดา ไม่มีป้ายปฏิเสธ
                sees: ขั้นของ `edit src/date.ts` ขึ้นไอคอน error และผลที่พับไว้คือข้อความของ `ToolError`
                ref: packages/extension/src/chat/session-updates.ts#updateActions
          - id: background
            label: bash แบบเบื้องหลัง
            then: denied
            steps:
              - lane: policy
                at: rules
                beat:
                  title: "โหมด Plan ปฏิเสธงานเบื้องหลังทั้งหมด"
                  text: >-
                    งานเบื้องหลังถูกปฏิเสธก่อนดูกฎใดๆ แม้คำสั่งนั้นจะอยู่ในรายการคำสั่งปลอดภัย
                  from: engine
                  to: model
                do: >-
                  `approveCommand` ปฏิเสธงานเบื้องหลังในโหมด Plan ก่อนดูกฎใดๆ ด้วย `ToolError`
                  "background commands are not available: Plan mode is read-only; ... Do not retry it."
                  แม้คำสั่งนั้นจะอยู่ใน safe list
                ref: "packages/engine/src/tools/agent.ts#\"if (background && mode === 'plan') throw new ToolError(\""
                emits: [ToolError]

    - id: denied
      lane: loop
      at: step
      beat:
        title: "Model ทำแผนต่อด้วย tool อ่านอย่างเดียว"
        text: >-
          ไม่มีอะไรรันและไม่มีการ์ด การปฏิเสธนี้ไม่ได้มาจากคุณ turn จึงไม่จบ Geno เรียกโมเดลต่อ
          โมเดลอ่านเหตุผลแล้วทำแผนต่อ
        from: engine
        to: model
        end: "model ทำแผนต่อ"
      do: >-
        ไม่มีอะไรรันและไม่มีการ์ด `loopStep` ตัดสิน `call-model` เพราะการปฏิเสธนี้ไม่ได้มาจากผู้ใช้
        โมเดลอ่านเหตุผลแล้วทำแผนต่อด้วยเครื่องมืออ่านอย่างเดียว
      ref: packages/core/src/loop.ts#loopStep
      emits: [call-model]
      phase: calling-model
      end: { turn: continues, reason: call-model }
---

โหมด Plan ไม่ได้ซ่อน tool ทุกโหมดได้ tool ชุดเดียวกันเพื่อให้ prompt cache ไม่หลุดเมื่อสลับโหมด
Plan ปฏิเสธตอน call รันแทน และประกาศของโหมดบอกโมเดลล่วงหน้าว่าอะไรจะถูกปฏิเสธ

| call | ถูกปฏิเสธที่ | สถานะ | แผงแสดง |
| --- | --- | --- | --- |
| คำสั่งนอก safe list | กฎในตัว (`unlisted`) | `denied` | Denied by a rule |
| `edit`, `notebook_edit`, `monitor`, `task_stop` และ tool ที่เปลี่ยนสถานะอื่นๆ | `inMode` | `error` | ล้มเหลว |
| `bash` แบบ `run_in_background` | `approveCommand` | `error` | ล้มเหลว |
| คำสั่งใน safe list, `read`, `grep`, `web_fetch` | ไม่ปฏิเสธ | `ok` | ปกติ |

สิ่งที่ควรสังเกต

- **การแก้ไฟล์ที่ถูกปฏิเสธดูเหมือนล้มเหลว** `inMode` โยน `ToolError` ซึ่งเป็นสถานะ `error` แผงจึงแสดงเหมือนการแก้ที่ล้มเหลวจริง
  ไม่ได้ขึ้นป้าย "Denied" แบบคำสั่งที่ถูกปฏิเสธ ผู้ใช้ต้องเปิดผลดูจึงรู้ว่าเป็นเพราะโหมด
- **Plan ไม่ถามผู้ใช้เรื่องคำสั่ง** ไม่มีการ์ดในโหมด Plan สำหรับคำสั่ง ทุกคำสั่งที่ไม่ปลอดภัยถูกปฏิเสธทันที
- **turn ไม่จบ** การปฏิเสธทั้งสามแบบเป็นผลที่โมเดลอ่านแล้วทำต่อได้ ต่างจากผู้ใช้กด Deny

เมื่อแผนเสร็จแล้ว ดู [จบแผนแล้วคุณกด Start building](/scenarios/perm/plan-start-building/)
