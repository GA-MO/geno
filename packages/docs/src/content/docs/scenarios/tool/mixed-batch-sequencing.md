---
title: ลำดับชุดคำสั่งแบบผสม
description: โมเดลขออ่านสองไฟล์ รันคำสั่ง แล้วอ่านอีกไฟล์ในคำตอบเดียว harness แบ่งเป็นสามชุดที่รันต่อกัน และหยุดชุดที่เหลือถ้าผู้ใช้ปฏิเสธคำสั่ง
tableOfContents: false
sidebar:
  order: 3
scenario:
  surface: vscode
  given:
    - turn กำลังทำงานในโหมด Ask ในแผงแชตของ VS Code
    - ไม่มี hook ที่ตั้งไว้ ทุก path อยู่ใน workspace และ `pnpm add zod` ไม่อยู่ใน safe list และไม่ตรงกับกฎของ workspace
  trigger: >-
    โมเดลตอบด้วยบล็อก `tool_use` สี่บล็อกตามลำดับ: `read package.json`, `read src/date.ts`, `bash pnpm add zod`, `read pnpm-lock.yaml`
  covers: [tool.mixed-batch-sequencing]
  related: [tool.parallel-read-batch, perm.ask-allow, perm.ask-deny-ends-turn, ctl.stop-while-tools-run]
  steps:
    - id: asks
      lane: model
      do: >-
        โมเดลขอเรียกเครื่องมือสี่ตัวในคำตอบเดียว และจบด้วย `stop_reason: tool_use`
      ref: "packages/engine/src/gateway.ts#\"stopReason: message.stop_reason,\""
      emits: [tool_use]
      phase: calling-model

    - id: logged
      lane: loop
      at: drive
      do: >-
        `drive` บันทึก event `assistant` ที่มีบล็อก `tool_use` ทั้งสี่ลง log
      ref: "packages/engine/src/drive.ts#\"await record({ kind: 'assistant', seq: nextSeq(events), at, ...result.turn\""
      emits: [assistant]

    - use: tool-call-opens

    - id: first-batch
      lane: loop
      at: tools
      do: >-
        ชุดแรกเริ่มที่ call แรก `concurrentAt` บอกว่า `read` สองตัวแรกรันพร้อมกันได้ แต่ `bash` ไม่ได้
        ชุดแรกจึงมีแค่ `read` สองตัว
      ref: "packages/engine/src/drive.ts#\"const concurrentAt = (i: number): boolean =>\""

    - id: reads
      lane: tool
      at: executor
      runs: 2
      do: >-
        `read` ทั้งสองอ่านไฟล์พร้อมกัน แต่ละตัวส่งสถานะจบให้แผงทันทีที่เสร็จ
      ref: packages/engine/src/tools/read.ts#readTool

    - id: wait
      lane: loop
      at: tools
      do: >-
        `runTools` รอให้ทุก call ในชุดจบก่อนเริ่มชุดถัดไป ผลถูกเก็บในหน่วยความจำ ยังไม่ลง log
      ref: "packages/engine/src/drive.ts#\"await Promise.all(calls);\""

    - id: second-batch
      lane: loop
      at: tools
      do: >-
        `nextToolBatch` เริ่มชุดที่สองที่ `bash` ซึ่งรันพร้อมตัวอื่นไม่ได้ จึงเป็นชุดที่มีมันตัวเดียว
        แผงขึ้นขั้น "pnpm add zod" ที่กำลังหมุน
      ref: packages/core/src/tool-batch.ts#nextToolBatch

    - id: judge
      lane: policy
      at: rules
      do: >-
        `approveCommand` ส่งคำสั่งให้ `ruledDenial` ผลคือ `unlisted` ซึ่งในโหมด Ask ต้องถามผู้ใช้
      ref: packages/core/src/permission-rules.ts#ruledDenial
      emits: [unlisted]

    - id: settle
      lane: policy
      at: settle
      do: >-
        `settle` ไม่มี hook ตอบแทน จึงส่งคำถามต่อให้ผู้ใช้ผ่าน `approval.approve`
      ref: packages/engine/src/tools/agent.ts#settle

    - id: ask
      lane: server
      at: approvals
      do: >-
        `editorTurn.approve` ส่งคำขอ ACP `session/request_permission` งานในแผง Tasks เปลี่ยนเป็น `needs-input`
      ref: packages/engine/src/serve.ts#editorTurn.approve
      emits: [requestPermission, needs-input]
      phase: waiting-user

    - id: forward
      lane: editor
      at: chat
      do: >-
        `askPermission` ส่ง action `permission` ให้ webview และโฟกัสแผงแชต
      ref: packages/extension/src/chat/chat.ts#Chat.askPermission
      emits: [permission]

    - id: card
      lane: panel
      at: card
      do: แผงแชตแสดงการ์ดขออนุญาตใต้ขั้นของคำสั่ง
      sees: >-
        การ์ด "Run this command?" แสดงคำสั่ง `pnpm add zod` พร้อมเหตุผล "Geno asks because it uses a command not on the safe list."
        [Allow] [Deny] [Always allow in this workspace] [No, and tell the agent…]
      ref: packages/extension/src/chat/render.ts#permissionCard

    - id: choice
      lane: user
      do: ผู้ใช้เลือกปุ่มบนการ์ด `read pnpm-lock.yaml` ยังไม่เริ่ม เพราะชุดของมันอยู่หลังคำสั่งนี้
      fork:
        ask: ผู้ใช้กดปุ่มไหน
        options:
          - id: allow
            label: Allow
            then: third-batch
            steps:
              - lane: editor
                at: chat
                do: >-
                  การ์ดย่อเหลือ Allowed `askPermission` ตอบ engine ว่า `selected` ตัวเลือก `allow`
                ref: packages/extension/src/chat/chat.ts#Chat.askPermission
                emits: [permission-done]
              - lane: server
                at: approvals
                do: >-
                  `permissionAnswerOf` แปลงคำตอบเป็น `allow`
                ref: packages/engine/src/serve.ts#permissionAnswerOf
              - lane: policy
                at: settle
                do: >-
                  `settle` บันทึก `decidedBy: user, verdict: allow`
                ref: packages/engine/src/tools/agent.ts#settle
                phase: running-tools
              - lane: tool
                at: shell
                runs: 1
                do: >-
                  `bash` รัน `pnpm add zod` ใน sandbox จนจบ `pnpm-lock.yaml` เปลี่ยนก่อนที่ `read` ตัวสุดท้ายจะเริ่ม
                  ผลของมันมีบันทึกการอนุญาต (`approval`) ติดไป อัปเดตผลของ call นี้จึงมี `APPROVAL_META` ส่วนผลของ `read` ไม่มี
                ref: "packages/engine/src/tools/agent.ts#\"tools.sandbox.run(command\""
          - id: reject
            label: Deny
            steps:
              - lane: editor
                at: chat
                do: >-
                  `askPermission` ตอบ engine ว่า `selected` ตัวเลือก `reject`
                ref: packages/extension/src/chat/chat.ts#Chat.askPermission
                emits: [permission-done]
              - lane: server
                at: approvals
                do: >-
                  `permissionAnswerOf` แปลงคำตอบเป็น `reject`
                ref: packages/engine/src/serve.ts#permissionAnswerOf
              - lane: policy
                at: settle
                do: >-
                  `settle` บันทึก `verdict: deny` โดยไม่มีความเห็น `refusalOf` จึงโยน `ToolRejected` คำสั่งไม่ได้รัน
                ref: packages/engine/src/tools/agent.ts#refusalOf
                emits: [ToolRejected]
                phase: running-tools
              - lane: loop
                at: tools
                do: >-
                  หลังชุดที่สอง `runTools` เห็นผลสถานะ `rejected` จึงไม่เริ่มชุดที่สาม แล้วบันทึกผลที่มีตามลำดับ:
                  `read` สองตัวแรกและคำสั่งที่ถูกปฏิเสธ `read pnpm-lock.yaml` ยังไม่มีผล
                  ผลที่ถูกปฏิเสธมี `approval` ติดไป อัปเดตของมันจึงมี `APPROVAL_META` ซึ่งแผงใช้ขึ้นป้าย "Denied by you"
                ref: "packages/engine/src/drive.ts#\"results.some((result) => result?.status === 'rejected')\""
                emits: [rejected, tool-result]
              - lane: loop
                at: step
                do: >-
                  `loopStep` เห็น call ที่ยังไม่มีผลหลังการปฏิเสธของผู้ใช้ จึงตัดสิน `answer-tools`
                  `drive` ตอบ `read pnpm-lock.yaml` ด้วย `UNRUN_TEXTS.rejected` ("The user rejected an earlier call of this turn...")
                  ขั้นของมันขึ้นในแผงเป็นขั้นที่ล้มเหลว
                ref: packages/core/src/loop.ts#unrunnable
                emits: [answer-tools]
              - lane: loop
                at: step
                do: >-
                  รอบถัดไป `loopStep` เห็นว่าผู้ใช้ปฏิเสธ call ของ turn นี้ จึงได้ `done(end_turn)` โดยไม่เรียกโมเดลอีก
                  และ Stop hook ไม่ทำงาน
                ref: packages/core/src/loop.ts#loopStep
                emits: [end_turn]
                phase: ending
              - lane: server
                at: turns
                do: >-
                  `runTurn` แปลงผลด้วย `TURN_ENDS` เป็น `stopReason: end_turn` และงานจบแบบ `done`
                ref: packages/engine/src/serve.ts#TURN_ENDS
              - lane: editor
                at: chat
                do: >-
                  `prompt()` ส่ง action `turn-end` สถานะ `done`
                ref: "packages/extension/src/chat/chat.ts#\"const status = turnEndOf(response);\""
                emits: [turn-end]
              - lane: panel
                at: rail
                do: >-
                  `missingReply` ดูขั้นเครื่องมือสุดท้าย ซึ่งคือ `read pnpm-lock.yaml` ที่ล้มเหลว ไม่ใช่คำสั่งที่ถูกปฏิเสธ
                  จึงให้เหตุผลว่าคำตอบสุดท้ายไม่มีข้อความ แทนที่จะบอกว่าหยุดที่ call ที่ถูกปฏิเสธ
                sees: >-
                  ขั้น "pnpm add zod" ขึ้นป้าย "Denied by you" ขั้น "read pnpm-lock.yaml" ล้มเหลว
                  และกล่อง "Geno stopped without a reply · Its last reply had no text." พร้อม [Continue] [Retry]
                ref: packages/extension/src/chat/rail.ts#missingReply
                end: { turn: done, reason: end_turn }

    - id: third-batch
      lane: loop
      at: tools
      do: >-
        `runTools` เริ่มชุดที่สามหลังคำสั่งจบ `read pnpm-lock.yaml` อยู่ชุดนี้ตัวเดียวเพราะไม่มี call หลังมัน
      ref: packages/core/src/tool-batch.ts#nextToolBatch

    - id: last-read
      lane: tool
      at: executor
      runs: 1
      do: >-
        `read` อ่าน `pnpm-lock.yaml` ฉบับที่ `pnpm add` เพิ่งเขียน
      ref: packages/engine/src/tools/read.ts#readTool

    - use: tool-result-returns

    - id: next
      lane: loop
      at: step
      do: >-
        `loopStep` เห็น `tool-result` ล่าสุดจึงตัดสิน `call-model` โมเดลได้ผลทั้งสี่ตามลำดับที่มันขอ
      ref: packages/core/src/loop.ts#loopStep
      emits: [call-model]
      phase: calling-model
      end: { turn: continues, reason: call-model }
