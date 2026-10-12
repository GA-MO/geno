---
title: "ส่วนประกอบของ Geno"
description: Geno มีหกส่วนที่คุยกันด้วยสามช่องทาง HTTP ไปหา model, ACP ผ่าน Unix socket ระหว่าง extension กับ engine และ postMessage ระหว่าง extension กับแผงแชต
tableOfContents: false
sidebar:
  order: 2
scenario:
  surface: vscode
  given:
    - ติดตั้ง Geno และตั้ง API key ไว้แล้ว
    - ยังไม่มี engine ของโฟลเดอร์นี้ทำงานอยู่ และหน้าต่างนี้ไม่เคยเปิดแชต
  trigger: >-
    คุณเปิดโฟลเดอร์ใน VS Code แล้วพิมพ์ prompt แรกในแผงแชต
  covers: [turn.first-prompt-path]
  related: [start.open-window, start.new-session-context, turn.with-tools, turn.text-answer]
  steps:
    - id: open
      lane: user
      beat:
        title: "คุณเปิดโฟลเดอร์ใน VS Code"
        text: >-
          VS Code เปิด extension ของ Geno ซึ่งลงทะเบียนแผงแชตและคำสั่งต่างๆ
          ตอนนี้ยังไม่มีอะไรต่อ engine และยังไม่มีอะไรไปถึง model
        from: you
        to: panel
      do: ผู้ใช้เปิดโฟลเดอร์ใน VS Code
      phase: idle

    - id: activate
      lane: editor
      at: vscode-ui
      do: >-
        เมื่อ VS Code เปิดเสร็จ `activate` เรียก `registerChat` ซึ่งสร้าง `Chat` กับตัวเชื่อม `Engine`
        และลงทะเบียนแผงแชต ยังไม่ต่อ engine
      ref: packages/extension/src/extension.ts#registerChat

    - id: type
      lane: user
      beat:
        title: "คุณพิมพ์ prompt แรกแล้วกด Enter"
        text: >-
          แผงแชตเป็นหน้าเว็บใน VS Code มันส่งข้อความของคุณให้ extension host ด้วย postMessage
          บับเบิลข้อความขึ้นทันทีและปุ่ม Stop มาแทน Send ก่อนจะมีอะไรไปถึง engine
        from: you
        to: panel
        sees: { kind: composer, state: working, header: working }
      do: ผู้ใช้พิมพ์คำถามแล้วกด Enter

    - id: send
      lane: panel
      at: composer
      do: >-
        `submit()` โพสต์ข้อความ `send` พร้อมข้อความและไฟล์แนบไปให้ extension host
      ref: packages/extension/src/chat/webview.ts#submit
      emits: [send]

    - id: turn-start
      lane: editor
      at: chat
      do: >-
        `prompt()` ส่ง action `turn-start` ให้แผงทันที แล้วขอการเชื่อมต่อ engine ผ่าน `link()`
      ref: packages/extension/src/chat/chat.ts#Chat.prompt
      emits: [turn-start]

    - use: start-engine-connects
      beat:
        title: "Geno panel หา engine ผ่าน Unix socket"
        text: >-
          extension คำนวณที่อยู่ socket จาก hash ของโฟลเดอร์และการตั้งค่า ถ้ายังไม่มี engine ฟังอยู่ก็เปิด `gcode serve`
          เป็น process แยก แล้วส่ง `initialize` บอกว่า editor นี้ทำอะไรได้บ้าง ซึ่งกำหนดว่า model จะได้ tool ชุดไหน
        from: panel
        to: engine

    - id: fresh
      lane: editor
      at: chat
      beat:
        title: "Geno engine เปิด session และโหลดบริบท"
        text: >-
          หน้าต่างนี้ยังไม่มีแชต extension จึงขอ session ใหม่ engine โหลดไฟล์คำสั่ง memory รายการ skill
          และสภาพแวดล้อมของเครื่อง แล้วแช่แข็งไว้ใน log ของ session ทั้งหมดนี้จะเป็นข้อความแรกที่ model เห็น
        from: panel
        to: engine
      do: >-
        `sessionFor` ไม่พบแชตที่จำไว้ จึงเรียก `fresh` ซึ่งส่งคำขอ ACP `session/new` พร้อมโฟลเดอร์และ MCP server
      ref: packages/extension/src/chat/chat.ts#Chat.fresh
      emits: [session/new]

    - id: start
      lane: server
      at: sessions
      do: >-
        engine รับ `session/new` แล้ว `startSession` เลือกผู้ให้บริการกับ model และสร้าง log ใหม่
        `newSession` โหลดไฟล์คำสั่ง skill memory และสภาพแวดล้อมพร้อมกัน แล้วบันทึกเป็น event `session-start`
      ref: packages/engine/src/chat.ts#startSession
      emits: [session-start]

    - id: request
      lane: editor
      at: engine-link
      beat:
        title: "Geno engine เปิด turn และจด prompt ลง log"
        text: >-
          extension ส่ง `session/prompt` ผ่าน socket คำขอนี้ค้างอยู่จนจบ turn engine ประกอบชุด tool
          กับ system prompt แล้วจด prompt ของคุณเป็น event ใหม่ใน log ซึ่งเป็นความจริงเพียงแหล่งเดียวของบทสนทนา
        from: panel
        to: engine
      do: >-
        `prompt()` ส่งคำขอ ACP `session/prompt` ที่ค้างอยู่จนกว่า turn จะจบ
      ref: "packages/extension/src/chat/chat.ts#\"mine.connection.agent.request(acp.methods.agent.session.prompt, {\""

    - id: accept
      lane: server
      at: turns
      do: >-
        `runTurn` ตรวจว่า session นี้ไม่มี turn ทำงานอยู่ ลงทะเบียนตัวยกเลิกให้ปุ่ม Stop แล้วเรียก `runAgent`
      ref: packages/engine/src/serve.ts#runTurn
      phase: starting

    - id: build
      lane: loop
      at: agent
      do: >-
        `runAgent` ประกอบชุด tool system prompt กฎสิทธิ์ และ sandbox ทุกโหมดได้ชุดเดียวกัน
      ref: packages/engine/src/agent.ts#runAgent

    - id: record
      lane: loop
      at: drive
      do: >-
        `drive` บันทึก event `user` ต่อท้าย log ของ session
      ref: "packages/engine/src/drive.ts#\"await record({ kind: 'user', seq: nextSeq(events), at: new Date().toISOString(), content: prompt });\""
      emits: [user]

    - use: model-call
      beat:
        title: "Geno ประกอบ request แล้วส่งให้ model"
        text: >-
          loop อ่าน log แล้วตัดสินว่าต้องเรียก model gateway สร้าง request จาก log ทั้งก้อน
          ข้อความแรกมีบริบทที่โหลดไว้ และบล็อกสุดท้ายคือ prompt ของคุณ แล้วส่งเป็น HTTP stream ไปหาผู้ให้บริการ
        from: engine
        to: model
        sees:
          kind: payload
          direction: request
          source: docs/results/real-usecases/runs/A06-read-not-cat/1/requests.jsonl#seq=4
          select: messages[0].content
          highlight: ['[3].text']
          collapse: ['[0]', '[1]', '[2]']

    - id: answers
      lane: model
      beat:
        title: "AI model เริ่ม stream คำตอบกลับ"
        text: >-
          model อ่าน request แล้วเริ่มส่งคำตอบเป็นชิ้น ทั้งข้อความถึงคุณและคำขอเรียก tool
          จากตรงนี้ turn เดินต่อแบบเดียวกับทัวร์ "Model เรียก tool แล้วตอบ"
        from: model
        to: engine
      do: >-
        model stream คำตอบกลับมา gateway ส่งข้อความแต่ละชิ้นต่อให้แผง และเก็บคำขอ tool ไว้จนบล็อกปิด
      ref: "packages/engine/src/gateway.ts#\"stopReason: message.stop_reason,\""
      goto: turn.with-tools
