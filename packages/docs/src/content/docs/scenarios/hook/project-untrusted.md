---
title: "hook ของโปรเจกต์ไม่รันใน workspace ที่ไม่เชื่อถือ"
description: repo มี hook ใน .claude/settings.json แต่ VS Code ยังไม่เชื่อถือ workspace hook ของผู้ใช้เองรัน ส่วน hook ของ repo รอจนกว่าจะเชื่อถือ
scenario:
  surface: vscode
  given:
    - เปิดโฟลเดอร์ที่ clone มาใหม่ ในเรื่องหลัก VS Code ยังไม่เชื่อถือ workspace นี้ (`vscode.workspace.isTrusted` เป็น false)
    - "`.claude/settings.json` ของ repo มี UserPromptSubmit hook ที่รัน `./scripts/hook.sh`"
    - "`~/.claude/settings.json` ของผู้ใช้มี UserPromptSubmit hook ของตัวเองที่รัน `~/bin/log-prompt.sh`"
    - หน้าต่างนี้ยังไม่ได้ต่อ engine
  trigger: >-
    ผู้ใช้ส่ง prompt แรกในแชตใหม่
  covers: [hook.project-untrusted]
  related: [hook.user-prompt-submit, ext.mcp-server-untrusted, start.open-window]
  steps:
    - id: settings
      beat:
        title: VS Code บอก Geno ว่าเชื่อถือ workspace หรือไม่
        text: trust คือการที่คุณบอก VS Code ว่าเชื่อโค้ดในโฟลเดอร์นี้ ตอนต่อ engine (process เบื้องหลังที่รัน agent ของ Geno) ครั้งแรก ส่วนขยายส่งสถานะ trust ของ workspace ไปด้วย ในเรื่องหลักโฟลเดอร์ที่เพิ่ง clone มายังไม่ถูกเชื่อถือ engine จำค่านี้ไว้กับการเชื่อมต่อนี้ ทุก turn จากหน้าต่างนี้ใช้มัน
        from: panel
        to: engine
      lane: editor
      at: engine-link
      do: >-
        `engineSettings` อ่าน `vscode.workspace.isTrusted` ตอนต่อ engine ครั้งแรก
        แล้วส่งคำขอ ACP `initialize` ที่บอกสถานะ trust ไว้ใน `_meta` ใต้คีย์ `gcode/workspaceTrusted` (ในเรื่องหลักเป็น false)
      ref: "packages/extension/src/chat/engine.ts#\"await agent.request(acp.methods.agent.initialize, {\""
      emits: [initialize, gcode/workspaceTrusted]
      phase: idle

    - id: peer
      lane: server
      at: sessions
      do: >-
        engine จดสถานะนี้ไว้ใน `peer.trusted` ของการเชื่อมต่อนี้ ทุก turn ที่หน้าต่างนี้เริ่มใช้ค่านี้
      ref: "packages/engine/src/serve.ts#\"trusted: _meta?.[WORKSPACE_TRUST_CAPABILITY] === true,\""

    - id: type
      beat:
        title: คุณส่ง prompt แรก
        text: คุณพิมพ์คำถามในแชตใหม่แล้วกด Enter แชตส่ง prompt ไปที่ engine
        from: you
        to: panel
      lane: user
      do: ผู้ใช้พิมพ์คำถามแล้วกด Enter

    - id: request
      lane: editor
      at: engine-link
      do: >-
        `prompt()` ส่ง action `turn-start` ให้แผงแชต แล้วส่งคำขอ ACP `session/prompt`
      ref: packages/extension/src/chat/chat.ts#Chat.prompt
      emits: [turn-start, session/prompt]

    - id: run
      beat:
        title: Geno เริ่ม turn พร้อมสถานะ trust
        text: engine ส่งสถานะ trust ของการเชื่อมต่อนี้ไปให้ turn ใช้ตัดสินว่าอะไรรันได้
        from: engine
        to: engine
      lane: server
      at: turns
      do: >-
        `runTurn` รับ prompt แล้วเรียก `runAgent` พร้อม `trustedWorkspace: from.peer.trusted`
      ref: "packages/engine/src/serve.ts#\"trustedWorkspace: from.peer.trusted,\""
      phase: starting

    - id: open
      beat:
        title: Geno อ่าน hook จากทุกที่
        text: hook คือคำสั่ง shell ที่ตั้งไว้ใน settings ให้ Geno รันเมื่อเกิดเหตุการณ์หนึ่ง session นี้เปิดครั้งแรกใน engine ตัวนี้ Geno จึงอ่านการตั้งค่า hook ทั้งหมด ทั้งของคุณ ของ plugin (ชุดส่วนเสริมที่คุณติดตั้ง) และของ repo แล้วจำชุดนี้ไว้ตลอดที่ engine ยังรัน
        from: engine
        to: engine
      lane: loop
      at: agent
      do: >-
        `runAgent` เปิด hook ของ session ด้วย `hooks.open` session นี้เปิดครั้งแรกใน engine ตัวนี้
        จึงอ่านการตั้งค่า hook ทั้งหมด: ของผู้ใช้ ของ plugin และของ workspace
      ref: packages/engine/src/hooks.ts#HookSessions.open

    - id: filter
      beat:
        title: Geno คัด hook ที่รันได้
        text: hook ของคุณเองรันเสมอ hook ที่มาจากไฟล์ของ repo รันได้เฉพาะเมื่อเชื่อถือ workspace การตั้งค่าอื่นของ repo ที่ขยายสิทธิ์ ได้แก่กฎที่อนุญาตคำสั่ง และโฟลเดอร์นอก workspace ที่ repo ขอให้เข้าถึงได้ ก็รอแบบเดียวกัน
        from: engine
        to: engine
        ask: เชื่อถือ repo ไหม
      lane: policy
      at: hooks
      do: >-
        `runnableEntries` คัด hook ที่รันได้: hook ของผู้ใช้รันเสมอ hook ที่มาจากไฟล์ของ workspace รันเฉพาะเมื่อเชื่อถือ
        การตั้งค่าอื่นของ repo ที่รอ trust เช่นกฎ allow และ `additionalDirectories` ก็ถูกพักแบบเดียวกัน
      ref: packages/engine/src/hook-config.ts#runnableEntries
      fork:
        ask: VS Code เชื่อถือ workspace นี้ไหม
        options:
          - id: untrusted
            label: ไม่เชื่อถือ
            then: record

          - id: trusted
            label: เชื่อถือแล้ว
            steps:
              - lane: policy
                beat:
                  title: ทั้งสอง hook รัน
                  text: สมมติว่าคุณกดเชื่อถือโฟลเดอร์นี้ก่อนเปิดแชต ส่วนขยายจึงส่งสถานะ trust เป็น true hook ของ repo รันใน sandbox ซึ่งเป็นกรอบของระบบปฏิบัติการ มันเขียนได้แค่ใน workspace กับโฟลเดอร์ชั่วคราวของ session และต่อเครือข่ายได้ตามกฎของ sandbox ส่วน hook ของคุณรันตรงๆ ทั้งสองตัวได้อ่าน prompt ก่อน model
                  from: engine
                  to: machine
                at: hooks
                do: >-
                  hook ทั้งสองตัวรันได้ `hookRunner` ห่อคำสั่งของ hook จาก repo ด้วย `sandbox.wrap`
                  hook ของ repo จึงเขียนได้แค่ใน workspace กับ scratchpad ของ session และใช้เครือข่ายตามกฎของ sandbox
                  hook ของผู้ใช้รันตรงๆ ในฐานะผู้ใช้
                ref: packages/engine/src/hooks.ts#hookRunner
              - lane: loop
                at: drive
                do: >-
                  `drive` บันทึก event `user` แล้ว UserPromptSubmit ของทั้งสองตัวได้อ่าน prompt ก่อน model
                ref: packages/engine/src/drive.ts#submitted
                emits: [user, UserPromptSubmit]
              - lane: loop
                beat:
                  title: Turn เดินต่อตามปกติ
                  text: ไม่มี hook บล็อก Geno ส่ง prompt ให้ model
                  from: engine
                  to: panel
                  end: Model ได้ prompt
                at: step
                do: >-
                  ไม่มี hook บล็อก `loopStep` ตัดสิน `call-model` turn เดินต่อตามปกติ
                ref: packages/core/src/loop.ts#loopStep
                emits: [call-model]
                phase: calling-model
                end: { turn: continues, reason: call-model }

    - id: record
      beat:
        title: เฉพาะ hook ของคุณที่รัน
        text: Geno บันทึก prompt แล้วรัน hook UserPromptSubmit ซึ่งเป็น hook ที่ได้อ่าน prompt ก่อน model มีแค่ `~/bin/log-prompt.sh` ของคุณที่รัน `./scripts/hook.sh` ของ repo ไม่รัน และไม่มีอะไรบอก model หรือแชตว่ามันถูกข้าม turn เดินต่อตามปกติ
        from: engine
        to: machine
      lane: loop
      at: drive
      do: >-
        `drive` บันทึก event `user` แล้ว `submitted()` รัน UserPromptSubmit เฉพาะของผู้ใช้ `~/bin/log-prompt.sh`
        `./scripts/hook.sh` ของ repo ไม่รัน และไม่มีอะไรบอก model หรือแผงแชตว่ามันถูกข้าม
      ref: packages/engine/src/drive.ts#submitted
      emits: [user, UserPromptSubmit]

    - id: decide
      lane: loop
      at: step
      do: >-
        `loopStep` ตัดสิน `call-model` turn เดินต่อตามปกติ
      ref: packages/core/src/loop.ts#loopStep
      emits: [call-model]
      phase: calling-model

    - id: look
      beat:
        title: คุณเปิด Settings ดูหัวข้อ Hooks
        text: ระหว่าง turn ทำงาน คุณเปิด Settings ในแผงแชตแล้วเลื่อนไปที่ Hooks แชตถาม engine ว่ามี hook อะไรบ้างและแต่ละตัวรันได้ไหม
        from: you
        to: panel
      lane: user
      do: >-
        ระหว่างนั้นผู้ใช้เปิด Settings ในแผงแชตแล้วเลื่อนไปที่หัวข้อ Hooks
      alongside: true

    - id: list
      lane: editor
      at: chat
      do: >-
        `HooksHost` ส่งคำขอ `_gcode/hooks` พร้อมโฟลเดอร์ engine อ่านการตั้งค่าใหม่และตอบด้วย `hookRows`
        ซึ่งให้สถานะ `untrusted` กับ hook ของ workspace ตาม `peer.trusted` ของการเชื่อมต่อนี้
      ref: packages/extension/src/chat/hooks-host.ts#HooksHost
      emits: [_gcode/hooks, untrusted]

    - id: shown
      beat:
        title: Settings บอกว่า hook ของ repo รอ trust
        text: ทุก hook ขึ้นพร้อมที่มาและสถานะ hook ของ repo มีป้ายว่าต้องเชื่อถือ workspace ก่อน ถ้าคุณกดเชื่อถือทีหลัง engine ตัวเดิมยังจำค่าเดิมของการเชื่อมต่อและชุด hook ของ session นี้ไว้ hook ของ repo อาจยังไม่รันจนกว่า engine จะเริ่มใหม่ ดูหมายเหตุท้ายหน้า
        from: panel
        to: you
        sees: แถว "UserPromptSubmit" `./scripts/hook.sh` ป้าย "Needs a trusted workspace" และแถวของ `~/bin/log-prompt.sh` ที่รันได้
        end: hook ของ repo ไม่รัน
      lane: panel
      at: settings
      do: >-
        หัวข้อ Hooks แสดงทุก hook ที่พบพร้อมที่มาและสถานะ
      sees: >-
        แถว "UserPromptSubmit" `./scripts/hook.sh` "From .../.claude/settings.json" ป้าย "Needs a trusted workspace"
        และแถวของ `~/bin/log-prompt.sh` ป้ายว่ารัน
      ref: packages/extension/src/chat/hooks-panel.ts#hooksSection
      end: { turn: continues, reason: call-model }
