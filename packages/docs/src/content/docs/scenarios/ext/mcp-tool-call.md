---
title: "เรียก tool ของ MCP"
description: model โหลด tool MCP ด้วย tool_search แล้วเรียกมัน ในโหมด Ask Geno ถามก่อน ผู้ใช้อนุญาต tool นี้ตลอด session และ server ภายนอกทำงาน
scenario:
  surface: vscode
  given:
    - ตั้ง MCP server ชื่อ `github` ไว้ใน `~/.g-code/mcp.json` server พร้อมทำงานตั้งแต่ต้น turn
    - ข้อความแจ้งของ Geno บอก model แล้วว่ามี tool `mcp__github__create_issue` แต่บอกแค่ชื่อพร้อมคำอธิบายสั้นหนึ่งบรรทัด ไม่มี `input_schema`
    - เปิด Geno ในโหมด Ask
  trigger: >-
    ผู้ใช้ขอว่า "เปิด issue เรื่อง login ช้าใน repo acme/app ให้หน่อย"
  covers: [ext.mcp-tool-call]
  related: [ext.mcp-server-untrusted, ext.mcp-server-down, perm.ask-allow, ctx.large-output-spill]
  steps:
    - id: search
      beat:
        title: Model โหลด tool ของ MCP ก่อน
        text: MCP server คือโปรแกรมภายนอกที่เสนอ tool ให้ model รายการ `tools` ในคำขอไม่มี tool ของ MCP Geno บอกแค่ชื่อพร้อมคำอธิบายสั้นหนึ่งบรรทัดในข้อความแจ้งระหว่างบทสนทนา ไม่มี `input_schema` (รูปของ argument) model ต้องเรียก `tool_search` เพื่อโหลดคำอธิบายเต็มก่อน เหตุผลคือ prompt cache ผู้ให้บริการจำส่วนต้นของคำขอไว้ ถ้ารายการ `tools` เปลี่ยนทุกครั้งที่ server มาหรือไป ส่วนต้นจะเปลี่ยนและ cache ใช้ไม่ได้ การ์ดเป็น call จริงของ model จากการรันในแผงของ VS Code ที่ model ค้นด้วย `query` แทนการระบุชื่อ เพื่อหา tool echo ของ server ทดสอบ การ์ดจากการรันจริงในหน้านี้ใช้ server ทดสอบชื่อ `wsfake`
        from: model
        to: engine
        sees:
          kind: payload
          source: docs/results/real-usecases/runs/B08-mcp-banner/1/session-e4c82936-19b2-44b3-a830-e99ae0a865c0.jsonl#seq=4
          select: content[1]
      lane: model
      do: >-
        tool MCP ไม่อยู่ในรายการ tool ของคำขอ (อยู่ข้างหลัง `tool_search` เสมอ เพื่อไม่ให้ cache หลุดเมื่อ server มาหรือไป)
        model จึงขอเรียก `tool_search` ด้วย `select: ["mcp__github__create_issue"]`
      ref: packages/core/src/deferred-tools.ts#toolSearchDefinition
      emits: [tool_use, tool_search]
      phase: calling-model

    - id: loaded
      beat:
        title: Geno เตรียมนิยามเต็มของ tool ให้ model
        text: Geno เขียนข้อความผลไว้ใน log ผลนี้ถึง model ตอนเรียกครั้งถัดไป ระหว่างนี้ model ไม่ได้ตอบอะไร ในการ์ด `loaded` คือชื่อ tool ที่โหลดแล้ว (คำค้นในการรันนี้ได้มาห้าตัว) และ `output` คือข้อความที่ model จะอ่าน มีนิยามพร้อม `input_schema` ของแต่ละตัว tool ที่โหลดแล้วเรียกได้ตลอด session ถ้า model เรียกโดยไม่โหลดก่อน Geno ยังรัน call ให้เมื่อ argument ตรงกับ schema และแนบนิยามเต็มไปกับผล ถ้าไม่ตรง call ไม่รัน และ model ได้ error ที่แสดงนิยามให้เรียกใหม่
        from: engine
        to: engine
        sees:
          kind: payload
          source: docs/results/real-usecases/runs/B08-mcp-banner/1/session-e4c82936-19b2-44b3-a830-e99ae0a865c0.jsonl#seq=5
          quote: "\"input_schema\":{\"type\":\"object\",\"properties\":{\"text\":{\"type\":\"string\"}}"
          highlight: [output]
      lane: tool
      at: executor
      do: >-
        `searchTools` คืนนิยามเต็มของ tool พร้อม `input_schema` ผลของ call บันทึกชื่อที่โหลดแล้ว
        tool นี้เรียกได้ตลอด session ถ้า model เรียกโดยไม่โหลดก่อน Geno ยังรัน call ให้เมื่อ argument ตรงกับ schema และแนบนิยามเต็มไปกับผล ถ้าไม่ตรง call ไม่รัน และ model ได้ error ที่แสดงนิยามให้เรียกใหม่
      ref: packages/core/src/deferred-tools.ts#searchTools
      emits: [Loaded]
      phase: running-tools

    - use: tool-result-returns
    - use: model-call

    - id: wants
      beat:
        title: Model ขอเปิด issue ใน acme/app
        text: model เรียก `mcp__github__create_issue` พร้อม owner repo title และ body แชตขึ้นขั้นของ call การ์ดเป็น call จริงของ tool echo ในการรันเดียวกัน ดู `name` ที่ขึ้นต้นด้วย `mcp__` ตามด้วยชื่อ server และ `input` ที่ตรงกับ schema ที่เพิ่งโหลด
        from: model
        to: engine
        sees:
          kind: payload
          source: docs/results/real-usecases/runs/B08-mcp-banner/1/session-e4c82936-19b2-44b3-a830-e99ae0a865c0.jsonl#seq=7
          select: content[1]
      lane: model
      do: >-
        model ขอเรียก `mcp__github__create_issue` ด้วย owner, repo, title และ body จบคำตอบด้วย `stop_reason: tool_use`
      ref: "packages/engine/src/gateway.ts#\"stopReason: message.stop_reason,\""
      emits: [tool_use]

    - use: tool-call-opens

    - id: judge
      lane: policy
      at: rules
      do: >-
        executor ของ tool MCP ถาม `mcpCallDenial`: กฎ MCP ของ workspace มาก่อน (ไม่มี) แล้วจึงกฎของโหมด
        tool นี้ไม่ได้บอกว่าอ่านอย่างเดียว จึงเป็น `mcp-tool` ซึ่งโหมด Ask ต้องถาม และแนบชื่อกฎไว้ให้บันทึกได้
      ref: packages/core/src/permission-rules.ts#mcpCallDenial
      emits: [mcp-tool]

    - id: settle
      beat:
        title: Geno พัก turn แล้วถามคุณ
        text: ไม่มีกฎ MCP ของ workspace ครอบ tool นี้ และมันไม่ได้บอกว่าอ่านอย่างเดียว โหมด Ask (โหมดที่ถามคุณก่อนทำสิ่งที่เสี่ยง) จึงต้องถาม turn รอคำตอบของคุณ การ์ดของ tool MCP มีปุ่มอนุญาตตลอด session เพิ่มมา
        from: engine
        to: panel
      lane: policy
      at: settle
      do: >-
        `settle` ไม่ปฏิเสธเองและไม่ใช่โหมด Auto จึงส่งคำถามให้ผู้ใช้
      ref: packages/engine/src/tools/agent.ts#settle

    - id: ask
      lane: server
      at: approvals
      do: >-
        `editorTurn.approve` ส่งคำขอ ACP `session/request_permission` ตัวเลือกมาจาก `choicesFor` ซึ่งสำหรับ tool MCP
        มีปุ่ม "Allow this tool for the session" เพิ่ม
      ref: packages/engine/src/serve.ts#editorTurn.approve
      emits: [requestPermission, allow-session]
      phase: waiting-user

    - id: forward
      lane: editor
      at: chat
      do: >-
        `askPermission` ส่ง action `permission` ให้ webview และโฟกัสแผงแชต
      ref: packages/extension/src/chat/chat.ts#Chat.askPermission
      emits: [permission]

    - id: card
      beat:
        title: คุณเห็นการ์ด “Use github tool create_issue?”
        text: การ์ดบอก server ชื่อ tool และ argument ที่ server จะได้ คุณจะให้ Geno เปิด issue อีกหลายรายการใน session นี้
        from: panel
        to: you
        sees:
          kind: permission
          face: mcp
          server: github
          tool: create_issue
          command: |-
            {
              "owner": "acme",
              "repo": "app",
              "title": "Login is slow",
              "body": "Login takes several seconds after the last release."
            }
          reason: Geno asks about a tool of an MCP server, which runs outside the sandbox.
          rule: mcp__github__create_issue
        ask: คุณกดปุ่มไหน
      lane: panel
      at: card
      do: >-
        แผงแชตแสดงการ์ดขออนุญาต `subject` ของคำขอบอก server, tool และ argument เป็น JSON ที่จัดย่อหน้าแล้ว
        การ์ดจึงใช้หัวข้อแบบ tool MCP และแสดง argument แทนชื่อ tool ที่ model เห็น (call ที่ไม่มี argument ขึ้นว่า "No arguments")
      sees: >-
        "Use github tool create_issue?" argument ของ call, "Geno asks about a tool of an MCP server, which runs outside the sandbox."
        และบรรทัด "Always allow saves the rule `mcp__github__create_issue` for this workspace."
        ปุ่ม [Allow] [Allow this tool for the session] [Deny] [Always allow in this workspace] และ [No, and tell the agent…] แบบปุ่มจาง
      ref: packages/extension/src/chat/render.ts#permissionCard

    - id: choose
      lane: user
      do: ผู้ใช้จะให้ Geno เปิด issue อีกหลายรายการใน session นี้
      fork:
        ask: ผู้ใช้กดปุ่มไหน
        options:
          - id: session
            label: Allow this tool for the session
            then: call
            steps:
              - lane: policy
                beat:
                  title: คุณอนุญาต tool นี้ตลอด session
                  text: Geno จำชื่อ tool ไว้ใน session นี้ call ถัดไปของ tool นี้ไม่ถามอีก
                  from: you
                  to: panel
                at: settle
                do: >-
                  `permissionAnswerOf` ได้ `allow-session` `settle` คืนบันทึกว่าผู้ใช้อนุญาต แล้ว `keepMcpAnswer` เพิ่มชื่อ tool
                  ลงชุด `allowed` ของ session call ถัดไปของ tool นี้ไม่ถาม จนกว่า session จะปิด
                ref: packages/engine/src/mcp/browser.ts#keepMcpAnswer
                phase: running-tools

          - id: workspace
            label: Always allow in this workspace
            then: call
            steps:
              - lane: policy
                beat:
                  title: คุณอนุญาตใน workspace นี้เสมอ
                  text: Geno จำใน session และบันทึกกฎ allow ของ tool นี้ลงที่เก็บของ workspace session ต่อๆ ไปก็ไม่ถาม แต่กฎ allow ไม่ชนะโหมด Plan
                  from: you
                  to: panel
                at: rules
                do: >-
                  `keepMcpAnswer` เพิ่มชื่อ tool ลงชุดของ session และบันทึกกฎ allow ของ tool MCP นี้ลงที่เก็บของ workspace
                  session ต่อๆ ไปก็ไม่ถาม แต่กฎ allow ไม่ชนะโหมด Plan ซึ่งยังปฏิเสธ tool ที่ไม่ได้อ่านอย่างเดียว
                ref: packages/engine/src/mcp/browser.ts#keepMcpAnswer
                emits: [allow-workspace]
                phase: running-tools

    - id: call
      beat:
        title: server github เปิด issue
        text: Geno ส่ง call ไปที่ process ของ server server รันนอก sandbox ของ Geno (กรอบที่จำกัดคำสั่งของ model) และใช้ token ของมันเอง มันตอบด้วย URL ของ issue ใหม่
        from: engine
        to: machine
      lane: external
      do: >-
        hub ส่ง `tools/call` ไปที่ process ของ server `github` server รันนอก sandbox ของ Geno และใช้ token ของมันเอง
        แล้วตอบด้วย URL ของ issue ใหม่
      ref: "packages/engine/src/mcp/hub.ts#\"const result = await handle.call(info.tool, args, ctx.signal);\""

    - id: result
      beat:
        title: Geno เตรียมผลให้ model
        text: Geno แปลงผลเป็นข้อความแล้วเขียนไว้ใน log ผลนี้ถึง model ตอนเรียกครั้งถัดไป ผลที่ยาวเกินถูกเก็บลงไฟล์ การ์ดเป็นผลจริงของ tool echo ดู `output` ซึ่งเป็นข้อความที่ model จะได้ และ `approval` ซึ่งบันทึกว่าคุณเป็นคนอนุญาต (`decidedBy` เป็น `user`) ในการรันนี้ echo เป็น tool ที่ server บอกว่าอ่านอย่างเดียว แต่โหมด Ask ก็ยังถาม
        from: engine
        to: engine
        sees:
          kind: payload
          source: docs/results/real-usecases/runs/B08-mcp-banner/1/session-e4c82936-19b2-44b3-a830-e99ae0a865c0.jsonl#seq=8
          highlight: [output]
      lane: tool
      at: executor
      do: >-
        `mcpResultText` แปลงผลเป็นข้อความ (รูปภาพเก็บเป็นไฟล์แนบ) ถ้า server ตอบว่า `isError` ผลเป็น error ให้ model อ่าน
        ผลที่ยาวเกินถูกเก็บลงไฟล์พร้อมคำแนะนำให้ใช้ filter หรือหน้าของ server แทน
        call นี้ผ่านการถาม ผลจึงแนบบันทึกว่าผู้ใช้อนุญาต update ปิดของมันมี `APPROVAL_META`
        (call ถัดไปที่อนุญาตไว้ตลอด session ไม่ถาม จึงไม่มีบันทึกนี้)
      ref: packages/core/src/mcp.ts#mcpResultText

    - use: tool-result-returns
      
    - id: next
      beat:
        title: Geno เรียก model อีกครั้งพร้อมผลของ tool
        text: >-
          Geno ส่งบทสนทนาทั้งหมดไปให้ model อีกครั้งในคำขอใหม่ ท้ายคำขอคือ call ของ model และผลของ tool ที่ Geno เตรียมไว้
          การ์ดเป็นการบันทึกที่รัน Geno จริงกับ model จำลองที่ตอบตามบทที่เขียนไว้ก่อน กับ MCP server ทดสอบชื่อ `fake` ที่ editor ส่งมาตอนเปิด session แท็บแรกคือ call `mcp__fake__echo` ของ model
          แท็บสองคือผลที่ model จะอ่าน `echo: Login is slow` ข้อความที่ server ตอบมาเป็นข้อความธรรมดาใน `tool_result`
        from: engine
        to: model
        sees:
          - kind: payload
            source: packages/docs/src/data/recorded/ext-mcp-tool-call.jsonl#line=7
            select: messages[3].content
            highlight: ['[1].name', '[1].input']
          - kind: payload
            source: packages/docs/src/data/recorded/ext-mcp-tool-call.jsonl#line=7
            select: messages[4].content[0]
            highlight: [content]
      lane: loop
      at: step
      do: >-
        `loopStep` ตัดสิน `call-model` แล้ว Geno ส่งคำขอที่มีผลของ tool อยู่ท้ายสุด
      ref: packages/core/src/loop.ts#loopStep
      emits: [call-model]
      phase: calling-model

    - id: reply
      beat:
        title: Model ตอบพร้อมลิงก์
        text: model ตอบหลังได้คำขอนี้เท่านั้น มันบอกคุณว่าเปิด issue แล้วพร้อมลิงก์ และไม่ขอ tool อีก การ์ดเป็นคำตอบจริงจากการรันเดียวกับการ์ด call (server `wsfake` input `สวัสดี`) ไม่ใช่การบันทึกของการ์ดก่อนหน้า บล็อก `text` คือคำตอบที่ model เล่าผลของ tool echo และไม่มีบล็อก `tool_use` turn จึงจบ
        from: model
        to: engine
        sees:
          kind: payload
          source: docs/results/real-usecases/runs/B08-mcp-banner/1/session-e4c82936-19b2-44b3-a830-e99ae0a865c0.jsonl#seq=10
          select: content
          collapse: ['[0].thinking']
          highlight: ['[1].text']
        end: Model ตอบพร้อมลิงก์
      lane: model
      do: >-
        model อ่าน `tool_result` ของ `mcp__github__create_issue` แล้วตอบเป็นข้อความ จบคำตอบด้วย `stop_reason: end_turn`
      ref: "packages/engine/src/gateway.ts#\"stopReason: message.stop_reason,\""
      emits: [end_turn]
      end: { turn: done, reason: end_turn }