---

## หกส่วนและสามช่องทาง

ทัวร์ข้างบนเดินผ่านทุกส่วนของ Geno หนึ่งรอบ ตารางนี้สรุปว่าแต่ละส่วนคืออะไร

| ส่วน | คืออะไร | อยู่ที่ไหน |
| --- | --- | --- |
| **คุณ** | คนพิมพ์ คลิก ตอบการ์ด และกด Stop | หน้าจอ |
| **Geno panel** (webview) | หน้าเว็บในแถบข้างของ VS Code วาดแชต การ์ด และช่องพิมพ์ ไม่มีสิทธิ์อ่านไฟล์หรือต่อเครือข่าย | `packages/extension/src/chat/webview.ts` |
| **VS Code extension host** | process ของ VS Code ที่รันโค้ด extension ของ Geno ถือการเชื่อมต่อกับ engine แปลง update เป็นสิ่งที่แผงวาด และเขียนไฟล์ผ่าน editor buffer | `packages/extension/src/chat/chat.ts` |
| **Geno engine** (server + loop) | process แยก (`gcode serve --socket`) ที่เดิน turn: ACP server ลูปของเอเจนต์ gateway ไปหา model และ log ของ session | `packages/engine/src/serve.ts` `agent.ts` `drive.ts` |
| **policy** | ส่วนของ engine ที่ตัดสินว่าแต่ละ tool call รันได้ไหม: กฎ permission โหมด classifier hook และ sandbox | `packages/engine/src/` และ `packages/core/src/` |
| **AI model** | API ของผู้ให้บริการ เช่น Model Studio Anthropic OpenRouter | นอกเครื่องของคุณ |
| **tool / เครื่องของคุณ** | shell ไฟล์ และโปรแกรมที่ tool แตะ คำสั่ง `bash` รันใน sandbox | เครื่องของคุณ |

