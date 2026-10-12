---
title: เรียกเครื่องมือ MCP
description: โมเดลโหลดเครื่องมือ MCP ด้วย tool_search แล้วเรียกมัน ในโหมด Ask Geno ถามก่อน ผู้ใช้อนุญาตเครื่องมือนี้ตลอด session และ server ภายนอกทำงาน
tableOfContents: false
sidebar:
  order: 4
scenario:
  surface: vscode
  given:
    - ตั้ง MCP server ชื่อ `github` ไว้ใน `~/.g-code/mcp.json` server พร้อมทำงานตั้งแต่ต้นรอบ
    - ข้อความแจ้งของ Geno บอกโมเดลแล้วว่ามีเครื่องมือ `mcp__github__create_issue` แต่บอกแค่ชื่อ
    - เปิด Geno ในโหมด Ask
  trigger: >-
    ผู้ใช้ขอว่า "เปิด issue เรื่อง login ช้าใน repo acme/app ให้หน่อย"
  covers: [ext.mcp-tool-call]
  related: [ext.mcp-server-untrusted, ext.mcp-server-down, perm.ask-allow, ctx.large-output-spill]
  steps:
    - id: search
      lane: model
      do: >-
        เครื่องมือ MCP ไม่อยู่ในรายการเครื่องมือของคำขอ (อยู่ข้างหลัง `tool_search` เสมอ เพื่อไม่ให้ cache หลุดเมื่อ server มาหรือไป)
        โมเดลจึงขอเรียก `tool_search` ด้วย `select: ["mcp__github__create_issue"]`
      ref: packages/core/src/deferred-tools.ts#toolSearchDefinition
      emits: [tool_use, tool_search]
      phase: calling-model

    - id: loaded
      lane: tool
      at: executor
      do: >-
        `searchTools` คืนนิยามเต็มของเครื่องมือพร้อม `input_schema` ผลของ call บันทึกชื่อที่โหลดแล้ว
        เครื่องมือนี้เรียกได้ตลอด session ถ้าเรียกก่อนโหลด จะได้ error ที่บอกให้โหลดก่อน
      ref: packages/core/src/deferred-tools.ts#searchTools
      emits: [Loaded]
      phase: running-tools

    - use: tool-result-returns
    - use: model-call

    - id: wants
      lane: model
      do: >-
        โมเดลขอเรียก `mcp__github__create_issue` ด้วย owner, repo, title และ body จบคำตอบด้วย `stop_reason: tool_use`
      ref: "packages/engine/src/gateway.ts#\"stopReason: message.stop_reason,\""
      emits: [tool_use]

    - use: tool-call-opens

    - id: judge
      lane: policy
      at: rules
      do: >-
        executor ของเครื่องมือ MCP ถาม `mcpCallDenial`: กฎ MCP ของ workspace มาก่อน (ไม่มี) แล้วจึงกฎของโหมด
        เครื่องมือนี้ไม่ได้บอกว่าอ่านอย่างเดียว จึงเป็น `mcp-tool` ซึ่งโหมด Ask ต้องถาม และแนบชื่อกฎไว้ให้บันทึกได้
      ref: packages/core/src/permission-rules.ts#mcpCallDenial
      emits: [mcp-tool]

    - id: settle
      lane: policy
      at: settle
      do: >-
        `settle` ไม่ปฏิเสธเองและไม่ใช่โหมด Auto จึงส่งคำถามให้ผู้ใช้
      ref: packages/engine/src/tools/agent.ts#settle

    - id: ask
      lane: server
      at: approvals
      do: >-
        `editorTurn.approve` ส่งคำขอ ACP `session/request_permission` ตัวเลือกมาจาก `choicesFor` ซึ่งสำหรับเครื่องมือ MCP
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
      lane: panel
      at: card
      do: แผงแชตแสดงการ์ดขออนุญาต `subject` ของคำขอบอก server และเครื่องมือ การ์ดจึงใช้หัวข้อแบบเครื่องมือ MCP
      sees: >-
        "Use github tool create_issue?" ชื่อเครื่องมือ และ "Geno asks about an MCP tool."
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
                at: settle
                do: >-
                  `permissionAnswerOf` ได้ `allow-session` `settle` บันทึกว่าผู้ใช้อนุญาต แล้ว `keepMcpAnswer` เพิ่มชื่อเครื่องมือ
                  ลงชุด `allowed` ของ session call ถัดไปของเครื่องมือนี้ไม่ถาม จนกว่า session จะปิด
                ref: packages/engine/src/mcp/browser.ts#keepMcpAnswer
                phase: running-tools

          - id: workspace
            label: Always allow in this workspace
            then: call
            steps:
              - lane: policy
                at: rules
                do: >-
                  `keepMcpAnswer` เพิ่มชื่อเครื่องมือลงชุดของ session และบันทึกกฎ allow ของเครื่องมือ MCP นี้ลงที่เก็บของ workspace
                  session ต่อๆ ไปก็ไม่ถาม แต่กฎ allow ไม่ชนะโหมด Plan ซึ่งยังปฏิเสธเครื่องมือที่ไม่ได้อ่านอย่างเดียว
                ref: packages/engine/src/mcp/browser.ts#keepMcpAnswer
                emits: [allow-workspace]
                phase: running-tools

    - id: call
      lane: external
      do: >-
        hub ส่ง `tools/call` ไปที่ process ของ server `github` server รันนอก sandbox ของ Geno และใช้ token ของมันเอง
        แล้วตอบด้วย URL ของ issue ใหม่
      ref: "packages/engine/src/mcp/hub.ts#\"const result = await handle.call(info.tool, args, ctx.signal);\""

    - id: result
      lane: tool
      at: executor
      do: >-
        `mcpResultText` แปลงผลเป็นข้อความ (รูปภาพเก็บเป็นไฟล์แนบ) ถ้า server ตอบว่า `isError` ผลเป็น error ให้โมเดลอ่าน
        ผลที่ยาวเกินถูกเก็บลงไฟล์พร้อมคำแนะนำให้ใช้ filter หรือหน้าของ server แทน
        call นี้ผ่านการถาม ผลจึงแนบบันทึกว่าผู้ใช้อนุญาต update ปิดของมันมี `APPROVAL_META`
        (call ถัดไปที่อนุญาตไว้ตลอด session ไม่ถาม จึงไม่มีบันทึกนี้)
      ref: packages/core/src/mcp.ts#mcpResultText

    - use: tool-result-returns
      
    - id: next
      lane: loop
      at: step
      do: >-
        `loopStep` ตัดสิน `call-model` โมเดลบอกผู้ใช้ว่าเปิด issue แล้วพร้อมลิงก์
      ref: packages/core/src/loop.ts#loopStep
      emits: [call-model]
      phase: calling-model
      end: { turn: continues, reason: call-model }
