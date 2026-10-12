---
title: "เรียก tool ของ MCP"
description: model โหลด tool MCP ด้วย tool_search แล้วเรียกมัน ในโหมด Ask Geno ถามก่อน ผู้ใช้อนุญาต tool นี้ตลอด session และ server ภายนอกทำงาน
scenario:
  surface: vscode
  given:
    - ตั้ง MCP server ชื่อ `github` ไว้ใน `~/.g-code/mcp.json` server พร้อมทำงานตั้งแต่ต้นรอบ
    - ข้อความแจ้งของ Geno บอก model แล้วว่ามี tool `mcp__github__create_issue` แต่บอกแค่ชื่อ
    - เปิด Geno ในโหมด Ask
  trigger: >-
    ผู้ใช้ขอว่า "เปิด issue เรื่อง login ช้าใน repo acme/app ให้หน่อย"
  covers: [ext.mcp-tool-call]
  related: [ext.mcp-server-untrusted, ext.mcp-server-down, perm.ask-allow, ctx.large-output-spill]
  steps:
    - id: search
      beat:
        title: Model โหลด tool ของ MCP ก่อน
        text: tool ของ MCP อยู่หลัง `tool_search` เสมอ เพื่อไม่ให้ cache หลุดเมื่อ server มาหรือไป การ์ดเป็นคำขอจริงจากการรันในแผงของ VS Code ที่โหลด tool echo ของ server ทดสอบ
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
        title: Geno ส่งนิยามเต็มของ tool กลับไป
        text: ผลมีนิยามพร้อม input schema tool นี้เรียกได้ตลอด session ถ้าเรียกก่อนโหลด จะได้ error ที่บอกให้โหลดก่อน
        from: engine
        to: model
        sees:
          kind: payload
          source: docs/results/real-usecases/runs/B08-mcp-banner/1/session-e4c82936-19b2-44b3-a830-e99ae0a865c0.jsonl#seq=5
          highlight: [output]
      lane: tool
      at: executor
      do: >-
        `searchTools` คืนนิยามเต็มของ tool พร้อม `input_schema` ผลของ call บันทึกชื่อที่โหลดแล้ว
        tool นี้เรียกได้ตลอด session ถ้าเรียกก่อนโหลด จะได้ error ที่บอกให้โหลดก่อน
      ref: packages/core/src/deferred-tools.ts#searchTools
      emits: [Loaded]
      phase: running-tools

    - use: tool-result-returns
    - use: model-call

    - id: wants
      beat:
        title: Model ขอเปิด issue ใน acme/app
        text: model เรียก `mcp__github__create_issue` พร้อม owner repo title และ body แชตขึ้นขั้นของ call การ์ดเป็น call จริงของ tool echo ในการรันเดียวกัน
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
        title: Geno หยุด turn แล้วถามคุณ
        text: ไม่มีกฎ MCP ของ workspace ครอบ tool นี้ และมันไม่ได้บอกว่าอ่านอย่างเดียว โหมด Ask จึงต้องถาม การ์ดของ tool MCP มีปุ่มอนุญาตตลอด session เพิ่มมา
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
        text: การ์ดบอก server และชื่อ tool คุณจะให้ Geno เปิด issue อีกหลายรายการใน session นี้
        from: panel
        to: you
        sees: { kind: permission, face: mcp, server: github, tool: create_issue, command: 'mcp__github__create_issue {"owner":"acme","repo":"app","title":"Login is slow"}', reason: Geno asks about an MCP tool. }
        ask: คุณกดปุ่มไหน
      lane: panel
      at: card
      do: แผงแชตแสดงการ์ดขออนุญาต `subject` ของคำขอบอก server และ tool การ์ดจึงใช้หัวข้อแบบ tool MCP
      sees: >-
        "Use github tool create_issue?" ชื่อ tool และ "Geno asks about an MCP tool."
        [Allow] [Allow this tool for the session] [Deny] [Always allow in this workspace] [No, and tell the agent…]
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
        text: server รันนอก sandbox ของ Geno และใช้ token ของมันเอง มันตอบด้วย URL ของ issue ใหม่
        from: engine
        to: machine
      lane: external
      do: >-
        hub ส่ง `tools/call` ไปที่ process ของ server `github` server รันนอก sandbox ของ Geno และใช้ token ของมันเอง
        แล้วตอบด้วย URL ของ issue ใหม่
      ref: "packages/engine/src/mcp/hub.ts#\"const result = await handle.call(info.tool, args, ctx.signal);\""

    - id: result
      beat:
        title: Geno ส่งผลให้ model
        text: Geno แปลงผลเป็นข้อความ ผลที่ยาวเกินถูกเก็บลงไฟล์ การ์ดเป็นผลจริงของ tool echo
        from: engine
        to: model
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
        text: Geno ส่งผลของ tool กลับให้ model ซึ่งจะบอกคุณว่าเปิด issue แล้วพร้อมลิงก์
        from: engine
        to: model
        end: Model ตอบพร้อมลิงก์
      lane: loop
      at: step
      do: >-
        `loopStep` ตัดสิน `call-model` model บอกผู้ใช้ว่าเปิด issue แล้วพร้อมลิงก์
      ref: packages/core/src/loop.ts#loopStep
      emits: [call-model]
      phase: calling-model
      end: { turn: continues, reason: call-model }
---

tool MCP ใช้ทางของ tool ทั่วไปทุกอย่าง: PreToolUse hook การจัดชุด การ์ด และผลใน log
ต่างกันสามจุด คือต้องโหลดก่อนด้วย `tool_search` ตัดสินด้วยกฎ MCP และงานจริงเกิดใน process ของ server

| โหมด | tool อ่านอย่างเดียว | tool อื่น |
| --- | --- | --- |
| Ask | ถาม | ถาม |
| Auto | รัน | classifier ตัดสิน |
| Plan | รัน | ปฏิเสธ |

สิ่งที่ควรสังเกต

- **ชุด tool เป็นภาพนิ่งของรอบ** `runAgent` เอา tool ของ server ที่พร้อมตอนเริ่มรอบเท่านั้น server ที่พร้อมกลางรอบได้ใช้ในรอบถัดไป
- **"อ่านอย่างเดียว" มาจาก server** server เป็นคนบอกว่า tool ไหนอ่านอย่างเดียว Geno ใช้คำบอกนั้นตัดสินว่าจะถามไหม
- **"Allow this tool for the session" อยู่ในหน่วยความจำ** ชุด `allowed` อยู่ใน hub ของ session ไม่ได้บันทึกลงไฟล์
- **ข้อความจาก server เป็นข้อมูล** คำแนะนำที่ server ส่งมาถูกล้อมใน `<mcp_instructions>` และบอก model ว่าไม่ได้มาจากผู้ใช้
