---
title: อนุมัติ MCP server ของโปรเจกต์
description: repo มี .mcp.json ที่กำหนด server ไว้ Geno ไม่รัน server นั้นจนกว่าผู้ใช้จะดูคำนิยามแล้วกด Allow และถามใหม่ถ้าคำนิยามเปลี่ยน
tableOfContents: false
sidebar:
  order: 5
scenario:
  surface: vscode
  given:
    - repo ที่เพิ่ง clone มามีไฟล์ `.mcp.json` กำหนด server `db` แบบ stdio ที่รัน `npx db-mcp --url $DATABASE_URL`
    - ผู้ใช้ยังไม่เคยอนุมัติ server นี้ใน workspace นี้
  trigger: >-
    ผู้ใช้เปิดแชตใหม่ของ Geno ใน workspace นี้
  covers: [ext.mcp-server-untrusted]
  related: [ext.mcp-tool-call, ext.mcp-server-down, hook.project-untrusted]
  steps:
    - id: register
      beat:
        title: Geno อ่านคำนิยาม server ทุกแหล่ง
        text: คุณเปิดแชตใหม่ใน repo ที่เพิ่ง clone มา server ที่มาจาก `.mcp.json` ของ repo ต้องได้รับอนุมัติก่อนรัน เพราะคนเขียน repo เป็นคนเลือกมัน
        from: engine
        to: engine
      lane: server
      at: turns
      do: >-
        เมื่อ session เปิด `McpSessions.register` อ่านคำนิยาม server ทุกแหล่ง server จาก `.mcp.json` `.vscode/mcp.json` และ plugin
        ต้องได้รับอนุมัติก่อน (`MCP_SOURCE_TRUST`) ส่วน server ใน `~/.g-code/mcp.json` ของผู้ใช้เองรันได้เลย
      ref: packages/core/src/mcp.ts#MCP_SOURCE_TRUST
      emits: [needs-approval]
      phase: idle

    - id: untrusted
      beat:
        title: server `db` ยังไม่ได้รับอนุมัติ
        text: ไม่มีการอนุมัติที่ตรงกับคำนิยามนี้ใน workspace นี้ Geno จึงไม่เริ่ม process ของมัน และ model ไม่ได้ tool ของมัน
        from: engine
        to: engine
      lane: policy
      at: rules
      do: >-
        ไฟล์อนุมัติ `mcp-trust.json` ไม่มีรายการของ `db` ใน workspace นี้ที่ hash ตรงกับคำนิยาม server จึงอยู่ในสถานะ `untrusted`
        ไม่มี process ถูกเริ่ม และ tool ของมันไม่ถูกเสนอให้ model
      ref: packages/engine/src/mcp/trust.ts#approveServer
      emits: [untrusted]

    - id: listed
      lane: editor
      at: chat
      do: >-
        `McpServers.refresh` ขอรายชื่อ server ด้วย `_gcode/mcpServers` แล้วส่งให้ webview
      ref: packages/extension/src/chat/mcp-host.ts#McpServers.refresh
      emits: [_gcode/mcpServers]

    - id: notice
      beat:
        title: แชตขึ้นแถบรออนุมัติ
        text: เหนือบทสนทนาขึ้นแถบพร้อมไอคอนโล่ แชตยังใช้ได้ตามปกติ แค่ไม่มี tool ของ `db`
        from: panel
        to: you
        sees:
          kind: notice
          text: 1 MCP server in this workspace waits for your approval.
          actions:
            - Review
      lane: panel
      at: rail
      do: >-
        เหนือบทสนทนาขึ้นแถบประกาศพร้อมไอคอนโล่ แชตยังใช้ได้ตามปกติ แค่ไม่มี tool ของ `db`
      sees: >-
        "1 MCP server in this workspace waits for your approval." [Review]
      ref: packages/extension/src/chat/mcp-panel.ts#mcpPanel

    - id: review
      beat:
        title: คุณกด Review
        text: แผง MCP servers มาแทนบทสนทนา
        from: you
        to: panel
      lane: user
      do: ผู้ใช้กด Review

    - id: card
      beat:
        title: คุณเห็นการ์ด “Allow this server to run?”
        text: การ์ดแสดงคำนิยามทั้งหมด คำสั่ง อาร์กิวเมนต์ ตัวแปรสภาพแวดล้อม และบอกว่าใครเป็นคนเลือก server นี้
        from: panel
        to: you
        sees: { kind: permission, face: server, command: npx db-mcp --url $DATABASE_URL, reason: ".mcp.json in this workspace defines it, so whoever wrote the repository chose it. Geno runs this command outside the sandbox, with network access, whenever a chat in this workspace starts. A changed definition asks again." }
        ask: คุณกดปุ่มไหน
      lane: panel
      at: card
      do: >-
        แผง MCP servers แทนที่บทสนทนา แถวของ `db` มีการ์ดที่แสดงคำนิยามทั้งหมด (คำสั่ง อาร์กิวเมนต์ ตัวแปรสภาพแวดล้อม)
        และบอกว่าใครเป็นคนเลือก server นี้
      sees: >-
        "Allow this server to run?" พร้อมคำสั่ง `npx db-mcp --url $DATABASE_URL` และเหตุผล
        ".mcp.json in this workspace defines it, so whoever wrote the repository chose it. Geno runs this command outside
        the sandbox, with network access, whenever a chat in this workspace starts. A changed definition asks again." [Allow] [Turn off]
      ref: packages/extension/src/chat/mcp-panel.ts#trustCard
      phase: waiting-user

    - id: decide
      lane: user
      do: ผู้ใช้อ่านคำนิยามแล้วตัดสินใจ
      fork:
        ask: ผู้ใช้กดปุ่มไหน
        options:
          - id: allow
            label: Allow
            steps:
              - lane: editor
                beat:
                  title: คุณกด Allow
                  text: การ์ดส่งคำนิยามที่คุณเห็นไปด้วย Geno จึงรู้ว่าคุณอนุมัติฉบับไหน
                  from: you
                  to: panel
                at: chat
                do: >-
                  การ์ดโพสต์ `mcp-trust` พร้อม hash ของคำนิยามที่ผู้ใช้เห็น `McpServers` ส่งคำขอ `_gcode/mcpTrust`
                ref: packages/extension/src/chat/mcp-host.ts#McpServers.handlers
                emits: [mcp-trust, _gcode/mcpTrust]
              - lane: policy
                beat:
                  title: Geno ตรวจว่าคำนิยามไม่เปลี่ยน
                  text: ถ้าไฟล์เปลี่ยนหลังคุณเห็น Geno ปฏิเสธ คำนิยามตรง Geno จึงบันทึกการอนุมัติ
                  from: engine
                  to: engine
                at: rules
                do: >-
                  `hub.trust` เทียบ hash กับคำนิยามตอนนี้ ถ้าไฟล์เปลี่ยนหลังผู้ใช้เห็น จะปฏิเสธว่า "the definition of db changed since it was shown"
                  hash ตรง จึงบันทึกการอนุมัติ (workspace ชื่อ และ hash) ลง `mcp-trust.json` แล้วเปลี่ยนสถานะเป็นพร้อมเริ่ม
                ref: packages/engine/src/mcp/trust.ts#approveServer
              - lane: external
                beat:
                  title: server `db` เริ่มทำงาน
                  text: engine เริ่ม process ของ `db` นอก sandbox ของ Geno server ตอบรายชื่อ tool
                  from: engine
                  to: machine
                do: >-
                  engine เริ่ม process ของ `db` (นอก sandbox ของ Geno) server ตอบรายชื่อ tool
                ref: packages/engine/src/mcp/hub.ts#openMcpHub
              - lane: panel
                beat:
                  title: แถวของ db พร้อมใช้
                  text: แถบประกาศหายไป turn ถัดไปของ agent ได้ tool ของ `db` และ Geno บอก model ชื่อ tool ที่มาใหม่
                  from: panel
                  to: you
                  sees: แถว "db · .mcp.json" สถานะพร้อม พร้อมรายชื่อ tool เช่น "query, list_tables"
                  end: tool ของ db พร้อมใช้
                at: rail
                do: >-
                  แถวของ `db` เปลี่ยนเป็นพร้อมใช้และแสดงชื่อ tool แถบประกาศหายไป
                  รอบถัดไปของเอเจนต์จะได้ tool เหล่านี้ และข้อความแจ้งบอก model ชื่อ tool ที่มาใหม่
                sees: แถว "db · .mcp.json" สถานะพร้อม พร้อมรายชื่อ tool เช่น "query, list_tables"
                ref: packages/extension/src/chat/mcp-panel.ts#serverRow
                phase: idle
                end: { turn: none }

          - id: off
            label: Turn off
            steps:
              - lane: editor
                beat:
                  title: คุณกด Turn off
                  text: Geno จดว่า `db` ปิดไว้ใน workspace นี้ ไม่มีการอนุมัติเกิดขึ้น
                  from: you
                  to: panel
                at: chat
                do: >-
                  การ์ดโพสต์ `mcp-enable` ค่า false `McpServers.setEnabled` ส่งคำขอ `_gcode/mcpEnable`
                ref: packages/extension/src/chat/mcp-host.ts#McpServers.setEnabled
                emits: [mcp-enable]
              - lane: server
                at: turns
                do: >-
                  engine บันทึกชื่อ `db` ลงรายการ server ที่ปิดไว้ของ workspace นี้ (`mcp-disabled.json`) ไม่มีการอนุมัติเกิดขึ้น
                ref: packages/engine/src/mcp/trust.ts#setDisabled
              - lane: panel
                beat:
                  title: แถวของ db ปิดอยู่
                  text: แถบประกาศหายไป และ Geno ไม่ถามเรื่อง server นี้อีกจนกว่าคุณจะเปิดสวิตช์เอง
                  from: panel
                  to: you
                  sees: แถว "db" ที่สวิตช์ปิดอยู่
                  end: server นี้ปิดไว้
                at: rail
                do: แถวของ `db` เป็นปิด แถบประกาศหายไป และ server นี้ไม่ถูกถามอีกจนกว่าผู้ใช้จะเปิดสวิตช์เอง
                sees: แถว "db" ที่สวิตช์ปิดอยู่
                ref: packages/extension/src/chat/mcp-panel.ts#serverRow
                phase: idle
                end: { turn: none }
---

repo ที่ clone มาคือโค้ดของคนอื่น server ที่กำหนดไว้ใน repo จึงเป็นคำสั่งที่คนเขียน repo เลือก Geno ไม่รันมันจนกว่าผู้ใช้จะเห็นคำนิยามเต็มและอนุมัติ

สิ่งที่ควรสังเกต

- **การอนุมัติผูกกับคำนิยาม** hash ของคำนิยามอยู่ในไฟล์อนุมัติ ถ้า `git pull` แก้คำสั่งของ server สถานะกลับเป็นรออนุมัติ
- **ปุ่ม Allow ผูกกับสิ่งที่ผู้ใช้เห็น** การ์ดส่ง hash ของคำนิยามที่แสดงอยู่ ถ้าไฟล์เปลี่ยนระหว่างนั้น engine ไม่อนุมัติ
- **อนุมัติด้วย CLI ได้** `gcode mcp trust` เขียนไฟล์เดียวกัน hub เห็นการอนุมัติเมื่อจะใช้ server ครั้งถัดไป
- **ไม่ใช่ workspace trust ของ VS Code** การอนุมัติ server แยกจากการเชื่อถือ workspace ที่ควบคุม hook ของโปรเจกต์
