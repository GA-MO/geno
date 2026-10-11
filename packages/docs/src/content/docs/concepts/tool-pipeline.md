---
title: เครื่องมือและการขออนุญาต
description: เส้นทางของ tool call ตั้งแต่โมเดลขอ ผ่าน hook การจัดชุด กฎ settle และการ์ด จนผลกลับไปหาโมเดล
sidebar:
  order: 3
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
  R -- "ไม่ติดธง" --> RUN["เครื่องมือทำงาน<br/>(shell ใน sandbox, ไฟล์ผ่าน buffer ของ editor)"]
  R -- "ติดธง" --> ST{"settle()"}
  ST -- "deny / non-interactive" --> PRH1["PermissionRequest hook (ถ้าตอบได้)"] --> DEN["ToolDenied (โมเดลทำต่อ)"]
  ST -- "classify (Auto)" --> CL["classifier, 8 วินาที, ล้มเหลว = ask"]
  CL -- allow --> RUN
  CL -- deny --> DEN
  CL -- "ask ระหว่าง classify" --> DEN
  CL -- "ask ตอน Auto พัก" --> CARD
  ST -- "ask" --> PRH2["PermissionRequest hook"] --> CARD["การ์ดขออนุญาต<br/>session/request_permission"]
  CARD -- "Allow / session / workspace" --> RUN
  CARD -- "No + ข้อความ" --> DEN
  CARD -- "Reject / ยกเลิก" --> REJ["ToolRejected: batch หยุด,<br/>call ที่เหลือได้ 'user rejected', turn จบ"]
  RUN --> POST["PostToolUse hooks; ผลยาวเก็บลงไฟล์"]
  POST --> LOGR["หลังทั้งชุด: บันทึกผลตามลำดับที่โมเดลขอ<br/>→ tool_call_update พร้อม APPROVAL_META"]
  LOGR --> PB["PostToolBatch hook"] --> NEXT["จุดปลอดภัย → เรียกโมเดลครั้งถัดไป"]
```

## ปฏิเสธกับปฏิเสธพร้อมข้อความต่างกันอย่างไร

`ToolRejected` (ผู้ใช้กด Reject เฉยๆ) จบ turn ทันที ส่วน `ToolDenied` (กฎ, Auto, hook หรือผู้ใช้ปฏิเสธพร้อมข้อความ)
เป็นผลธรรมดาที่โมเดลอ่านแล้วหาทางอื่นต่อ

## โหมดสิทธิ์

| โหมด | คำสั่งนอก safe list | การแก้ไฟล์ |
| --- | --- | --- |
| Plan | ปฏิเสธ | ปฏิเสธ (แสดงเป็นล้มเหลว) |
| Ask (ค่าเริ่มต้น) | แสดงการ์ดถามผู้ใช้ | ไม่ถาม ผู้ใช้ตรวจทีหลัง |
| Auto | ให้ classifier ตัดสิน ถ้าไม่แน่ใจก็บล็อก | ไม่ถาม |
| non-interactive | รันใน sandbox เพราะไม่มีใครให้ถาม | ไม่ถาม |

คำสั่งอันตราย เช่น `rm -rf` ของ workspace หรือ `.git` ยังถามเสมอแม้ใน Auto และกฎ allow ครอบคลุมไม่ได้
การอนุญาตไม่ได้ยกเว้น sandbox: shell ยังเขียนได้แค่ใน workspace และ temp และออกเน็ตได้เฉพาะโดเมนที่อนุญาต

เดินดูการ์ดและทางแยกทั้งสี่ได้ใน [โหมด Ask ขออนุญาตก่อนรันคำสั่ง](/scenarios/perm/ask-mode-bash-approval/)
