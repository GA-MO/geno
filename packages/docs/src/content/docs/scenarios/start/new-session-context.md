---
title: "Session ใหม่โหลดคำสั่งโปรเจกต์ memory และ skill"
description: ข้อความแรกของหน้าต่างสร้าง session ใหม่ engine อ่านไฟล์คำสั่ง หน่วยความจำ สกิล และสภาพแวดล้อมครั้งเดียว แล้วส่งไปกับข้อความ user แรก
scenario:
  surface: vscode
  given:
    - ตั้ง API key แล้ว และแผงแชตแสดงหน้าเริ่มต้น หน้าต่างนี้ยังไม่มี session
    - workspace มี `AGENTS.md` ผู้ใช้มี `~/.claude/CLAUDE.md` โน้ตในหน่วยความจำ และสกิลที่ติดตั้งไว้
  trigger: >-
    ผู้ใช้ส่งข้อความแรก "เพิ่มเทสต์ให้ฟังก์ชัน parseDate"
  covers: [start.new-session-context]
  related: [start.open-window, sess.new-chat, turn.text-answer, ext.memory-write]
  steps:
    - id: type
      lane: user
      beat:
        title: "คุณส่งข้อความแรกของหน้าต่างนี้"
        text: >-
          หน้าต่างนี้ยังไม่มี session คุณพิมพ์ "เพิ่มเทสต์ให้ฟังก์ชัน parseDate" แล้วกด Enter
        from: you
        to: panel
      do: ผู้ใช้พิมพ์ข้อความแรกแล้วกด Enter
      phase: idle

    - id: send
      lane: panel
      at: composer
      do: >-
        `submit()` โพสต์ข้อความ `send` ไปให้ extension host
      ref: packages/extension/src/chat/webview.ts#submit
      emits: [send]

    - id: turn-start
      lane: editor
      at: chat
      beat:
        title: "แชตขึ้นข้อความของคุณกับแถว Thinking"
        text: >-
          แผงแสดงข้อความของคุณก่อนติดต่อ engine แล้ว VS Code เริ่มหา session ที่จะส่งข้อความนี้เข้าไป
        from: panel
        to: you
        sees: { kind: composer, state: working, header: working }
      do: >-
        `prompt()` ส่ง action `turn-start` ก่อนติดต่อ engine แล้วเรียก `link()`
      sees: บับเบิลข้อความของผู้ใช้ หัวข้อเป็น "working" และแถว "Thinking"
      ref: packages/extension/src/chat/chat.ts#Chat.prompt
      emits: [turn-start]

    - id: fresh
      lane: editor
      at: chat
      beat:
        title: "VS Code ขอ session ใหม่จาก engine"
        text: >-
          ไม่มีแชตที่แสดงอยู่หรือที่จำไว้ VS Code จึงขอ session ใหม่ พร้อมโฟลเดอร์ของหน้าต่าง และ MCP server
          ที่คุณตั้งไว้ใน VS Code
        from: panel
        to: engine
      do: >-
        `openSession` ไม่พบแชตที่แสดงอยู่หรือที่จำไว้ จึงเรียก `fresh()` ซึ่งส่งคำขอ ACP `session/new`
        พร้อมโฟลเดอร์และ MCP server จาก `mcp.json` ของผู้ใช้ใน VS Code
      ref: packages/extension/src/chat/chat.ts#Chat.fresh

    - id: choose
      lane: server
      at: sessions
      beat:
        title: "Geno เลือก provider และ model"
        text: >-
          engine เลือก provider และ model ก่อนเขียนอะไรลงดิสก์ ถ้าคีย์ขาด error เกิดตรงนี้และไม่มีไฟล์ session ค้างไว้
        from: engine
        to: engine
      do: >-
        `startSession` เลือก provider และ model จาก `GCODE_PROVIDER` และ `GCODE_MODEL` (ค่าเริ่มต้น Model Studio)
        และสร้าง gateway ก่อนเขียนอะไร ถ้าคีย์ขาด error จะเกิดตรงนี้และไม่เหลือไฟล์ session ค้าง
      ref: packages/engine/src/chat.ts#startSession

    - id: instructions
      lane: server
      at: sessions
      beat:
        title: "Geno อ่านไฟล์คำสั่งของคุณและของโปรเจกต์"
        text: >-
          Geno อ่านไฟล์คำสั่งของคุณก่อน แล้วเดินจากรากของดิสก์ลงมาถึง workspace เพื่อเก็บ `AGENTS.md` หรือ `CLAUDE.md`
          ของแต่ละโฟลเดอร์ ไฟล์หนึ่งดึงไฟล์อื่นเข้ามาด้วยบรรทัด `@path` ได้อีกหลายชั้น
        from: engine
        to: engine
      do: >-
        `loadProjectContext` อ่านไฟล์คำสั่ง: ไฟล์ของผู้ใช้ก่อน (`AGENTS.md` ใน home ของ Geno แล้ว `CLAUDE.md` ของ Claude Code)
        แล้วเดินจากรากของดิสก์ลงมาถึง workspace เอาไฟล์แรกที่มีในแต่ละโฟลเดอร์จาก `AGENTS.override.md`, `AGENTS.md`, `CLAUDE.md`
        ตามด้วย `.claude/CLAUDE.md`, `CLAUDE.local.md` และ `.cursor/rules` บรรทัด `@path` ดึงไฟล์อื่นเข้ามาได้อีก 4 ชั้น
      ref: packages/engine/src/project-context.ts#loadProjectContext

    - id: rest
      lane: server
      at: sessions
      beat:
        title: "Geno โหลด skill, memory และสภาพแวดล้อม"
        text: >-
          พร้อมกันนั้น Geno โหลดรายการ skill ที่ model เรียกได้ โน้ตใน memory ของคุณและของโปรเจกต์ และภาพของเครื่อง
          เช่นสถานะ git, shell และวันที่
        from: engine
        to: engine
      do: >-
        พร้อมกันนั้น `newSession` โหลดรายการสกิลที่ model เรียกได้ โน้ตในหน่วยความจำของผู้ใช้และของโปรเจกต์
        และภาพสภาพแวดล้อม: สถานะ git, platform, shell, ไดเรกทอรี scratchpad, วันที่ และ model
      ref: packages/engine/src/chat.ts#newSession

    - id: frozen
      lane: server
      at: sessions
      beat:
        title: "Geno เขียนทั้งหมดเป็นบรรทัดแรกของ session"
        text: >-
          ทุกอย่างถูกบันทึกเป็นบรรทัดแรกของไฟล์ session และไม่ถูกอ่านใหม่อีก ทุกคำขอต่อจากนี้ส่งข้อความชุดนี้ซ้ำทุกไบต์
          prompt cache จึงไม่หลุด และการแก้ `AGENTS.md` ระหว่างแชตไม่มีผลกับแชตนี้
        from: engine
        to: engine
      do: >-
        ทั้งหมดถูกเขียนเป็น event `session-start` บรรทัดแรกของไฟล์ JSONL ของ session ทุกคำขอต่อจากนี้ส่งข้อความชุดนี้ซ้ำทุกไบต์
        prompt cache จึงไม่หลุด และการแก้ `AGENTS.md` ระหว่างแชตไม่มีผลกับแชตนี้
      ref: "packages/engine/src/chat.ts#\"await appendEvent(file, start);\""
      emits: [session-start]

    - id: created
      lane: editor
      at: chat
      beat:
        title: "VS Code ได้ session แล้วส่ง prompt"
        text: >-
          engine ตอบ id ของ session VS Code สลับโหมดให้ตรงกับที่แผงเลือกไว้ แล้วส่ง prompt ของคุณ คำขอนี้ค้างอยู่จนกว่า
          turn จะจบ
        from: panel
        to: engine
      do: >-
        engine ตอบ id ของ session โหมด และตัวเลือก effort `fresh()` สลับเป็นโหมดที่แผงเลือกไว้ก่อนมี session
        (ค่าเริ่มต้นมาจากการตั้งค่า) ถ้าต่างกัน
        แล้ว `show` จำ id ไว้ บทสนทนาที่มี turn นี้อยู่แล้วยังคงแสดงต่อ
      ref: packages/extension/src/chat/chat.ts#Chat.show

    - id: prompt
      lane: editor
      at: engine-link
      do: >-
        `prompt()` ส่งคำขอ ACP `session/prompt` คำขอนี้ค้างอยู่จนกว่า turn จะจบ
      ref: "packages/extension/src/chat/chat.ts#\"mine.connection.agent.request(acp.methods.agent.session.prompt, {\""

    - id: accept
      lane: server
      at: turns
      beat:
        title: "Geno เริ่ม turn และตั้งชื่อแชต"
        text: >-
          engine รับ turn เปิดงานในแผง Tasks และตั้งชื่อแชตจากข้อความแรกของคุณ
        from: engine
        to: panel
      do: >-
        `runTurn` รับ turn เริ่มงานในแผง Tasks และส่ง `session_info_update` ที่ตั้งชื่อแชตจากข้อความแรก
      ref: packages/engine/src/serve.ts#runTurn
      emits: [session_info_update]
      phase: starting

    - id: session-start-hooks
      lane: policy
      at: hooks
      beat:
        title: "hook ตอนเริ่ม session ได้ทำงาน"
        text: >-
          ถ้าคุณตั้ง SessionStart hook ไว้ มันทำงานครั้งแรกตรงนี้ สิ่งที่ hook พิมพ์ออกมาถูกบันทึก
          และไปต่อท้ายส่วนเปิดของข้อความแรก ไม่มี hook ก็ข้ามไป
        from: engine
        to: machine
        sees:
          kind: payload
          source: docs/results/real-usecases/runs/A18-project-skill/1/requests.jsonl#seq=4
          select: messages[0].content[2]
      do: >-
        `runAgent` เปิด hooks ของ session นี้ครั้งแรกใน process นี้ ถ้าตั้ง SessionStart hook ไว้ มันทำงานด้วย source `startup`
        เพราะ model ยังไม่เคยตอบ ข้อความที่ hook พิมพ์ออกมาถูกบันทึกและไปต่อท้ายส่วนเปิดของข้อความแรก ไม่มี hook ก็ไม่มีอะไรเกิดขึ้นตรงนี้
      ref: packages/engine/src/hooks.ts#HookSessions.open
      emits: [SessionStart]

    - id: record
      lane: loop
      at: drive
      beat:
        title: "Geno บันทึก prompt ต่อจากส่วนเปิด"
        text: >-
          Geno บันทึกข้อความของคุณต่อจากบรรทัดแรก แล้วตัดสินจากบันทึกว่าขั้นต่อไปคือเรียก model
        from: engine
        to: engine
      do: >-
        `drive` บันทึก event `user` ต่อจาก `session-start` แล้ว UserPromptSubmit hooks ได้อ่าน prompt ก่อน model
      ref: "packages/engine/src/drive.ts#\"await record({ kind: 'user', seq: nextSeq(events), at: new Date().toISOString(), content: prompt });\""
      emits: [user]

    - id: decide
      lane: loop
      at: step
      do: >-
        `loopStep` อ่าน log แล้วตัดสินว่าขั้นต่อไปคือ `call-model`
      ref: packages/core/src/loop.ts#loopStep
      emits: [call-model]
      phase: calling-model

    - id: opening
      lane: loop
      at: model-call
      beat:
        title: "Geno ประกอบข้อความ user แรก"
        text: >-
          ข้อความ user แรกเรียงคำสั่งของคุณ คำสั่งของโปรเจกต์ รายการ skill, memory และสภาพแวดล้อมไว้ก่อน แล้วจึงต่อด้วย
          prompt ของคุณ system prompt เหมือนเดิมทุก session ส่วนเปิดนี้จึงถูก cache ไปด้วย
        from: engine
        to: model
        sees:
          kind: payload
          source: docs/results/real-usecases/runs/A18-project-skill/1/requests.jsonl#seq=4
          select: messages[0].content
          highlight:
            - "[3]"
          collapse:
            - "[0].text"
            - "[1].text"
      do: >-
        `callModel` บันทึก `checkpoint` แล้ว `replayMessages` ประกอบข้อความ user แรก: บล็อกคำสั่ง (`global_instructions`
        สำหรับไฟล์ของผู้ใช้ `project_instructions` สำหรับไฟล์ของ repo และรายการสกิล) โน้ตหน่วยความจำ และสภาพแวดล้อม
        แล้วจึงตามด้วย prompt ของผู้ใช้ system prompt ยังเป็นบล็อกเดียวกันทุก session
      ref: packages/core/src/session.ts#replayMessages
      emits: [checkpoint]

    - id: sent
      lane: loop
      at: gateway
      do: >-
        gateway ส่งคำขอให้ผู้ให้บริการ จุดตัด cache อยู่ท้ายข้อความ user ล่าสุด ส่วนเปิดจึงถูก cache พร้อม system prompt
      ref: packages/engine/src/gateway.ts#gatewayFor.turn

    - id: reads
      lane: model
      beat:
        title: "Model อ่านคำสั่งก่อนเริ่มงาน"
        text: >-
          model อ่านคำสั่งของคุณและของโปรเจกต์ก่อนถึงคำขอ แล้วเริ่มทำงาน จากตรงนี้ turn เดินเหมือน turn ปกติ
        from: model
        to: engine
        end: "turn ทำต่อตามปกติ"
      do: >-
        model อ่านคำสั่งของผู้ใช้และของโปรเจกต์ก่อนคำขอ แล้วเริ่มทำงานตามข้อความ turn ดำเนินต่อเหมือน turn ปกติ
      ref: "packages/engine/src/gateway.ts#\"stopReason: message.stop_reason,\""
      end: { turn: continues }
