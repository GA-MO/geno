---
title: "สร้าง subagent แล้วรอรายงาน"
description: model ส่งงานให้ worker ลูกทำงานใน session ของตัวเอง ขออนุญาตผ่านการ์ดเดียวกับแม่ แล้วส่งรายงานที่ถูกล้อมรั้วกลับมาเป็นผลของ call
tableOfContents: false
sidebar:
  order: 1
scenario:
  surface: vscode
  given:
    - ค่า `agentTool` ในไฟล์ตั้งค่าของ Geno มี `ask` model ในโหมด Ask จึงมี tool `agent`
    - เปิด Geno ในโหมด Ask มี turn ทำงานอยู่ และรอบนี้ยังไม่ได้ใช้งบไปกับลูกตัวอื่น
  trigger: >-
    ผู้ใช้ขอให้เพิ่ม script `check` ที่รัน `tsc --noEmit` ใน package.json model ตัดสินใจส่งงานนี้ให้ subagent `worker`
  covers: [sub.blocking-report, sub.asks-permission]
  related: [sub.at-mention, sub.user-cancels-child, sub.parent-stop-with-children, bg.child-wakes-parent, perm.ask-allow]
  steps:
    - id: wants
      lane: model
      beat:
        title: "Model ส่งงานให้ subagent ชื่อ worker"
        text: >-
          request ของแม่มี tool `agent` ซึ่งคำอธิบายบอกรายชื่อ subagent ที่เลือกได้ และบอกว่าลูกไม่เห็นบทสนทนานี้
          (แท็บแรก) model ตอบเป็น block `tool_use` ชื่อ `agent` (แท็บสอง): `agent: "worker"` คือใคร
          `task` คือคำสั่งงานที่เขียนให้ครบในตัว ไม่ได้ใส่ `background` จึงรอรายงานใน call นี้ และไม่ได้ใส่ `fork`
          ลูกจึงเริ่มจากศูนย์
        from: model
        to: engine
        sees:
          - kind: payload
            source: packages/docs/src/data/recorded/child-permission.jsonl#line=2
            select: tools[9]
            highlight: [description, input_schema.properties]
          - kind: payload
            source: packages/docs/src/data/recorded/child-permission.jsonl#line=13
            select: messages[1].content
            highlight: ['[1].input.agent', '[1].input.task']
      do: >-
        model ขอเรียก `agent` ด้วย `agent: "worker"` และ `task` ที่เขียนให้ครบในตัว เพราะลูกไม่เห็นบทสนทนานี้
        จบคำตอบด้วย `stop_reason: tool_use`
      ref: packages/core/src/subagent.ts#agentToolDefinition
      emits: [tool_use]
      phase: calling-model

    - id: decide
      lane: loop
      at: step
      do: >-
        `drive` บันทึก event `assistant` แล้ว `loopStep` ตัดสินว่า `run-tools`
      ref: packages/core/src/loop.ts#loopStep
      emits: [run-tools]
      phase: running-tools

    - id: launch
      lane: loop
      at: tools
      runs: 1
      beat:
        title: "Geno เปิด session ใหม่ให้ worker"
        text: >-
          request แรกของลูกคือสิ่งที่ worker รู้ทั้งหมด system prompt เป็นกรอบ subagent ตามด้วย role ของ worker
          จากนิยามในตัว Geno (`BUILTIN_AGENTS` ใน `packages/core/src/subagent.ts`) ถ้า role มาจากไฟล์
          `.claude/agents/*.md` หรือ `.agents/agents/*.md` ของโปรเจกต์ ส่วนท้ายคือเนื้อไฟล์นั้นแทน (แท็บสุดท้าย จากอีก flow หนึ่ง)
          tool ของลูกคือ bash, check, edit, glob, grep, list, notebook_edit, read, skill, tool_search และ `report`
          (แท็บสอง) ไม่มี `agent` และ `todo` ข้อความแรกมีแค่ environment กับ `task`
          ไม่มีบทสนทนาของแม่ ลูกได้งบไม่เกิน 30 รอบและ $0.20 และเพราะ worker แก้ไฟล์ได้ จึงทำงานทีละตัวบนโฟลเดอร์หลัก
        from: engine
        to: model
        sees:
          - kind: payload
            source: packages/docs/src/data/recorded/child-permission.jsonl#line=4
            select: system
            quote: You are worker, a subagent that changes code
          - kind: payload
            source: packages/docs/src/data/recorded/child-permission.jsonl#line=4
            select: tools[9]
            highlight: [name, description]
          - kind: payload
            source: packages/docs/src/data/recorded/child-permission.jsonl#line=4
            select: messages[0]
            highlight: ['content[1].text']
          - kind: payload
            source: packages/docs/src/data/recorded/project-agent.jsonl#line=4
            select: system
            quote: You write release notes.
      do: >-
        executor ของ `agent` เรียก `launch` `worker` แก้ไฟล์ได้ จึงรันทีละตัวบน checkout หลัก (ลูกแบบอ่านอย่างเดียวรันพร้อมกันได้ 4 ตัว)
        `runChild` ตั้งเพดานของลูก: 30 รอบ และ $0.20 แต่ไม่เกินงบที่รอบของแม่ยังเหลือให้ลูกทั้งหมด (งบ $0.40 ของแม่คืองบรวมของลูกด้วย)
      ref: packages/engine/src/subagents.ts#runChild

    - id: spawn
      lane: child@worker
      at: loop
      do: >-
        `openSpawn` เปิด log ของลูกเป็น session ใหม่: `session-start` ที่มี model คำสั่งโปรเจกต์ หน่วยความจำ สภาพแวดล้อม
        และข้อมูลว่าใครเป็นแม่ SubagentStart hook (ถ้ามี) ได้ใส่บริบทเพิ่ม
      ref: packages/engine/src/subagents.ts#openSpawn

    - id: noted
      lane: loop
      at: drive
      do: >-
        `runPlaced` บันทึก event `child-start` ลง log ของแม่ event นี้ไม่ใช่ส่วนของบทสนทนา model ของแม่ไม่เห็น
      ref: "packages/engine/src/subagents.ts#\"await ctx.logNote!({ kind: 'child-start'\""
      emits: [child-start]

    - id: announce
      lane: server
      at: updates
      beat:
        title: "แชตขึ้นแถวของ worker"
        text: >-
          ใต้ขั้นที่ส่งงานขึ้นแถวของลูกพร้อมนาฬิกาและปุ่ม Cancel แผง Tasks ก็มีงานของลูกเพิ่มขึ้น
          คลิกแถวเพื่อเปิดบทสนทนาของลูกได้
        from: engine
        to: panel
        sees: { kind: task, title: worker, status: running, detail: "0:04", actions: [Cancel] }
      do: >-
        `acpChildHost.started` ลงทะเบียนตัวยกเลิกของลูก เพิ่มงานของลูกในแผง Tasks
        แล้วส่ง `session/update` ชนิด `subagent_update` สถานะ `running` บน session ของแม่
        อัปเดตของลูกเองส่งแยกภายใต้ session id ของลูก
      ref: packages/engine/src/subagent-acp.ts#acpChildHost
      emits: [subagent_update, running]

    - id: row-start
      lane: editor
      at: chat
      alongside: true
      do: >-
        `subagentAction` แปลงอัปเดตเป็น action `child-start` ผูกกับ call `agent` ด้วย `toolUseId`
      ref: packages/extension/src/chat/subagent-host.ts#subagentAction
      emits: [child-start]

    - id: row
      lane: panel
      at: rail
      alongside: true
      do: >-
        ใต้ขั้นของ `agent` ขึ้นแถวของลูก: ไดโนเสาร์ผู้ช่วย ชื่อ model นาฬิกา และปุ่ม Cancel คลิกแถวเพื่อเปิดบทสนทนาของลูก
      sees: แถว "worker · <model> · 0:04" พร้อมไดโนเสาร์ที่ขยับ และปุ่ม [Cancel]
      ref: packages/extension/src/chat/subagent-view.ts#childRow

    - id: child-model
      lane: child@worker
      at: model
      beat:
        title: "Worker อ่าน package.json แล้วขอรัน `npm pkg set`"
        text: >-
          ลูกคุยกับ model ผ่านการเชื่อมต่อเดียวกับแม่ มันอ่าน package.json ก่อน แล้วขอรัน
          `npm pkg set scripts.check="tsc --noEmit"` ซึ่งเป็นคำสั่งที่ต้องขออนุญาต
        from: model
        to: engine
        sees:
          kind: payload
          source: packages/docs/src/data/recorded/child-permission.jsonl#line=9
          select: messages[3].content
          highlight: ['[1].input.command']
      do: >-
        ลูกเรียก model ผ่าน gateway ของแม่ system prompt ของลูกคือ `childSystemPrompt`: กรอบงาน คำสั่งให้จบด้วย `report`
        และเนื้อหาของนิยาม `worker` model ของลูกอ่านไฟล์ แล้วขอรัน `bash` ด้วย `npm pkg set scripts.check="tsc --noEmit"`
      ref: packages/core/src/subagent.ts#childSystemPrompt
      emits: [tool_use]

    - id: child-judge
      lane: policy
      at: rules
      beat:
        title: "Geno หยุดทั้งสอง agent แล้วถามคุณ"
        text: >-
          ลูกใช้กฎและโหมดเดียวกับแม่ คำสั่งนี้ไม่อยู่ในรายการปลอดภัย Geno จึงหยุดลูกไว้และส่งคำขอ ACP
          `session/request_permission` ไปที่ editor บน session ของแม่ คำขอผูกกับ call `agent` ของแม่ (`toolCallId`)
          หัวข้อขึ้นต้นด้วย `[worker]` และ `_meta` บอกชื่อกับ session ของลูก
        from: engine
        to: panel
        sees:
          - { kind: task, title: worker, status: needs-input }
          - kind: payload
            source: packages/docs/src/data/recorded/child-permission.jsonl#line=8
            highlight: [params.toolCall.title, params._meta]
      do: >-
        ลูกใช้นโยบายและโหมดเดียวกับแม่ `ruledDenial` ได้ `unlisted` ซึ่งในโหมด Ask ต้องถาม
        ตัวขออนุญาตของลูก (`asker`) แนบชื่อและ session ของลูกไปกับคำถาม
      ref: packages/core/src/permission-rules.ts#ruledDenial
      emits: [unlisted]

    - id: child-ask
      lane: server
      at: approvals
      do: >-
        `editorTurn.approve` ส่งคำขอ ACP `session/request_permission` หัวข้อขึ้นต้นด้วยชื่อลูก งานของลูกเป็น `needs-input`
        และรวมขึ้นไปที่แถวของแม่ในแผง Tasks
      ref: packages/engine/src/serve.ts#editorTurn.approve
      emits: [requestPermission, needs-input]
      phase: waiting-user

    - id: child-forward
      lane: editor
      at: chat
      do: >-
        `askPermission` ส่ง action `permission` ให้ webview และโฟกัสแผงแชต
      ref: packages/extension/src/chat/chat.ts#Chat.askPermission
      emits: [permission]

    - id: child-card
      lane: panel
      at: card
      beat:
        title: "คุณเห็นการ์ด “Run this command?”"
        text: >-
          การ์ดเดียวกับที่แม่ใช้ขึ้นในแชตของแม่ ทั้งแม่และลูกรอคำตอบของคุณ
          การ์ดไม่บอกว่าลูกตัวไหนเป็นคนขอ
        from: panel
        to: you
        ask: กดปุ่มไหน
        sees: { kind: permission, command: 'npm pkg set scripts.check="tsc --noEmit"', reason: Geno asks because it uses a command not on the safe list. }
      do: >-
        การ์ดขออนุญาตขึ้นในบทสนทนาของแม่ หัวข้อของคำขอ ACP ขึ้นต้นด้วย `[worker]` แต่การ์ดใช้หัวข้อของตัวเอง
        จึงไม่บอกว่าลูกตัวไหนเป็นคนขอ
      sees: >-
        "Run this command?" คำสั่ง `npm pkg set scripts.check="tsc --noEmit"` และ "Geno asks because it uses ..."
        [Allow] [Deny] [Always allow in this workspace] [No, and tell the agent…]
      ref: packages/extension/src/chat/render.ts#permissionCard

    - id: answer
      lane: user
      do: ผู้ใช้อ่านการ์ดแล้วตอบ ทั้งแม่และลูกรออยู่ตรงนี้
      fork:
        ask: ผู้ใช้ตอบอะไร
        options:
          - id: allow
            label: Allow
            then: report
            steps:
              - lane: editor
                at: chat
                beat:
                  title: "คุณกด Allow แล้ว worker รันคำสั่ง"
                  text: >-
                    คำตอบของคุณไปถึงลูก ลูกรันคำสั่งใน sandbox แล้วได้ผลกลับเป็น `[exit code 0]`
                    Geno แนบโน้ตว่า package.json เปลี่ยนบนดิสก์ พร้อมบรรทัดที่เปลี่ยน แม้คนเปลี่ยนคือคำสั่งของลูกเอง
                  from: you
                  to: panel
                  sees:
                    kind: payload
                    source: packages/docs/src/data/recorded/child-permission.jsonl#line=9
                    select: messages[4]
                    highlight: ['content[0]', 'content[1].text']
                do: >-
                  `askPermission` ตอบ engine ว่า `selected` ตัวเลือก `allow`
                ref: packages/extension/src/chat/chat.ts#Chat.askPermission
                emits: [permission-done]
              - lane: policy
                at: settle
                do: >-
                  `settle` คืนบันทึก `decidedBy: user, verdict: allow` บนผลของ call ในลูก
                ref: packages/engine/src/tools/agent.ts#settle
                phase: running-tools
              - lane: tool
                at: shell
                do: >-
                  `bash` ของลูกรัน `npm pkg set` ใน sandbox แล้วลูกทำงานต่อ: อ่าน package.json อีกครั้งเพื่อยืนยัน
                ref: "packages/engine/src/tools/agent.ts#\"tools.sandbox.run(command\""

          - id: reject
            label: Deny
            steps:
              - lane: editor
                at: chat
                beat:
                  title: "คุณกด Deny"
                  text: >-
                    คำสั่งไม่ได้รัน คำปฏิเสธเปล่าๆ แปลว่าคุณอยากเป็นคนพูดต่อ ไม่ใช่แค่ลูก
                  from: you
                  to: panel
                do: >-
                  `askPermission` ตอบ engine ว่า `selected` ตัวเลือก `reject`
                ref: packages/extension/src/chat/chat.ts#Chat.askPermission
                emits: [permission-done]
              - lane: policy
                at: settle
                do: >-
                  `settle` คืนบันทึก `verdict: deny` โดยไม่มีความเห็น จึงเป็น `ToolRejected` คำสั่งไม่ได้รัน
                ref: packages/engine/src/tools/agent.ts#refusalOf
                emits: [ToolRejected]
                phase: running-tools
              - lane: child@worker
                at: loop
                beat:
                  title: "Worker หยุด และ tool call ของแม่ก็หยุดด้วย"
                  text: >-
                    ลูกจบทันทีโดยไม่มีรายงาน Geno ถือว่าคำปฏิเสธนี้เป็นของแม่ด้วย
                    งานที่แม่ส่งให้ลูกจึงล้มเหลวแบบเดียวกับที่คุณปฏิเสธคำสั่งของแม่เอง
                  from: model
                  to: engine
                do: >-
                  ผลของ call ในลูกมีสถานะ `rejected` `loopStep` ของลูกจบ `done(end_turn)` ทันทีเพราะผู้ใช้เป็นคนพูดต่อ
                  ลูกจบแบบ `done` โดยไม่มีรายงาน
                ref: packages/core/src/loop.ts#loopStep
                emits: [rejected]
              - lane: loop
                at: tools
                do: >-
                  `launch` บันทึก `child-end` ลง log ของแม่ เห็นว่าลูกมี call ที่ผู้ใช้ปฏิเสธ จึงโยน `ToolRejected` ให้ call `agent` ของแม่ด้วย
                  ข้อความบอกว่า worker หยุดเพราะผู้ใช้ปฏิเสธ และให้หยุดรอผู้ใช้
                ref: "packages/engine/src/subagents.ts#\"if (rejected) throw new ToolRejected(\""
                emits: [ToolRejected, child-end]
              - lane: loop
                at: step
                beat:
                  title: "Turn จบโดยไม่มีคำตอบ"
                  text: >-
                    Geno จบ turn โดยไม่เรียก model อีก แถวของลูกขึ้นว่าเสร็จ แต่ประกาศในแชตบอกว่าคำตอบไม่มีข้อความ
                    แทนที่จะบอกว่าหยุดเพราะคุณปฏิเสธ
                  from: engine
                  to: panel
                  end: Turn จบเพราะคุณกด Deny
                  sees: { kind: notice, text: Geno stopped without a reply, detail: Its last reply had no text., actions: [Continue, Retry], tone: warning }
                do: >-
                  call `agent` ของแม่มีผล `rejected` `loopStep` ของแม่จึงตัดสิน `done(end_turn)` โดยไม่เรียก model
                  เหมือนผู้ใช้ปฏิเสธ call ของแม่เอง
                ref: packages/core/src/loop.ts#loopStep
                emits: [end_turn]
                phase: ending
              - lane: server
                at: turns
                do: >-
                  `runTurn` ตอบ `stopReason: end_turn` งานจบแบบ `done`
                ref: packages/engine/src/serve.ts#TURN_ENDS
                emits: [TURN_END_META]
              - lane: panel
                at: rail
                do: >-
                  แถวของลูกขึ้นเครื่องหมายถูกของ `done` ขั้นของ `agent` เป็นล้มเหลว (ไม่มีป้าย "Denied by you" เพราะผลของแม่ไม่มีบันทึกการอนุญาต)
                  `missingReply` จึงบอกว่าคำตอบไม่มีข้อความ แทนที่จะบอกว่าหยุดที่ call ที่ถูกปฏิเสธ
                sees: >-
                  แถว "✓ worker · <model> · <เวลา>" (คำว่า Done อยู่แค่ใน tooltip ของแถว) และประกาศ "Geno stopped without a reply · Its last reply had no text." [Continue] [Retry]
                ref: packages/extension/src/chat/rail.ts#missingReply
                end: { turn: done, reason: end_turn }

    - id: report
      lane: child@worker
      at: model
      beat:
        title: "Worker เรียก `report` แล้วจบงาน"
        text: >-
          system prompt ของลูกสั่งไว้ว่าเมื่องานเสร็จให้เรียก `report({message})` และข้อความนอก call นั้นไม่ถึงแม่ (แท็บแรก)
          เมื่ออ่าน package.json ยืนยันแล้ว model ของลูกเรียก `report` ซึ่ง stream มาเป็น block `tool_use`
          ชื่อ `report` (แท็บสอง) ตามด้วย `input` ทีละชิ้น (แท็บสาม) call นี้จบ run ของลูก
        from: model
        to: engine
        sees:
          - kind: payload
            source: packages/docs/src/data/recorded/child-permission.jsonl#line=11
            select: system
            quote: When your work is done, call report
          - kind: payload
            source: packages/docs/src/data/recorded/child-permission.jsonl#line=12
            select: '[4]'
            highlight: [data.content_block.name]
          - kind: payload
            source: packages/docs/src/data/recorded/child-permission.jsonl#line=12
            select: '[5]'
            highlight: [data.delta.partial_json]
      do: >-
        เมื่ออ่านไฟล์ยืนยันแล้ว model ของลูกเรียก `report` พร้อมข้อความว่าแก้อะไรที่ไหนและตรวจอย่างไร
        ในบทสนทนาของลูก `report` แสดงเป็นข้อความของลูก ไม่ใช่ขั้น tool
      ref: packages/engine/src/subagents.ts#reportExecutor
      emits: [report]

    - id: child-done
      lane: child@worker
      at: loop
      beat:
        title: "ลูกที่ไม่เรียก `report` ถูกเตือนและถูกบังคับ"
        text: >-
          worker รอบนี้เรียก `report` เอง แต่ถ้าลูกจบ turn ด้วยข้อความเปล่าๆ Geno ส่งโน้ตเตือนหนึ่งครั้งว่ารายงานยังไม่ถึง
          (แท็บแรก จาก explore ในอีก flow หนึ่ง) และเมื่อเหลือการเรียก model ครั้งสุดท้ายที่เพดานยอม Geno ส่ง `tool_choice`
          บังคับ `report` (แท็บสอง) พร้อมโน้ตที่บอกให้เขียนรายงานเดี๋ยวนี้ (แท็บสาม) โน้ตนั้นบอกว่า "Do not call a tool"
          ทั้งที่ `tool_choice` บังคับให้เรียก `report`
        from: engine
        to: model
        sees:
          - kind: payload
            source: packages/docs/src/data/recorded/report-nudge.jsonl#line=8
            select: messages[4]
            highlight: ['content[0].text']
          - kind: payload
            source: packages/docs/src/data/recorded/report-forced.jsonl#line=10
            highlight: [tool_choice]
            collapse: [tools, system, messages]
          - kind: payload
            source: packages/docs/src/data/recorded/report-forced.jsonl#line=10
            select: messages[6]
            highlight: ['content[1].text']
      do: >-
        `loopStep` ของลูกเห็นว่า `report` สำเร็จจึงจบ `done(end_turn)` SubagentStop hook (ถ้ามี) ได้ตัดสินก่อนจบ
        `runPlaced` ดึงรายงานด้วย `handedBack` คืนงบที่จองไว้แต่ไม่ได้ใช้ และบันทึกเวลา รอบ และค่าใช้จ่าย
      ref: packages/core/src/handback.ts#handedBack

    - id: ended
      lane: server
      at: updates
      beat:
        title: "แชตติดเครื่องหมายว่า worker เสร็จ"
        text: >-
          แถวของลูกหยุดนาฬิกา ขึ้นเครื่องหมายถูก เวลาที่ใช้ และค่าใช้จ่าย ปุ่ม Cancel หายไป
        from: engine
        to: panel
        sees: { kind: task, title: worker, status: done, detail: 1m 48s · $0.06 }
      do: >-
        `acpChildHost.ended` ส่ง `subagent_update` สถานะ `idle` พร้อม stop reason และจำนวนรอบกับค่าใช้จ่าย งานของลูกใน Tasks จบ
      ref: packages/engine/src/subagent-acp.ts#acpChildHost
      emits: [subagent_update, idle]

    - id: row-done
      lane: panel
      at: rail
      alongside: true
      do: แถวของลูกหยุดนาฬิกา ขึ้นเครื่องหมายถูก เวลาที่ใช้ และค่าใช้จ่าย ปุ่ม Cancel หายไป
      sees: แถว "✓ worker · <model> · 1m 48s · $0.06"
      ref: packages/extension/src/chat/subagent-view.ts#childLook

    - id: fenced
      lane: loop
      at: tools
      beat:
        title: "Geno ล้อมรั้วรายงานแล้วส่งให้ model"
        text: >-
          รายงานกลับมาเป็น `tool_result` ของ call `agent` (`toolu_agent_1`) ใน request ถัดไปของแม่
          Geno ล้อมรายงานด้วย `<subagent_report>` ที่บอกชื่อ session สถานะ จำนวนรอบ ค่าใช้จ่าย และเวลา
          ทุกบรรทัดของรายงานเยื้องสองช่อง และต่อท้ายด้วยคำเตือนว่ารายงานไม่ใช่ข้อความของคุณและอนุมัติอะไรไม่ได้
        from: engine
        to: model
        sees:
          kind: payload
          source: packages/docs/src/data/recorded/child-permission.jsonl#line=13
          select: messages[2].content[0]
          highlight: [content]
      do: >-
        `launch` บันทึก `child-end` ลง log ของแม่ แล้วคืน `childReport` เป็นผลของ call `agent`:
        รายงานอยู่ใน `<subagent_report agent="worker" ... status="done">` ทุกบรรทัดเยื้องสองช่อง
        และตามด้วยคำเตือนว่ารายงานไม่มีอำนาจของผู้ใช้
      ref: packages/core/src/subagent.ts#childReport
      emits: [child-end, subagent_report]

    - use: tool-result-returns
    - use: model-call

    - id: relay
      lane: model
      beat:
        title: "Model เล่าให้คุณฟังว่า worker ทำอะไร"
        text: >-
          model ของแม่อ่านรายงานแล้วเล่าให้คุณฟังด้วยคำของตัวเองว่าลูกแก้บรรทัดไหน และตรวจอย่างไร
        from: model
        to: engine
        sees: { kind: message, from: geno, text: "worker added a check script (tsc --noEmit) to package.json:7. It has not run it yet.", streaming: true }
      do: >-
        model ของแม่อ่านรายงานในรั้ว แล้วเล่าให้ผู้ใช้ฟังด้วยคำของตัวเองว่าลูกแก้ไฟล์ไหนและตรวจอย่างไร
        จบด้วย `stop_reason: end_turn`
      ref: "packages/engine/src/gateway.ts#\"stopReason: message.stop_reason,\""
      emits: [end_turn]

    - use: answer-streams
    - use: turn-ends
      beat:
        title: "Turn จบ"
        text: >-
          model ไม่ขอ tool เพิ่ม Geno จึงจบ turn ปุ่ม Send กลับมา และค่าใช้จ่ายท้าย turn รวมของลูกไว้ด้วย
        from: engine
        to: panel
        sees: { kind: composer, state: idle }
