---
title: "Tool และ permission"
description: เส้นทางของ tool call ตั้งแต่ model ขอ ผ่าน hook การจัดชุด กฎ settle และการ์ด จนผลกลับไปหา model
---

ทุก tool call เดินผ่านท่อเดียวกัน ทางแยกสำคัญคือ `settle()` ซึ่งเป็นฟังก์ชันเดียวที่ตัดสินทุกการกระทำที่ถูกตั้งธงไว้

```mermaid
flowchart TD
  A["assistant ที่มีบล็อก tool_use"] --> B["loopStep: run-tools"]
  B --> H["PreToolUse hooks ตัดสินทุก call ก่อน<br/>hooks.decide → refuse / ask / run"]
  H --> N["nextToolBatch: การอ่านพร้อมกันได้ถึง 8,<br/>bash / edit / call ที่อาจถาม รันทีละตัว"]
  N --> S["watcher.toolStart → tool_call in_progress"]
  S --> X["ชั้นของ executor: roster gate<br/>→ withPermissions → inMode<br/>→ withReach / withPathRules / withWriteRoots"]
  X --> R{"ฟังก์ชันกฎ<br/>ruledDenial / secretReadDenial /<br/>outsideReadDenial / mcpCallDenial"}
  R -- "ไม่ติดธง" --> RUN["tool ทำงาน<br/>(shell ใน sandbox, ไฟล์ผ่าน buffer ของ editor)"]
  R -- "ติดธง" --> ST{"settle()"}
  ST -- "deny / non-interactive" --> PRH1["PermissionRequest hook (ถ้าตอบได้)"] --> DEN["ToolDenied (model ทำต่อ)"]
  ST -- "classify (Auto)" --> CL["classifier, 8 วินาที, ล้มเหลว = ask"]
  CL -- allow --> RUN
  CL -- deny --> DEN
  CL -- ask --> PRH2
  ST -- "ask" --> PRH2["PermissionRequest hook"] --> CARD["การ์ดขออนุญาต<br/>session/request_permission"]
  CARD -- "Allow / session / workspace" --> RUN
  CARD -- "No + ข้อความ" --> DEN
  CARD -- "Reject / ยกเลิก" --> REJ["ToolRejected: batch หยุด,<br/>call ที่เหลือได้ 'user rejected', turn จบ"]
  RUN --> POST["PostToolUse hooks; ผลยาวเก็บลงไฟล์"]
  POST --> LOGR["หลังทั้งชุด: บันทึกผลตามลำดับที่ model ขอ<br/>→ tool_call_update พร้อม APPROVAL_META"]
  LOGR --> PB["PostToolBatch hook"] --> NEXT["จุดปลอดภัย → เรียก model ครั้งถัดไป"]
```

## ปฏิเสธกับปฏิเสธพร้อมข้อความต่างกันอย่างไร

`ToolRejected` (ผู้ใช้กด Reject เฉยๆ) จบ turn ทันที ส่วน `ToolDenied` (กฎ, Auto, hook หรือผู้ใช้ปฏิเสธพร้อมข้อความ)
เป็นผลธรรมดาที่ model อ่านแล้วหาทางอื่นต่อ

## โหมดสิทธิ์

| โหมด | คำสั่งนอก safe list | การแก้ไฟล์ |
| --- | --- | --- |
| Plan | ปฏิเสธ | ปฏิเสธ (แสดงเป็นล้มเหลว) |
| Ask (ค่าเริ่มต้น) | แสดงการ์ดถามผู้ใช้ | ไม่ถาม ผู้ใช้ตรวจทีหลัง |
| Auto | ให้ classifier ตัดสิน ถ้าไม่แน่ใจก็ถามคุณ | ไม่ถาม |
| non-interactive | รันใน sandbox เพราะไม่มีใครให้ถาม | ไม่ถาม |

คำสั่งอันตราย เช่น `rm -rf` ของ workspace หรือ `.git` ยังถามเสมอแม้ใน Auto และกฎ allow ครอบคลุมไม่ได้
การอนุญาตไม่ได้ยกเว้น sandbox: shell ยังเขียนได้แค่ใน workspace และ temp และออกเน็ตได้เฉพาะโดเมนที่อนุญาต
ทางเดียวที่คำสั่งออกนอก sandbox คือ model ขอด้วย `dangerouslyDisableSandbox: true` แล้วคุณกดอนุญาตการ์ดของคำสั่งนั้น
การ์ดนี้ขึ้นทุกครั้งแม้ใน Auto ไม่มี classifier, hook หรือกฎ allow ตอบแทนคุณ และ Plan กับ run ที่ไม่มีใครให้ถามปฏิเสธเสมอ

เดินดูการ์ดและทางแยกทั้งสี่ได้ใน [โหมด Ask ขออนุญาตก่อนรันคำสั่ง](/scenarios/perm/ask-mode-bash-approval/)
