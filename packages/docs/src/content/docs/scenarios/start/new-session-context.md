---
title: โหลดคำสั่งโปรเจกต์ หน่วยความจำ และสกิล
description: ข้อความแรกของหน้าต่างสร้าง session ใหม่ engine อ่านไฟล์คำสั่ง หน่วยความจำ สกิล และสภาพแวดล้อมครั้งเดียว แล้วส่งไปกับข้อความ user แรก
tableOfContents: false
sidebar:
  order: 4
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
      do: >-
        `prompt()` ส่ง action `turn-start` ก่อนติดต่อ engine แล้วเรียก `link()`
      sees: บับเบิลข้อความของผู้ใช้ หัวข้อเป็น "working" และแถว "Thinking"
      ref: packages/extension/src/chat/chat.ts#Chat.prompt
      emits: [turn-start]

    - id: fresh
      lane: editor
      at: chat
      do: >-
        `openSession` ไม่พบแชตที่แสดงอยู่หรือที่จำไว้ จึงเรียก `fresh()` ซึ่งส่งคำขอ ACP `session/new`
        พร้อมโฟลเดอร์และ MCP server จาก `mcp.json` ของผู้ใช้ใน VS Code
      ref: packages/extension/src/chat/chat.ts#Chat.fresh

    - id: choose
      lane: server
      at: sessions
      do: >-
        `startSession` เลือก provider และโมเดลจาก `GCODE_PROVIDER` และ `GCODE_MODEL` (ค่าเริ่มต้น Model Studio)
        และสร้าง gateway ก่อนเขียนอะไร ถ้าคีย์ขาด error จะเกิดตรงนี้และไม่เหลือไฟล์ session ค้าง
      ref: packages/engine/src/chat.ts#startSession

    - id: instructions
      lane: server
      at: sessions
      do: >-
        `loadProjectContext` อ่านไฟล์คำสั่ง: ไฟล์ของผู้ใช้ก่อน (`AGENTS.md` ใน home ของ Geno แล้ว `CLAUDE.md` ของ Claude Code)
        แล้วเดินจากรากของดิสก์ลงมาถึง workspace เอาไฟล์แรกที่มีในแต่ละโฟลเดอร์จาก `AGENTS.override.md`, `AGENTS.md`, `CLAUDE.md`
        ตามด้วย `.claude/CLAUDE.md`, `CLAUDE.local.md` และ `.cursor/rules` บรรทัด `@path` ดึงไฟล์อื่นเข้ามาได้อีก 4 ชั้น
      ref: packages/engine/src/project-context.ts#loadProjectContext

    - id: rest
      lane: server
      at: sessions
      do: >-
        พร้อมกันนั้น `newSession` โหลดรายการสกิลที่โมเดลเรียกได้ โน้ตในหน่วยความจำของผู้ใช้และของโปรเจกต์
        และภาพสภาพแวดล้อม: สถานะ git, platform, shell, ไดเรกทอรี scratchpad, วันที่ และโมเดล
      ref: packages/engine/src/chat.ts#newSession

    - id: frozen
      lane: server
      at: sessions
      do: >-
        ทั้งหมดถูกเขียนเป็น event `session-start` บรรทัดแรกของไฟล์ JSONL ของ session ทุกคำขอต่อจากนี้ส่งข้อความชุดนี้ซ้ำทุกไบต์
        prompt cache จึงไม่หลุด และการแก้ `AGENTS.md` ระหว่างแชตไม่มีผลกับแชตนี้
      ref: "packages/engine/src/chat.ts#\"await appendEvent(file, start);\""
      emits: [session-start]

    - id: created
      lane: editor
      at: chat
      do: >-
        engine ตอบ id ของ session โหมด และตัวเลือก effort `fresh()` สลับเป็นโหมดที่การตั้งค่าให้แชตใหม่ถ้าต่างกัน
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
      do: >-
        `runTurn` รับ turn เริ่มงานในแผง Tasks และส่ง `session_info_update` ที่ตั้งชื่อแชตจากข้อความแรก
      ref: packages/engine/src/serve.ts#runTurn
      emits: [session_info_update]
      phase: starting

    - id: session-start-hooks
      lane: policy
      at: hooks
      do: >-
        `runAgent` เปิด hooks ของ session นี้ครั้งแรกใน process นี้ SessionStart hooks ทำงานด้วย source `startup`
        เพราะโมเดลยังไม่เคยตอบ ข้อความที่ hook พิมพ์ออกมาถูกบันทึกและไปต่อท้ายส่วนเปิดของข้อความแรก
      ref: packages/engine/src/hooks.ts#HookSessions.open
      emits: [SessionStart]

    - id: record
      lane: loop
      at: drive
      do: >-
        `drive` บันทึก event `user` ต่อจาก `session-start` แล้ว UserPromptSubmit hooks ได้อ่าน prompt ก่อนโมเดล
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
      do: >-
        โมเดลอ่านคำสั่งของผู้ใช้และของโปรเจกต์ก่อนคำขอ แล้วเริ่มทำงานตามข้อความ turn ดำเนินต่อเหมือน turn ปกติ
      ref: "packages/engine/src/gateway.ts#\"stopReason: message.stop_reason,\""
      end: { turn: continues }
