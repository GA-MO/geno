---
title: MCP server ล่มหรือต้องล็อกอิน
description: โมเดลเรียกเครื่องมือ MCP แต่ server ตายซ้ำจน Geno เลิกเริ่มใหม่ หรือตอบ 401 เพราะต้องล็อกอิน call ได้ error โมเดลบอกผู้ใช้ และผู้ใช้แก้ได้จากแผง MCP
tableOfContents: false
sidebar:
  order: 9
scenario:
  surface: vscode
  given:
    - workspace ใช้ MCP server `linear` ที่ผู้ใช้อนุมัติแล้ว server พร้อมตอนเริ่ม run เครื่องมือของมันจึงอยู่ในชุดเครื่องมือของ run นี้
    - "โมเดลโหลด `mcp__linear__list_issues` ด้วย `tool_search` แล้ว และผู้ใช้อนุญาตเครื่องมือนี้ไว้ตลอด session"
  trigger: >-
    โมเดลเรียก `mcp__linear__list_issues` เพื่อดู issue ที่เปิดอยู่
  covers: [ext.mcp-server-down]
  related: [ext.mcp-tool-call, ext.mcp-server-untrusted, tool.deferred-tool-load]
  steps:
    - id: wants
      lane: model
      do: >-
        โมเดลขอเรียก `mcp__linear__list_issues` จบคำตอบด้วย `stop_reason: tool_use`
      ref: packages/core/src/mcp.ts#mcpToolName
      emits: [tool_use]
      phase: calling-model

    - use: tool-call-opens

    - id: call
      lane: tool
      at: executor
      do: >-
        hub ส่ง call ให้ `McpServerHandle.call` ซึ่งรอให้ server พร้อมก่อน (`ready()`) แล้วจึงเรียกเครื่องมือบน server
      ref: packages/engine/src/mcp/server.ts#McpServerHandle.call
      fork:
        ask: server เป็นอย่างไร
        options:
          - id: crashes
            label: process ของ server ตายซ้ำ
            steps:
              - lane: external
                do: >-
                  process stdio ของ server จบกลางทาง `onLost` บอก handle ว่าการเชื่อมต่อหาย handle ส่งเหตุการณ์ `crashed`
                  ให้ `nextServerState` ซึ่งเปลี่ยนสถานะจาก `ready` เป็น `starting` (ยังเริ่มใหม่ได้) หรือ `failed` (ครบแล้ว) ไม่มีสถานะชื่อ `crashed`
                ref: packages/core/src/mcp.ts#nextServerState
              - lane: server
                at: mcp
                do: >-
                  ถ้ายังเริ่มใหม่ไม่ครบ 3 ครั้ง handle รอ 0.5, 1 แล้ว 2 วินาทีก่อนต่อใหม่ (ไม่เกิน 8 วินาที) call ที่รออยู่รอการต่อนั้นด้วย
                  server ตายอีกเป็นครั้งที่สี่ สถานะกลายเป็น `failed` "crashed 4 times; last: ..." และไม่เริ่มใหม่เองอีก
                ref: packages/core/src/mcp.ts#restartDelayMs
              - lane: server
                at: mcp
                do: >-
                  call ได้ `ToolError` "the MCP server linear is failed: crashed 4 times; last: ..."
                ref: "packages/engine/src/mcp/server.ts#\"throw new ToolError(`the MCP server ${this.config.name} is ${describeServerState(this.#state)}`);\""
                emits: [ToolError]
              - use: tool-result-returns
              - use: model-call
              - lane: model
                do: >-
                  โมเดลอ่าน error แล้วบอกผู้ใช้ว่า server ของ Linear ล่ม และยังดู issue ให้ไม่ได้ จบด้วย `stop_reason: end_turn`
                ref: "packages/engine/src/gateway.ts#\"stopReason: message.stop_reason,\""
                emits: [end_turn]
              - lane: panel
                at: rail
                do: >-
                  แผง MCP servers แสดงสถานะของ server พร้อมเหตุผล
                sees: >-
                  แถว "linear" ป้าย "Failed" และเหตุผล "crashed 4 times; last: ..."
                ref: packages/extension/src/chat/mcp-panel.ts#serverRow
              - lane: loop
                at: drive
                do: >-
                  run ถัดไปของ session ได้ชุดเครื่องมือที่ไม่มีของ `linear` แล้ว ที่จุดปลอดภัย notice ของ MCP บอกโมเดลว่า server นี้ใช้ไม่ได้
                  พร้อม error ในรั้ว `<mcp_server_error server="linear">` และกฎว่าให้ถือเป็นของที่ใช้ไม่ได้ชั่วคราว ไม่ใช่สิ่งที่ไม่มี
                ref: packages/core/src/mcp-notice.ts#renderMcpDelta
                emits: [notice]
                end: { turn: done, reason: end_turn }

          - id: unauthorized
            label: server ตอบ 401
            steps:
              - lane: external
                do: >-
                  server HTTP ตอบ 401 เพราะ token หมดอายุ
                ref: packages/engine/src/mcp/connection.ts#isUnauthorized
              - lane: server
                at: mcp
                do: >-
                  handle ปิดการเชื่อมต่อ สถานะเป็น `failed` แบบ `needsSignIn` และ call ได้ `ToolError`
                  "the MCP server linear needs sign-in; ask the user to sign in to it in the editor's MCP servers view"
                ref: "packages/engine/src/mcp/server.ts#\"needs sign-in; ask the user to sign in to it in the editor's MCP servers view\""
                emits: [ToolError]
              - use: tool-result-returns
              - use: model-call
              - lane: model
                do: >-
                  โมเดลบอกผู้ใช้ให้ล็อกอิน Linear ในแผง MCP servers โมเดลล็อกอินแทนไม่ได้ จบด้วย `stop_reason: end_turn`
                ref: "packages/engine/src/gateway.ts#\"stopReason: message.stop_reason,\""
                emits: [end_turn]
              - lane: panel
                at: rail
                do: >-
                  แผง MCP servers แสดงแถวของ server พร้อมปุ่มล็อกอิน
                sees: >-
                  แถว "linear" ป้าย "Needs sign-in" บรรทัด "It needs you to sign in before Geno can use its tools." และปุ่ม [Sign in]
                ref: packages/extension/src/chat/mcp-panel.ts#signInRow
              - lane: user
                do: ผู้ใช้กด Sign in
              - lane: editor
                at: vscode-ui
                do: >-
                  `McpServers.signIn` เปิด browser ไปหน้า OAuth ของ server และแสดง progress ของ VS Code
                  token ที่ได้เก็บใน SecretStorage ของ VS Code ไม่ไปถึงโมเดล
                ref: packages/extension/src/chat/mcp-host.ts#McpServers.signIn
                emits: [Signing in to]
              - lane: editor
                at: chat
                do: >-
                  หลังล็อกอิน `reconnect` ส่ง `_gcode/mcpReconnect` ให้ engine ต่อ server ใหม่ คราวนี้ engine ขอ token จาก editor ผ่าน `_gcode/mcpToken`
                ref: packages/extension/src/chat/mcp-host.ts#McpServers.reconnect
                emits: [_gcode/mcpToken]
              - lane: panel
                at: rail
                do: แถวของ server กลับมาพร้อมใช้
                sees: แถว "linear" ป้ายพร้อมใช้ และปุ่ม Sign out
                ref: packages/extension/src/chat/mcp-panel.ts#serverRow
                end: { turn: done, reason: end_turn }