---

context ของ session ถูกโหลด**ครั้งเดียว** ตอนที่ engine ได้คำขอ `session/new` ไม่ใช่ทุก turn
และไม่ได้อยู่ใน system prompt แต่อยู่ในข้อความ user แรก system prompt จึงเหมือนกันทุก session และทุกโหมด

| ส่วน | มาจาก | อยู่ใน |
| --- | --- | --- |
| คำสั่งของผู้ใช้ | `AGENTS.md` ใน home ของ Geno, `CLAUDE.md` ของ Claude Code | `global_instructions` มีอำนาจเท่าคำพูดของผู้ใช้ |
| คำสั่งของโปรเจกต์ | `AGENTS.override.md` / `AGENTS.md` / `CLAUDE.md` จากรากถึง workspace, `.claude/CLAUDE.md`, `CLAUDE.local.md`, `.cursor/rules` | `project_instructions` ขยายสิทธิ์ไม่ได้ |
| สกิล | สกิลที่ model เรียกได้ของผู้ใช้ ของ workspace และของ plugin | รายการชื่อและคำอธิบาย |
| หน่วยความจำ | โน้ตของผู้ใช้และของโปรเจกต์นี้ | `memory` |
| สภาพแวดล้อม | git, platform, shell, scratchpad, วันที่, model | ส่วน environment |