---

context ของ session ถูกโหลด**ครั้งเดียว** ตอนที่ engine ได้คำขอ `session/new` ไม่ใช่ทุก turn
และไม่ได้อยู่ใน system prompt แต่อยู่ในข้อความ user แรก system prompt จึงเหมือนกันทุก session และทุกโหมด

| ส่วน | มาจาก | อยู่ใน |
| --- | --- | --- |
| คำสั่งของผู้ใช้ | `AGENTS.md` ใน home ของ Geno, `CLAUDE.md` ของ Claude Code | `global_instructions` มีอำนาจเท่าคำพูดของผู้ใช้ |
| คำสั่งของโปรเจกต์ | `AGENTS.override.md` / `AGENTS.md` / `CLAUDE.md` จากรากถึง workspace, `.claude/CLAUDE.md`, `CLAUDE.local.md`, `.cursor/rules` | `project_instructions` ขยายสิทธิ์ไม่ได้ |
| สกิล | สกิลที่โมเดลเรียกได้ของผู้ใช้ ของ workspace และของ plugin | รายการชื่อและคำอธิบาย |
| หน่วยความจำ | โน้ตของผู้ใช้และของโปรเจกต์นี้ | `memory` |
| สภาพแวดล้อม | git, platform, shell, scratchpad, วันที่, โมเดล | ส่วน environment |

สิ่งที่ควรสังเกต

- **session เกิดตอนไหน** ในหน้าต่างที่ยังไม่มีแชต session เกิดตอนส่งข้อความแรก แต่การกด New Chat สร้าง session ทันที
  context จึงถูกอ่านตอนกดปุ่ม ไม่ใช่ตอนพิมพ์ ดู [เริ่มแชทใหม่](/scenarios/sess/new-chat/)
- **ไฟล์คำสั่งในโฟลเดอร์ย่อย** ไม่ถูกส่งตั้งแต่ต้น ข้อความแรกบอกแค่ว่ามีไฟล์ไหนบ้าง แต่ละไฟล์ถูกแนบไปกับผล `read`
  ครั้งแรกของไฟล์ที่อยู่ใต้โฟลเดอร์นั้น
- **หน่วยความจำที่เปลี่ยนระหว่างแชต** ไม่แก้ส่วนเปิด การเปลี่ยนไปถึงโมเดลเป็น notice ที่จุดปลอดภัยก่อนการเรียกโมเดลครั้งถัดไป
- **แก้ `AGENTS.md` แล้วต้องเริ่มแชตใหม่** แชตเดิมยังส่งข้อความชุดที่ถูกบันทึกไว้ใน `session-start`
