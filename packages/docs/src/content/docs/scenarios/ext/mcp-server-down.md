---
title: MCP server ล่มหรือต้องล็อกอิน
description: model เรียก tool MCP แต่ server ตายซ้ำจน Geno เลิกเริ่มใหม่ หรือตอบ 401 เพราะต้องล็อกอิน call ได้ error model บอกผู้ใช้ และผู้ใช้แก้ได้จากแผง MCP
scenario:
  surface: vscode
  given:
    - workspace ใช้ MCP server `linear` ที่ผู้ใช้อนุมัติแล้ว server พร้อมตอนเริ่ม turn tool ของมันจึงอยู่ในชุด tool ของ turn นี้
    - "model โหลด `mcp__linear__list_issues` ด้วย `tool_search` แล้ว และผู้ใช้อนุญาต tool นี้ไว้ตลอด session"
  trigger: >-
    model เรียก `mcp__linear__list_issues` เพื่อดู issue ที่เปิดอยู่
  covers: [ext.mcp-server-down]
  related: [ext.mcp-tool-call, ext.mcp-server-untrusted, tool.deferred-tool-load]
  steps:
    - id: wants
      beat:
        title: Model เรียก tool ของ Linear
        text: MCP server คือโปรแกรมภายนอกที่เสนอ tool ให้ model ผ่านโปรโตคอล MCP Geno เป็นคนเรียกมันแทน model ก่อนหน้านี้ model โหลดคำอธิบายเต็มของ `mcp__linear__list_issues` ด้วย `tool_search` ไว้แล้ว ตอนนี้มันขอดู issue ที่เปิดอยู่ แชตขึ้นขั้นของ call นี้ การ์ดข้างล่างเป็นคำตอบจริงจากการรันหนึ่งที่ model เรียก tool ของ MCP server ทดสอบ `wsfake` แบบเดียวกัน ดู `name` ในบล็อก `tool_use` ซึ่งขึ้นต้นด้วย `mcp__` ตามด้วยชื่อ server และ `input` คือ argument ที่ส่งให้ server
        from: model
        to: engine
        sees:
          kind: payload
          source: docs/results/real-usecases/runs/B08-mcp-banner/1/session-e4c82936-19b2-44b3-a830-e99ae0a865c0.jsonl#seq=7
          select: content
          collapse: ['[0].thinking']
          highlight: ['[1].name', '[1].input']
      lane: model
      do: >-
        model ขอเรียก `mcp__linear__list_issues` จบคำตอบด้วย `stop_reason: tool_use`
      ref: packages/core/src/mcp.ts#mcpToolName
      emits: [tool_use]
      phase: calling-model

    - use: tool-call-opens

    - id: call
      beat:
        title: Geno รอให้ server พร้อมแล้วส่ง call
        text: Geno ส่ง call ให้ server `linear` ถ้า server ยังไม่พร้อม call รอก่อน
        from: engine
        to: machine
        ask: server เป็นอย่างไร
      lane: tool
      at: executor
      do: >-
        hub ส่ง call ให้ `McpServerHandle.call` ซึ่งรอให้ server พร้อมก่อน (`ready()`) แล้วจึงเรียก tool บน server
      ref: packages/engine/src/mcp/server.ts#McpServerHandle.call
      fork:
        ask: server เป็นอย่างไร
        options:
          - id: crashes
            label: process ของ server ตาย (server แบบ stdio ที่ Geno รันเป็น process)
            steps:
              - lane: external
                beat:
                  title: process ของ server ตายระหว่าง call
                  text: 'ในทางนี้ `linear` เป็น server แบบ stdio คือโปรแกรมที่ Geno รันเป็น process บนเครื่อง process นั้นจบกลางทางขณะ call นี้ยังรอคำตอบ call จึงได้ error ทันที "the MCP server linear failed the call: MCP error -32000: Connection closed" Geno ไม่ส่ง call นี้ซ้ำ ปกติ Geno เริ่ม server ใหม่เองเบื้องหลัง ได้สูงสุดสามครั้งต่อ session'
                  from: machine
                  to: engine
                do: >-
                  process stdio ของ server จบกลางทาง `onLost` บอก handle ว่าการเชื่อมต่อหาย handle ส่งเหตุการณ์ `crashed`
                  ให้ `nextServerState` ซึ่งเปลี่ยนสถานะจาก `ready` เป็น `starting` (ยังเริ่มใหม่ได้) หรือ `failed` (ครบแล้ว) ไม่มีสถานะชื่อ `crashed`
                  ส่วน MCP SDK ตีกลับทุกคำขอที่ค้างบนการเชื่อมต่อนั้นด้วย error "Connection closed"
                ref: packages/core/src/mcp.ts#nextServerState
              - lane: server
                beat:
                  title: server ตายครั้งที่สี่ Geno เลิกเริ่มใหม่
                  text: 'Geno รอ 0.5, 1 แล้ว 2 วินาทีก่อนเริ่มใหม่แต่ละครั้ง สมมติว่าใน session นี้ server ตายและ Geno เริ่มใหม่มาแล้วสามครั้ง การตายครั้งนี้จึงเป็นครั้งที่สี่ Geno ตั้งว่า server ล้มและเลิกเริ่มใหม่ call ของ `linear` ที่มาหลังจากนี้ได้ error "the MCP server linear is failed: crashed 4 times; last: ..." ทันทีโดยไม่รอ ส่วน call นี้ได้ error "failed the call" ไปแล้ว Geno เขียน error นั้นเป็นผลของ call ผลนี้ถึง model ตอน Geno เรียก model ครั้งถัดไป turn ไม่ล้ม'
                  from: engine
                  to: engine
                at: mcp
                do: >-
                  ถ้ายังเริ่มใหม่ไม่ครบ 3 ครั้ง handle รอ 0.5, 1 แล้ว 2 วินาทีก่อนต่อใหม่ (ไม่เกิน 8 วินาที) call ใหม่ที่มาระหว่างนั้นรอการต่อนั้น (`ready()`)
                  server ตายอีกเป็นครั้งที่สี่ สถานะกลายเป็น `failed` "crashed 4 times; last: ..." และไม่เริ่มใหม่เองอีก
                  call ที่มาหลังจากนั้นได้ `ToolError` "the MCP server linear is failed: crashed 4 times; last: ..." ทันที
                ref: packages/core/src/mcp.ts#restartDelayMs
              - lane: server
                at: mcp
                do: >-
                  call ที่ค้างอยู่ได้ `ToolError` "the MCP server linear failed the call: MCP error -32000: Connection closed"
                ref: "packages/engine/src/mcp/server.ts#\"throw new ToolError(`the MCP server ${this.config.name} failed the call: ${error instanceof Error ? error.message : String(error)}`);\""
                emits: [ToolError]
              - use: tool-result-returns
              - use: model-call
              - lane: model
                beat:
                  title: Model บอกคุณว่า Linear ล่ม
                  text: >-
                    model อ่าน error แล้วบอกว่ายังดู issue ให้ไม่ได้
                    การ์ดเป็นการบันทึกที่รัน Geno จริงกับ model จำลองที่ตอบตามบทที่เขียนไว้ก่อน กับ MCP server ทดสอบชื่อ `fake` ซึ่งมี tool `crash` ที่สั่งให้ process ของ server จบทันที
                    การบันทึกเห็นการตายครั้งแรกเท่านั้น ไม่ใช่ครั้งที่สี่ แท็บแรกคือผลที่ model อ่าน ดู `content` และ `is_error: true`
                    แท็บสองคือ event ท้าย stream ของคำตอบ model ตอบเป็นข้อความว่า server หยุดกลางทาง แล้วจบด้วย `end_turn`
                  from: model
                  to: engine
                  sees:
                    - kind: payload
                      source: packages/docs/src/data/recorded/ext-mcp-server-down.jsonl#line=7
                      select: messages[4].content[0]
                      highlight: [content, is_error]
                    - kind: payload
                      source: packages/docs/src/data/recorded/ext-mcp-server-down.jsonl#line=8
                      select: '[-2]'
                      highlight: [data.delta.stop_reason]
                do: >-
                  model อ่าน error แล้วบอกผู้ใช้ว่า server ของ Linear ล่ม และยังดู issue ให้ไม่ได้ จบด้วย `stop_reason: end_turn`
                ref: "packages/engine/src/gateway.ts#\"stopReason: message.stop_reason,\""
                emits: [end_turn]
              - lane: panel
                beat:
                  title: แผง MCP บอกว่า server ล้ม
                  text: แผง MCP servers ใน VS Code แสดงสถานะพร้อมเหตุผล turn ถัดไปไม่มี tool ของ `linear` และ Geno บอก model ว่า server นี้ใช้ไม่ได้ชั่วคราว
                  from: panel
                  to: you
                  sees: 'แถว "linear" ป้าย "Failed" และเหตุผล "crashed 4 times; last: ..."'
                  end: server นี้ใช้ไม่ได้
                at: rail
                do: >-
                  แผง MCP servers แสดงสถานะของ server พร้อมเหตุผล
                sees: >-
                  แถว "linear" ป้าย "Failed" และเหตุผล "crashed 4 times; last: ..."
                ref: packages/extension/src/chat/mcp-panel.ts#serverRow
              - lane: loop
                at: drive
                do: >-
                  turn ถัดไปของ session ได้ชุด tool ที่ไม่มีของ `linear` แล้ว ที่จุดปลอดภัย notice ของ MCP บอก model ว่า server นี้ใช้ไม่ได้
                  พร้อม error ในรั้ว `<mcp_server_error server="linear">` และกฎว่าให้ถือเป็นของที่ใช้ไม่ได้ชั่วคราว ไม่ใช่สิ่งที่ไม่มี
                ref: packages/core/src/mcp-notice.ts#renderMcpDelta
                emits: [notice]
                end: { turn: done, reason: end_turn }

          - id: unauthorized
            label: server ตอบ 401 (server แบบ HTTP)
            steps:
              - lane: external
                beat:
                  title: server ตอบ 401
                  text: server แบบ HTTP ตอบ 401 เพราะ token ที่ใช้ล็อกอินหมดอายุ
                  from: machine
                  to: engine
                do: >-
                  server HTTP ตอบ 401 เพราะ token หมดอายุ
                ref: packages/engine/src/mcp/connection.ts#isUnauthorized
              - lane: server
                beat:
                  title: Geno บอกว่าต้องล็อกอิน
                  text: Geno ปิดการเชื่อมต่อ ตั้งว่า server ต้องล็อกอิน แล้ว call ได้ error ที่บอกให้ขอคุณล็อกอินในแผง MCP servers error นี้เป็นผลของ call และถึง model ตอน Geno เรียก model ครั้งถัดไป
                  from: engine
                  to: engine
                at: mcp
                do: >-
                  handle ปิดการเชื่อมต่อ สถานะเป็น `failed` แบบ `needsSignIn` และ call ได้ `ToolError`
                  "the MCP server linear needs sign-in; ask the user to sign in to it in the editor's MCP servers view"
                ref: "packages/engine/src/mcp/server.ts#\"needs sign-in; ask the user to sign in to it in the editor's MCP servers view\""
                emits: [ToolError]
              - use: tool-result-returns
              - use: model-call
              - lane: model
                beat:
                  title: Model ขอให้คุณล็อกอิน
                  text: >-
                    model ล็อกอินแทนคุณไม่ได้ มันบอกให้คุณล็อกอิน Linear ในแผง MCP servers
                    การ์ดเป็นการบันทึกที่รัน Geno จริงกับ model จำลองที่ตอบตามบทที่เขียนไว้ก่อน กับ MCP server ทดสอบชื่อ `fake` แบบ HTTP
                    ที่ต่อและบอกรายชื่อ tool ได้ตามปกติ แต่ตอบ 401 ทุกครั้งที่มีการเรียก tool เหมือน token ที่หมดอายุ
                    แท็บแรกคือผลที่ model อ่าน ดู `content` ที่บอกให้ขอคุณล็อกอิน แท็บสองคือ event ท้าย stream ของคำตอบ model ตอบเป็นข้อความแล้วจบด้วย `end_turn`
                  from: model
                  to: engine
                  sees:
                    - kind: payload
                      source: packages/docs/src/data/recorded/ext-mcp-server-signin.jsonl#line=7
                      select: messages[4].content[0]
                      highlight: [content, is_error]
                    - kind: payload
                      source: packages/docs/src/data/recorded/ext-mcp-server-signin.jsonl#line=8
                      select: '[-2]'
                      highlight: [data.delta.stop_reason]
                do: >-
                  model บอกผู้ใช้ให้ล็อกอิน Linear ในแผง MCP servers model ล็อกอินแทนไม่ได้ จบด้วย `stop_reason: end_turn`
                ref: "packages/engine/src/gateway.ts#\"stopReason: message.stop_reason,\""
                emits: [end_turn]
              - lane: panel
                beat:
                  title: แผง MCP มีปุ่ม Sign in
                  text: แถวของ server บอกว่าต้องล็อกอินก่อน Geno จึงจะใช้ tool ของมันได้
                  from: panel
                  to: you
                  sees: แถว "linear" ป้าย "Needs sign-in" บรรทัด "It needs you to sign in before Geno can use its tools." และปุ่ม [Sign in]
                at: rail
                do: >-
                  แผง MCP servers แสดงแถวของ server พร้อมปุ่มล็อกอิน
                sees: >-
                  แถว "linear" ป้าย "Needs sign-in" บรรทัด "It needs you to sign in before Geno can use its tools." และปุ่ม [Sign in]
                ref: packages/extension/src/chat/mcp-panel.ts#signInRow
              - lane: user
                beat:
                  title: คุณกด Sign in
                  text: VS Code เปิด browser ไปหน้า OAuth ของ server (หน้าล็อกอินของผู้ให้บริการ) token ที่ได้เก็บใน SecretStorage (ที่เก็บรหัสลับของ VS Code) ไม่ไปถึง model
                  from: you
                  to: panel
                do: ผู้ใช้กด Sign in
              - lane: editor
                at: vscode-ui
                do: >-
                  `McpServers.signIn` เปิด browser ไปหน้า OAuth ของ server และแสดง progress ของ VS Code
                  token ที่ได้เก็บใน SecretStorage ของ VS Code ไม่ไปถึง model
                ref: packages/extension/src/chat/mcp-host.ts#McpServers.signIn
                emits: [Signing in to]
              - lane: editor
                beat:
                  title: Geno ต่อ server ใหม่ด้วย token
                  text: หลังล็อกอิน แชตขอให้ engine ต่อ server ใหม่ engine ขอ token จาก VS Code แถวของ server กลับมาพร้อมใช้
                  from: engine
                  to: machine
                  sees: แถว "linear" ป้ายพร้อมใช้ และปุ่ม Sign out
                  end: server กลับมาพร้อมใช้
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