---

ลูกคือ session อีกตัวที่มี log ของตัวเอง loop ของตัวเอง และกล่องข้อความของตัวเอง
สิ่งที่ลูกใช้ร่วมกับแม่มีสามอย่าง: gateway (การเชื่อมต่อกับผู้ให้บริการ) งบของรอบ และทางขออนุญาตไปหาผู้ใช้

สิ่งที่ควรสังเกต

- **model เรียก `agent` ได้ก็ต่อเมื่อเปิดไว้** tool `agent` และ `message_agent` มีให้ model เฉพาะโหมดที่อยู่ใน `agentTool`
  ส่วน `@agent` ที่ผู้ใช้พิมพ์ ([เรียก subagent โดยตรง](/scenarios/sub/at-mention/)) ใช้ได้ทุกโหมด
- **ลูกสร้างลูกต่อไม่ได้** `agent` ไม่อยู่ในชุด tool ของลูก และ executor ของลูกไม่มีตัวสร้างลูก
- **รายงานเป็นข้อมูล** `childReport` ล้อมรั้ว เยื้องทุกบรรทัด และทำให้บรรทัดที่หน้าตาเหมือนโน้ตของ Geno ไม่มีผล
  ข้อความที่ลูกไปเจอในไฟล์หรือเว็บจึงปลอมเป็น Geno หรือผู้ใช้ไม่ได้
- **การ์ดไม่บอกชื่อลูก** engine ใส่ `[worker]` ไว้หน้าหัวข้อของ `session/request_permission` แต่ `permissionCard` ใช้หัวข้อ "Run this command?"
  ของตัวเอง ผู้ใช้จึงไม่รู้จากการ์ดว่าแม่หรือลูกตัวไหนเป็นคนขอ
- **ปฏิเสธลูกคือปฏิเสธแม่** Deny บนการ์ดของลูกจบทั้ง turn ของแม่ ส่วน "No, and tell the agent…" ส่งความเห็นไปให้ลูก และลูกทำต่อได้
- **ประกาศหลัง Deny ไม่ตรงกับเหตุ** ผล `rejected` ของ call `agent` ไม่มีบันทึกการอนุญาตติดมา แผงแชตจึงไม่ขึ้นป้าย
  "Denied by you" และ `missingReply` แสดง "Its last reply had no text." แทน "It stopped at the call that was denied."
- **ลูกที่จบโดยไม่เรียก `report`** ได้ข้อความเตือนหนึ่งครั้ง และการเรียกครั้งสุดท้ายที่เพดานยอมให้ถูกบังคับให้เป็น `report`