---

harness ไม่รันทุก call พร้อมกัน และไม่รันทีละตัวทั้งหมด มันแบ่ง call ของคำตอบหนึ่งเป็นชุดที่รันต่อกันตามลำดับที่โมเดลขอ

| ชุด | call | รันอย่างไร |
| --- | --- | --- |
| 1 | `read package.json`, `read src/date.ts` | พร้อมกัน |
| 2 | `bash pnpm add zod` | ตัวเดียว หลังชุด 1 จบ |
| 3 | `read pnpm-lock.yaml` | หลังชุด 2 จบ |

call ที่เปลี่ยนอะไรได้ (`bash`, `edit`) หรืออาจต้องถามผู้ใช้ รันตัวเดียวเสมอ ทุก call หลังมันจึงเห็นผลของมัน
เช่น `read` ตัวสุดท้ายได้ `pnpm-lock.yaml` หลังติดตั้งแล้ว

สิ่งที่ควรสังเกต

- **ผลลง log ตามลำดับที่โมเดลขอ** สถานะจบของแต่ละ call ไปถึงแผงทันทีที่เสร็จ แต่ข้อความผลไปถึงหลังบันทึกทั้งคำตอบ
- **Deny หยุดชุดที่เหลือ** ชุดที่อยู่หลังคำสั่งที่ผู้ใช้ปฏิเสธไม่เริ่ม `loopStep` ตอบ call เหล่านั้นว่าไม่ได้รันเพราะผู้ใช้ปฏิเสธก่อนหน้า
  แล้วจบ turn โดยไม่เรียกโมเดล
- **ประกาศท้าย turn บอกเหตุผลผิด** เมื่อมี call ที่ยังไม่ได้รันตามหลังคำสั่งที่ถูกปฏิเสธ ขั้นเครื่องมือสุดท้ายในแผงคือ call ที่ล้มเหลว
  ไม่ใช่ call ที่ถูกปฏิเสธ `missingReply` จึงขึ้น "Its last reply had no text." แทน "It stopped at the call that was denied."