ความล้มเหลวของ [MCP](/start/glossary/) server ไม่ทำให้ turn ล้ม มันเป็น `ToolError` ธรรมดาที่ model อ่านแล้วบอกผู้ใช้
สิ่งที่ Geno ใส่ใจคือให้ model พูดถูก: server ใช้ไม่ได้ตอนนี้ ไม่ใช่ไม่มี และข้อความ error ของ server เป็นข้อมูล ไม่ใช่คำสั่ง

| เกิดอะไร | สถานะ | Geno ทำอะไร |
| --- | --- | --- |
| process ตายหลังพร้อมแล้ว | `starting` อีกครั้ง | call ที่ค้างอยู่ได้ error ทันที แล้วต่อใหม่เองเบื้องหลัง สูงสุด 3 ครั้ง |
| ตายครั้งที่สี่ | `failed` | เลิกเริ่มเอง call ต่อจากนี้ได้ error ทันที ผู้ใช้ปิดแล้วเปิดสวิตช์ของ server ในแผง MCP เพื่อเริ่มใหม่ |
| ต่อไม่ติดตั้งแต่แรก | `failed` | ไม่ลองซ้ำเอง |
| 401 | `failed` แบบต้องล็อกอิน | รอผู้ใช้กด Sign in |

สิ่งที่ควรสังเกต

- **ชุด tool คงที่ต่อ turn** Geno เลือกชุด tool ตอนเริ่ม turn server ที่ล่มกลาง turn ยังมีชื่อ tool อยู่ในชุดของ turn นั้น call จึงได้ error แทนการหายไป
  ชุดใหม่ที่ไม่มี tool ของมันเริ่มใน turn ถัดไป และ server ที่กลับมาพร้อมกลาง turn ก็ได้ใช้ใน turn ถัดไปเช่นกัน
- **token ไม่ผ่าน engine ไปถึง model** engine ขอ token จาก editor เฉพาะตอนต่อ server ที่ตอบ 401 และ model รู้แค่ว่าต้องล็อกอิน
