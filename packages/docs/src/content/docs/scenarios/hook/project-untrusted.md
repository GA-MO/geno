---
title: hook ของโปรเจกต์ไม่รันใน workspace ที่ไม่เชื่อถือ
description: repo มี hook ใน .claude/settings.json แต่ VS Code ยังไม่เชื่อถือ workspace hook ของผู้ใช้เองรัน ส่วน hook ของ repo รอจนกว่าจะเชื่อถือ
tableOfContents: false
sidebar:
  order: 6
scenario:
  surface: vscode
  given:
    - เปิดโฟลเดอร์ที่ clone มาใหม่ VS Code ยังไม่เชื่อถือ workspace นี้ (`vscode.workspace.isTrusted` เป็น false)
    - "`.claude/settings.json` ของ repo มี UserPromptSubmit hook ที่รัน `./scripts/hook.sh`"
    - "`~/.claude/settings.json` ของผู้ใช้มี UserPromptSubmit hook ของตัวเองที่รัน `~/bin/log-prompt.sh`"
    - หน้าต่างนี้ยังไม่ได้ต่อ engine
  trigger: >-
    ผู้ใช้ส่ง prompt แรกในแชตใหม่
  covers: [hook.project-untrusted]
  related: [hook.user-prompt-submit, ext.mcp-server-untrusted, start.open-window]
  steps:
    - id: settings
      lane: editor
      at: engine-link
      do: >-
        `engineSettings` อ่าน `vscode.workspace.isTrusted` ตอนต่อ engine ครั้งแรก
        แล้วส่งคำขอ ACP `initialize` ที่บอกสถานะ trust ไว้ใน `_meta` ใต้คีย์ `gcode/workspaceTrusted` (ครั้งนี้เป็น false)
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
      lane: server
      at: turns
      do: >-
        `runTurn` รับ prompt แล้วเรียก `runAgent` พร้อม `trustedWorkspace: from.peer.trusted`
      ref: "packages/engine/src/serve.ts#\"trustedWorkspace: from.peer.trusted,\""
      phase: starting

    - id: open
      lane: loop
      at: agent
      do: >-
        `runAgent` เปิด hook ของ session ด้วย `hooks.open` session นี้เปิดครั้งแรกใน engine ตัวนี้
        จึงอ่านการตั้งค่า hook ทั้งหมด: ของผู้ใช้ ของ plugin และของ workspace
      ref: packages/engine/src/hooks.ts#HookSessions.open

    - id: filter
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
                at: hooks
                do: >-
                  hook ทั้งสองตัวรันได้ `hookRunner` ห่อคำสั่งของ hook จาก repo ด้วย `sandbox.wrap`
                  hook ของ repo จึงเขียนได้แค่ใน workspace กับ scratchpad ของ session และใช้เครือข่ายตามกฎของ sandbox
                  hook ของผู้ใช้รันตรงๆ ในฐานะผู้ใช้
                ref: packages/engine/src/hooks.ts#hookRunner
              - lane: loop
                at: drive
                do: >-
                  `drive` บันทึก event `user` แล้ว UserPromptSubmit ของทั้งสองตัวได้อ่าน prompt ก่อนโมเดล
                ref: packages/engine/src/drive.ts#submitted
                emits: [user, UserPromptSubmit]
              - lane: loop
                at: step
                do: >-
                  ไม่มี hook บล็อก `loopStep` ตัดสิน `call-model` turn เดินต่อตามปกติ
                ref: packages/core/src/loop.ts#loopStep
                emits: [call-model]
                phase: calling-model
                end: { turn: continues, reason: call-model }

    - id: record
      lane: loop
      at: drive
      do: >-
        `drive` บันทึก event `user` แล้ว `submitted()` รัน UserPromptSubmit เฉพาะของผู้ใช้ `~/bin/log-prompt.sh`
        `./scripts/hook.sh` ของ repo ไม่รัน และไม่มีอะไรบอกโมเดลหรือแผงแชตว่ามันถูกข้าม
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

trust ของ VS Code คือเส้นแบ่งระหว่างการตั้งค่าที่ผู้ใช้เขียนเองกับการตั้งค่าที่มากับ repo
hook ของ repo เป็นคำสั่ง shell ที่คนอื่นเขียน Geno จึงไม่รันมันจนกว่าผู้ใช้จะบอก VS Code ว่าเชื่อถือโฟลเดอร์นี้
และเมื่อรัน ก็รันใน sandbox เหมือนคำสั่งของโมเดล

| ที่มาของ hook | workspace ไม่เชื่อถือ | workspace เชื่อถือ |
| --- | --- | --- |
| `~/.claude`, `~/.g-code`, `~/.agents` ของผู้ใช้ | รัน | รัน นอก sandbox |
| plugin ที่ติดตั้งระดับผู้ใช้ | รัน | รัน นอก sandbox |
| `.claude`, `.g-code`, `.agents`, `.gcode.json` ของ repo | ไม่รัน ป้าย "Needs a trusted workspace" | รัน ใน sandbox |

สิ่งที่ควรสังเกต

- **การข้ามเงียบ** ไม่มีข้อความในแชตว่า hook ของ repo ไม่ได้รัน ที่เดียวที่บอกคือหัวข้อ Hooks ใน Settings
- **trust ถูกอ่านตอนต่อ engine** `peer.trusted` มาจาก `initialize` และ `HookSessions.open` เก็บชุด hook ของ session ไว้ตั้งแต่ run แรกใน process
  (อ่านจากโค้ด ยังไม่ได้ลองจริง) ถ้าผู้ใช้กดเชื่อถือ workspace ทีหลังแต่ engine ตัวเดิมยังรันอยู่ session ที่เปิดไว้แล้วอาจยังไม่รัน hook ของ repo
  จนกว่า engine จะเริ่มใหม่
