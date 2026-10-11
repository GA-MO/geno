---
title: อ่านหลายไฟล์พร้อมกัน
description: โมเดลขออ่านสามไฟล์และค้นข้อความสองครั้งในคำตอบเดียว harness รันทั้งห้าพร้อมกัน แล้วบันทึกผลตามลำดับที่โมเดลขอ
tableOfContents: false
sidebar:
  order: 1
scenario:
  surface: vscode
  given:
    - turn กำลังทำงานในแผงแชตของ VS Code โหมดใดก็ได้
    - ไม่มี hook ที่ตั้งไว้ ทุก path อยู่ใน workspace และไม่มีไฟล์ลับ
    - ผู้ใช้เปิด `src/date.ts` ค้างไว้ใน editor และมีการแก้ที่ยังไม่บันทึก
  trigger: >-
    โมเดลตอบด้วยบล็อก `tool_use` ห้าบล็อก: `read` สามไฟล์ `grep` หนึ่งครั้ง และ `glob` หนึ่งครั้ง
  covers: [tool.parallel-read-batch]
  related: [turn.with-tools, tool.mixed-batch-sequencing, tool.bash-safe-runs, edit.applied-as-diff]
  steps:
    - id: asks
      lane: model
      do: >-
        โมเดลขอ `read` ไฟล์ `src/date.ts`, `src/date.test.ts` และ `package.json` แล้วขอ `grep` หา `parseDate`
        และ `glob` หา `**/*.test.ts` ในคำตอบเดียว จบด้วย `stop_reason: tool_use`
      ref: "packages/engine/src/gateway.ts#\"stopReason: message.stop_reason,\""
      emits: [tool_use]
      phase: calling-model

    - id: logged
      lane: loop
      at: drive
      do: >-
        `drive` บันทึก event `assistant` ที่มีบล็อก `tool_use` ทั้งห้าลง log
      ref: "packages/engine/src/drive.ts#\"await record({ kind: 'assistant', seq: nextSeq(events), at, ...result.turn\""
      emits: [assistant]

    - use: tool-call-opens

    - id: together
      lane: loop
      at: tools
      do: >-
        `concurrentAt` ถามแต่ละ call ว่ารันพร้อมตัวอื่นได้หรือไม่ `read` ได้เมื่อ path ไม่ใช่ไฟล์ลับและไม่ออกนอก workspace
        `grep` และ `glob` ได้เสมอ ทั้งห้าจึงอยู่ชุดเดียวกัน (สูงสุด 8 ต่อชุด) และเริ่มพร้อมกัน
      ref: "packages/engine/src/drive.ts#\"const concurrentAt = (i: number): boolean =>\""

    - id: read
      lane: tool
      at: executor
      do: >-
        `read` แต่ละตัวอ่านผ่าน `editorFiles` เมื่อมี editor ที่อ่านไฟล์ได้แสดง session นี้อยู่ engine จึงส่งคำขอ ACP
        `fs/readTextFile` แทนการอ่านดิสก์เอง
      ref: packages/engine/src/serve.ts#editorFiles

    - id: buffer
      lane: editor
      at: bridge
      do: >-
        `readTextFile` ให้ข้อความของ buffer ที่เปิดอยู่ถ้ามี หรือข้อความบนดิสก์ถ้าไม่มี
        `src/date.ts` จึงมาพร้อมการแก้ที่ผู้ใช้ยังไม่บันทึก
      ref: packages/extension/src/chat/bridge.ts#readTextFile

    - id: search
      lane: tool
      at: executor
      alongside: true
      do: >-
        `grep` และ `glob` รัน ripgrep บนดิสก์ใน process ของ engine ก่อนค้นจะขอ buffer ที่ยังไม่บันทึกจาก editor
        ด้วยคำขอ `_gcode/unsavedBuffers` แล้วค้นบนสำเนาของ buffer เหล่านั้นแทนไฟล์บนดิสก์
      ref: packages/engine/src/tools/ripgrep.ts#searchWorkspace

    - id: each-ends
      lane: loop
      at: tools
      do: >-
        แต่ละ call ที่เสร็จส่ง `watcher.toolEnd` ทันที แผงจึงเห็นขั้นที่เสร็จก่อนได้ `read` รอให้ call ก่อนหน้าในชุดจบก่อน
        แล้วจึงจดเนื้อหาที่เห็นเป็นฐานสำหรับ `edit` ครั้งต่อไป
      ref: "packages/engine/src/drive.ts#\"watcher.toolEnd(use, status, todo);\""

    - id: status
      lane: server
      at: updates
      do: >-
        `toolEnd` กลายเป็น `session/update` ชนิด `tool_call_update` สถานะ `completed` ทีละ call ตามลำดับที่เสร็จ
      ref: packages/engine/src/serve.ts#editorTurn
      emits: [tool_call_update, completed]

    - use: tool-result-returns

    - id: next
      lane: loop
      at: step
      do: >-
        `loopStep` เห็น `tool-result` ล่าสุดจึงตัดสิน `call-model` โมเดลได้ผลทั้งห้าในข้อความ user เดียว เรียงตามลำดับที่ขอ
      ref: packages/core/src/loop.ts#loopStep
      emits: [call-model]
      phase: calling-model
      end: { turn: continues, reason: call-model }
---

การอ่านที่ไม่เปลี่ยนอะไรและไม่ต้องถามใครรันพร้อมกันได้ ส่วนอย่างอื่นรันทีละตัว `nextToolBatch` ตัดชุดตามลำดับที่โมเดลขอ
ชุดหนึ่งเป็นการอ่านติดกันได้ถึง 8 ตัว หรือเป็น call อื่นตัวเดียว

| call | รันพร้อมตัวอื่นได้เมื่อ |
| --- | --- |
| `read` | path ไม่ใช่ไฟล์ลับ และไม่ใช่ path นอก workspace (เช่น path เต็มหรือ `..`) |
| `grep`, `glob`, `list` | เสมอ ไฟล์ลับถูกข้ามหรือปฏิเสธโดยไม่ถาม |
| `bash`, `edit`, `web_fetch`, call ที่อาจถามผู้ใช้ | ไม่ได้ รันชุดละตัว |

สิ่งที่ควรสังเกต

- **เห็นเสร็จเร็ว บันทึกทีหลัง** แผงเห็นแต่ละขั้นเสร็จทันทีที่ call นั้นจบ แต่ข้อความผลไปถึงแผงเมื่อทั้งชุดจบและถูกบันทึกแล้ว
  ผลใน log เรียงตามลำดับที่โมเดลขอ ไม่ใช่ลำดับที่เสร็จ
- **ไฟล์ที่ยังไม่บันทึก** ทั้ง `read` และ `grep` เห็นการแก้ที่ผู้ใช้ยังไม่บันทึก `read` ได้ข้อความจาก buffer
  ส่วน `grep` ค้นสำเนาของ buffer ที่ editor ส่งมา
- **ในแผง** `read` ที่ติดกันรวมเป็นขั้นเดียวที่มีชิปไฟล์ละอัน ส่วน `grep` และ `glob` เป็นขั้นของตัวเอง