```mermaid
flowchart LR
  U(["คุณ"]) --> W
  subgraph VS["หน้าต่าง VS Code"]
    W["Geno panel<br/>webview"] <-- "postMessage" --> X["Extension host<br/>chat.ts"]
  end
  X <-- "ACP JSON-RPC<br/>Unix socket" --> S
  subgraph EN["Geno engine (gcode serve)"]
    S["ACP server<br/>serve.ts"] --> L["loop<br/>agent.ts, drive.ts"]
    L --> P["policy<br/>permission, sandbox, hook"]
    L --> G["gateway + wire"]
    L --> LOG[("session log<br/>JSONL")]
  end
  G -- "HTTPS stream" --> M["AI model<br/>ผู้ให้บริการ"]
  P --> T["tool<br/>shell, ไฟล์"]
```

## หากันเจอได้อย่างไร

ไม่มี registry หรือ port ที่ตั้งไว้ล่วงหน้า แต่ละส่วนหาคู่ของมันจากสิ่งที่มีอยู่แล้ว

- **แผงกับ extension host** VS Code ให้ช่อง postMessage มาเองตอนสร้าง webview
  แผงส่ง `ready` เมื่อโหลดเสร็จ แล้ว extension host ตอบด้วยบทสนทนาทั้งชุด
- **extension host กับ engine** ที่อยู่ของ socket คำนวณได้ ไม่ต้องจด: `socketPathOf` ใน `packages/extension/src/chat/engine.ts`
  hash path ของ CLI โฟลเดอร์ และค่า environment ของ engine เป็น `$TMPDIR/gcode-<hash>.sock`
  หน้าต่างที่เปิดโฟลเดอร์เดียวกันด้วยการตั้งค่าเดียวกันจึงได้ socket เดียวกัน และใช้ engine ตัวเดียวกัน
  ถ้าต่อไม่ได้ extension เปิด engine เองแบบ detached แล้วลองต่อใหม่ทุก 50 ms นานสุด 20 วินาที
- **engine รู้ว่า editor ทำอะไรได้** จาก `initialize` ที่ส่งความสามารถใน `_meta` เช่น widget, Tasks และ editor action
  engine เก็บไว้เป็น `peer` และใช้ตัดสินว่าจะให้ model มี tool อย่าง `show_widget` หรือไม่
- **engine กับ model** ผู้ให้บริการและ model มาจากการตั้งค่าและ API key ที่ extension ส่งเป็น environment ของ engine
  `wireFor` ใน `packages/engine/src/wire.ts` เลือก wire ตามผู้ให้บริการ

engine อยู่ต่อเมื่อคุณ reload หน้าต่าง turn ที่กำลังทำงานจึงไม่หาย รายละเอียดอยู่ใน[Process ของระบบ](/concepts/processes/)
ถ้าคุณรัน `gcode agent` ในเทอร์มินัล loop ตัวเดียวกันรันใน process เดียว ไม่มีแผง ไม่มี ACP

## ต่อในบทนี้

- [ผ่า request หนึ่งก้อน](/foundations/anatomy-of-a-request/) request ที่ไปถึง model ในจังหวะสุดท้ายของทัวร์
- [จาก output สู่หน้าจอ](/foundations/output-to-screen/) ขากลับ จาก model ถึงแผงแชต