---

tool [MCP](/start/glossary/) ใช้ทางของ tool ทั่วไปทุกอย่าง: PreToolUse [hook](/start/glossary/) การจัดชุด call ที่รันพร้อมกันได้ (batch) การ์ด และผลใน log
ต่างกันสามจุด คือปกติโหลดก่อนด้วย `tool_search` ตัดสินด้วยกฎ MCP และงานจริงเกิดใน process ของ server

| โหมด | tool อ่านอย่างเดียว | tool อื่น |
| --- | --- | --- |
| Ask | ถาม | ถาม |
| Auto | รัน | classifier ตัดสิน |
| Plan | รัน | ปฏิเสธ |

สิ่งที่ควรสังเกต

- **ชุด tool เป็นภาพนิ่งของ turn** `runAgent` เอา tool ของ server ที่พร้อมตอนเริ่ม turn เท่านั้น server ที่พร้อมกลาง turn ได้ใช้ใน turn ถัดไป
- **"อ่านอย่างเดียว" มาจาก server** server เป็นคนบอกว่า tool ไหนอ่านอย่างเดียว ซึ่ง Geno ตรวจไม่ได้ โหมด Ask จึงยังถาม
  การ์ดบอกเหตุผลว่า "a tool its MCP server calls read-only, which Geno cannot check" ส่วน Auto และ Plan รัน tool นั้นโดยไม่ถาม
- **"Allow this tool for the session" อยู่ในหน่วยความจำ** ชุด `allowed` อยู่ใน hub ของ session ไม่ได้บันทึกลงไฟล์
- **ข้อความจาก server เป็นข้อมูล** คำแนะนำที่ server ส่งมาถูกล้อมใน `<mcp_instructions>` และบอก model ว่าไม่ได้มาจากผู้ใช้