---

เครื่องมือ MCP ใช้ทางของเครื่องมือทั่วไปทุกอย่าง: PreToolUse hook การจัดชุด การ์ด และผลใน log
ต่างกันสามจุด คือต้องโหลดก่อนด้วย `tool_search` ตัดสินด้วยกฎ MCP และงานจริงเกิดใน process ของ server

| โหมด | เครื่องมืออ่านอย่างเดียว | เครื่องมืออื่น |
| --- | --- | --- |
| Ask | ถาม | ถาม |
| Auto | รัน | classifier ตัดสิน |
| Plan | รัน | ปฏิเสธ |

สิ่งที่ควรสังเกต

- **ชุดเครื่องมือเป็นภาพนิ่งของรอบ** `runAgent` เอาเครื่องมือของ server ที่พร้อมตอนเริ่มรอบเท่านั้น server ที่พร้อมกลางรอบได้ใช้ในรอบถัดไป
- **"อ่านอย่างเดียว" มาจาก server** server เป็นคนบอกว่าเครื่องมือไหนอ่านอย่างเดียว Geno ใช้คำบอกนั้นตัดสินว่าจะถามไหม
- **"Allow this tool for the session" อยู่ในหน่วยความจำ** ชุด `allowed` อยู่ใน hub ของ session ไม่ได้บันทึกลงไฟล์
- **ข้อความจาก server เป็นข้อมูล** คำแนะนำที่ server ส่งมาถูกล้อมใน `<mcp_instructions>` และบอกโมเดลว่าไม่ได้มาจากผู้ใช้
