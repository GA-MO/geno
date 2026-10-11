---
title: process ของระบบ
description: Geno แบ่งเป็น process ไหนบ้าง คุยกันด้วยอะไร และทำไม engine จึงอยู่รอดเมื่อปิดหน้าต่าง
sidebar:
  order: 1
---

Geno ไม่ได้รันลูปของเอเจนต์ใน VS Code ลูปอยู่ใน engine daemon ที่แยกออกไป
หน้าต่าง VS Code แต่ละบานเป็นแค่ client ที่ต่อเข้ามา

```mermaid
flowchart LR
  subgraph Window["หน้าต่าง VS Code"]
    W["แผงแชท (webview)<br/>chat/webview.ts"]
    X["Extension host<br/>extension.ts, chat/chat.ts<br/>+ toast, CodeLens,<br/>status bar, buffer"]
    T["Tab provider<br/>tab/provider.ts"]
  end
  L["llama-server<br/>(ในเครื่อง สำหรับ Tab)"]
  subgraph Engine["Engine daemon: gcode serve --socket (อยู่ต่อแม้ปิดหน้าต่าง)"]
    S["เซิร์ฟเวอร์ ACP<br/>serve.ts: turns, serially,<br/>steer, replay, viewers,<br/>tasks, wakes, editorTurn"]
    R["ลูป<br/>agent.ts runAgent → drive.ts<br/>→ core loopStep"]
    C["ลูปของลูก<br/>subagent, workflow<br/>และ arena"]
    G["Gateway + wire"]
  end
  P["ผู้ให้บริการโมเดล"]
  O["เครื่องมือ: shell ใน sandbox,<br/>ดิสก์, งานเบื้องหลัง"]
  E["MCP server, เว็บ, gh,<br/>hook, classifier"]
  LOG[("log ของ session (JSONL),<br/>shadow checkpoint repo")]
  W <-- postMessage --> X
  X <-- "ACP JSON-RPC ผ่าน Unix socket (0600)" --> S
  X -- HTTP FIM --> L
  T --- X
  S --> R
  R --> C
  R --> G --> P
  C --> G
  R --> O
  R --> E
  R --> LOG
  S --> LOG
  CLI["CLI: gcode agent<br/>(runAgent ใน process เดียว,<br/>เทอร์มินัล, ไม่มี ACP)"] --> G
```

## สิ่งที่ควรรู้

- **Extension host** เริ่มเมื่อ VS Code เปิดเสร็จ `Engine` (`chat/engine.ts`) ต่อ socket ที่ `$TMPDIR/gcode-<hash>.sock`
  hash คิดจาก path ของ CLI โฟลเดอร์ env ของ engine และ key ถ้าไม่มีใครตอบ `launch()` เปิด engine แบบ detached แล้วรอ socket นานสุด 20 วินาที
- **Engine daemon** หน้าต่างที่เปิดโฟลเดอร์เดียวกัน ตั้งค่าเดียวกัน และใช้ key เดียวกัน ใช้ engine ตัวเดียวกัน
  engine อยู่ต่อเมื่อ reload หน้าต่าง และปิดตัวเอง 10 วินาทีหลังการเชื่อมต่อสุดท้ายปิด ถ้าไม่มีงานค้าง
  turn ที่เริ่มจากหน้าต่าง A จึงทำงานต่อและแสดงในหน้าต่าง B ได้
- **Viewers** จำว่าการเชื่อมต่อไหนกำลังแสดง session ไหน อัปเดตของ session ที่ไม่มีหน้าต่างไหนแสดงจะถูกทิ้ง (log ยังเก็บไว้)
  คำขออนุญาตรอจนมีหน้าต่างที่แสดง session นั้น
- **Webview** คุยกับ extension host เท่านั้น host รับ `Action` ไปลดลงใน transcript ของตัวเอง แล้วส่ง `Action` เดียวกันให้ webview
- **CLI** (`gcode agent`) รัน `runAgent` ใน process เดียว แสดงผลในเทอร์มินัล และถาม `[y/N]` ไม่มี ACP
- **Tab** ไม่ผ่าน engine เลย มันส่งคำขอ FIM ไปที่ `llama-server` ที่ extension เปิดไว้ในเครื่อง

ดูทุกส่วนเรียงตาม process และกระโดดเข้าทัวร์ได้ที่ [แผนที่ระบบ](/map/)