สิ่งที่ควรสังเกต

- **session เกิดตอนไหน** ในหน้าต่างที่ยังไม่มีแชต session เกิดตอนส่งข้อความแรก แต่การกด New Chat สร้าง session ทันที
  context จึงถูกอ่านตอนกดปุ่ม ไม่ใช่ตอนพิมพ์ ดู [เริ่มแชทใหม่](/scenarios/sess/new-chat/)
- **ไฟล์คำสั่งในโฟลเดอร์ย่อย** ไม่ถูกส่งตั้งแต่ต้น ข้อความแรกบอกแค่ว่ามีไฟล์ไหนบ้าง แต่ละไฟล์ถูกแนบไปกับผล `read`
  ครั้งแรกของไฟล์ที่อยู่ใต้โฟลเดอร์นั้น
- **หน่วยความจำที่เปลี่ยนระหว่างแชต** ไม่แก้ส่วนเปิด การเปลี่ยนไปถึง model เป็น notice ที่จุดปลอดภัยก่อนการเรียก model ครั้งถัดไป
- **แก้ `AGENTS.md` แล้วต้องเริ่มแชตใหม่** แชตเดิมยังส่งข้อความชุดที่ถูกบันทึกไว้ใน `session-start`

อ่านต่อที่ [Model ตอบเป็นข้อความโดยไม่เรียก tool](/scenarios/turn/text-answer/) เพื่อดู turn ที่ตามมา