---

ความล้มเหลวของ MCP server ไม่ทำให้ turn ล้ม มันเป็น `ToolError` ธรรมดาที่โมเดลอ่านแล้วบอกผู้ใช้
สิ่งที่ Geno ใส่ใจคือให้โมเดลพูดถูก: server ใช้ไม่ได้ตอนนี้ ไม่ใช่ไม่มี และข้อความ error ของ server เป็นข้อมูล ไม่ใช่คำสั่ง

| เกิดอะไร | สถานะ | Geno ทำอะไร |
| --- | --- | --- |
| process ตายหลังพร้อมแล้ว | `starting` อีกครั้ง | ต่อใหม่เอง สูงสุด 3 ครั้ง |
| ตายครั้งที่สี่ | `failed` | เลิกเริ่มเอง ผู้ใช้เริ่มใหม่จากแผง MCP |
| ต่อไม่ติดตั้งแต่แรก | `failed` | ไม่ลองซ้ำเอง |
| 401 | `failed` แบบต้องล็อกอิน | รอผู้ใช้กด Sign in |

สิ่งที่ควรสังเกต

- **ชุดเครื่องมือคงที่ต่อ run** server ที่ล่มกลาง run ยังมีชื่อเครื่องมืออยู่ในชุดของ run นั้น call จึงได้ error แทนการหายไป
  ชุดใหม่ที่ไม่มีเครื่องมือของมันเริ่มใน run ถัดไป และ server ที่กลับมาพร้อมกลาง run ก็ได้ใช้ใน run ถัดไปเช่นกัน
- **token ไม่ผ่าน engine ไปถึงโมเดล** engine ขอ token จาก editor เฉพาะตอนต่อ server ที่ตอบ 401 และโมเดลรู้แค่ว่าต้องล็อกอิน
