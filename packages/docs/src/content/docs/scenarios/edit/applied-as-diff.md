---
title: แก้ไฟล์แล้วแสดงเป็น diff
description: โมเดลแก้ไฟล์ที่อ่านแล้ว การแก้ลง buffer ของ VS Code ผ่าน ACP บันทึกลงดิสก์ และแผงแสดง diff ของ turn
tableOfContents: false
sidebar:
  order: 1
scenario:
  surface: vscode
  given:
    - turn กำลังทำงานในโหมด Ask หรือ Auto และ `gcode.review.mode` เป็น `auto` (ค่าเริ่มต้น)
    - ก่อนหน้าใน turn นี้โมเดล `read` ไฟล์ `src/date.ts` แล้ว และไฟล์ยังไม่เปลี่ยนตั้งแต่นั้น
    - ไม่มี hook และไม่มีกฎ path ของ workspace
  trigger: >-
    โมเดลขอเรียก `edit` บน `src/date.ts` ด้วย `old_str` และ `new_str`
  covers: [edit.applied-as-diff]
  related: [edit.create-file, ed.review-auto-undo, edit.without-read-or-stale, edit.old-str-mismatch, ed.review-hunks]
  steps:
    - id: asks
      lane: model
      do: >-
        โมเดลขอเรียก `edit` กับ `src/date.ts` แทนข้อความหนึ่งช่วง (`old_str`) ด้วยข้อความใหม่ (`new_str`)
        และจบคำตอบด้วย `stop_reason: tool_use`
      ref: "packages/engine/src/gateway.ts#\"stopReason: message.stop_reason,\""
      emits: [tool_use]
      phase: calling-model

    - id: logged
      lane: loop
      at: drive
      do: >-
        `drive` บันทึก event `assistant` ที่มีบล็อก `tool_use` ลง log
      ref: "packages/engine/src/drive.ts#\"await record({ kind: 'assistant', seq: nextSeq(events), at, ...result.turn\""
      emits: [assistant]

    - use: tool-call-opens

    - id: guards
      lane: tool
      at: executor
      do: >-
        `edit` ตรวจว่า path เขียนได้ (อยู่ใน workspace หรือไดเรกทอรีที่อนุญาตเพิ่ม) แล้วหาฐาน: ข้อความที่โมเดลเห็นครั้งล่าสุดจาก `read`
        ถ้าไม่เคยอ่านไฟล์ที่มีอยู่ การแก้จะถูกปฏิเสธว่า "read src/date.ts before editing it"
        ในโหมด Ask และ Auto การแก้ใน workspace ไม่ขึ้นการ์ดขออนุญาต
      ref: packages/engine/src/tools/agent.ts#editExecutor

    - id: apply
      lane: tool
      at: executor
      do: >-
        `applyEditToFile` อ่านข้อความปัจจุบันอีกครั้ง ตรวจว่ายังตรงกับฐาน แล้ว `strReplace` หา `old_str` ซึ่งต้องตรงทุกตัวอักษรและมีที่เดียว
        ตัวอักษรซ่อนที่ `read` แสดงเป็นรหัสถูกแปลงกลับก่อน การแก้จึงตรงกับไบต์จริงของไฟล์
      ref: packages/engine/src/files.ts#applyEditToFile

    - use: edit-write-lands

    - id: result
      lane: tool
      at: executor
      do: >-
        `edit` อ่านข้อความที่เขียนแล้วกลับมาเป็นฐานใหม่ ถ้าตั้งคำสั่ง `check` ไว้ จะรันใน sandbox แล้วต่อผลท้ายข้อความ
        ข้อความผลบอกโมเดลว่าไม่ต้องอ่านไฟล์ซ้ำ สถานะเป็น `ok` แม้ check จะล้มเหลว
      ref: "packages/engine/src/tools/agent.ts#\"const editedText = \""

    - id: post-hooks
      lane: policy
      at: hooks
      do: >-
        PostToolUse hooks ได้อ่านการแก้ในรูปเดียวกับเครื่องมือ Edit ของ Claude Code เมื่อไม่มี hook ก็ผ่านไป
      ref: packages/engine/src/hooks.ts#AFTER_TOOL_EVENT
      emits: [PostToolUse]

    - use: tool-result-returns

    - id: next
      lane: loop
      at: step
      do: >-
        `loopStep` เห็น `tool-result` ล่าสุดจึงตัดสิน `call-model` ก่อนเรียกโมเดล `callModel` บันทึก `checkpoint` ใหม่
        ซึ่งรวมไฟล์ที่เพิ่งแก้ เพราะการแก้ถูกบันทึกลงดิสก์แล้ว
      ref: packages/core/src/loop.ts#loopStep
      emits: [call-model]
      phase: calling-model
      end: { turn: continues, reason: call-model }
---

การแก้ไฟล์ของ Geno ไม่ได้เขียนดิสก์จาก engine โดยตรงเมื่อมี VS Code แสดง session อยู่ engine ส่งข้อความทั้งไฟล์ไปให้ extension
แล้ว extension แก้ buffer ด้วย `WorkspaceEdit` ผลคือ

- การแก้ค้างที่ผู้ใช้ยังไม่บันทึกถูกนับเป็นฐาน ถ้าผู้ใช้แก้ไฟล์หลังโมเดลอ่าน การแก้ของโมเดลจะ stale และโมเดลต้องอ่านใหม่
- ผู้ใช้กด Cmd-Z ใน editor เพื่อย้อนการแก้แต่ละครั้งได้
- buffer ที่ไม่มีการแก้ค้างถูกบันทึกทันที checkpoint ที่ snapshot ดิสก์ก่อนการเรียกโมเดลแต่ละครั้งจึงเห็นการแก้ของ Geno

สิ่งที่ควรสังเกต

- **Edit ไม่ถามในโหมด Ask และ Auto** ผู้ใช้ตรวจการแก้ทีหลัง: ในโหมด review แบบ `auto` ท้าย turn มีแถว "1 file changed · Undo"
  ดู [ดูการเปลี่ยนแปลงของเทิร์นและ Undo](/scenarios/ed/review-auto-undo/) ในโหมด `review` แต่ละ hunk มี Keep และ Undo
- **โหมด Plan** ปฏิเสธ `edit` ทั้งหมด ผลเป็น error ธรรมดา แผงจึงแสดงว่าขั้นล้มเหลว ไม่ใช่ถูกปฏิเสธ
- **ไม่มี editor ก็แก้ได้** เมื่อไม่มี editor ที่เขียนไฟล์ได้แสดง session นั้น (เช่นใน CLI) หรือ session ทำงานใน lane
  engine เขียนไฟล์ชั่วคราวแล้ว rename ทับ ไม่มี action `diff` สดในแผง