---

trust ของ VS Code (Workspace Trust) คือเส้นแบ่งระหว่างการตั้งค่าที่ผู้ใช้เขียนเองกับการตั้งค่าที่มากับ repo
[hook](/start/glossary/) ของ repo เป็นคำสั่ง shell ที่คนอื่นเขียน Geno จึงไม่รันมันจนกว่าผู้ใช้จะบอก VS Code ว่าเชื่อถือโฟลเดอร์นี้
และเมื่อรัน ก็รันใน [sandbox](/start/glossary/) เหมือนคำสั่งของ model
คำว่า [engine](/start/glossary/) [session](/start/glossary/) [turn](/start/glossary/) และ [ACP](/start/glossary/) ในขั้นข้างบนมีคำอธิบายในคำศัพท์

| ที่มาของ hook | workspace ไม่เชื่อถือ | workspace เชื่อถือ |
| --- | --- | --- |
| `~/.claude`, `~/.g-code`, `~/.agents` ของผู้ใช้ | รัน | รัน นอก sandbox |
| plugin ที่ติดตั้งระดับผู้ใช้ | รัน | รัน นอก sandbox |
| plugin ที่ติดตั้งให้เฉพาะโปรเจกต์นี้ | ไม่รัน | รัน ใน sandbox |
| `.claude`, `.g-code`, `.agents`, `.gcode.json` ของ repo | ไม่รัน ป้าย "Needs a trusted workspace" | รัน ใน sandbox |

สิ่งที่ควรสังเกต

- **การข้ามเงียบ** ไม่มีข้อความในแชตว่า hook ของ repo ไม่ได้รัน ที่เดียวที่บอกคือหัวข้อ Hooks ใน Settings
- **trust ถูกอ่านตอนต่อ engine** `peer.trusted` มาจาก `initialize` และ `HookSessions.open` เก็บชุด hook ของ session ไว้ตั้งแต่ run แรกใน process
  (อ่านจากโค้ด ยังไม่ได้ลองจริง) ถ้าผู้ใช้กดเชื่อถือ workspace ทีหลังแต่ engine ตัวเดิมยังรันอยู่ session ที่เปิดไว้แล้วอาจยังไม่รัน hook ของ repo
  จนกว่า engine จะเริ่มใหม่
