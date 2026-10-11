---
title: รันคำสั่งเบื้องหลัง
description: โมเดลรันคำสั่งที่ไม่จบเองด้วย run_in_background harness เปิดงาน bg-1 ใน sandbox แล้วคืนผลทันที งานรันต่อขณะที่ turn ทำงานอื่น
tableOfContents: false
sidebar:
  order: 4
scenario:
  surface: vscode
  given:
    - turn กำลังทำงานในโหมด Ask หรือ Auto
    - session นี้ยังไม่มีงานเบื้องหลัง ไม่มี hook และไม่มีกฎของ workspace ที่ตรงกับคำสั่ง
  trigger: >-
    โมเดลขอเรียก `bash` ด้วย `pnpm tsc --watch` และ `run_in_background: true`
  covers: [tool.bash-background]
  related: [tool.bash-safe-runs, bg.command-ends-wakes, perm.plan-edit-refused]
  steps:
    - id: asks
      lane: model
      do: >-
        โมเดลขอรัน `pnpm tsc --watch` เป็นงานเบื้องหลัง เพราะคำสั่งนี้เฝ้าไฟล์และไม่จบเอง จบคำตอบด้วย `stop_reason: tool_use`
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

    - id: checks
      lane: tool
      at: executor
      do: >-
        `bash` เห็น `run_in_background` จึงข้ามการตรวจ `sleep` นำหน้าและการเปิด dev server ซึ่งปฏิเสธเฉพาะคำสั่งที่รันแบบรอผล
      ref: "packages/engine/src/tools/agent.ts#\"const background = run_in_background ? tools.background : undefined;\""

    - id: rules
      lane: policy
      at: rules
      do: >-
        `approveCommand` ตรวจคำสั่งเบื้องหลังด้วยกฎชุดเดียวกับคำสั่งปกติ ต่างกันข้อเดียวคือโหมด Plan ปฏิเสธงานเบื้องหลังทั้งหมด
        `pnpm tsc --watch` ไม่ติดกฎใด จึงไม่มีการ์ดและไม่มี classifier
      ref: "packages/engine/src/tools/agent.ts#\"const approveCommand = async (command: string, ctx: ToolContext, background: boolean)\""

    - id: start
      lane: tool
      at: sandbox
      do: >-
        `BackgroundJobs.start` ตั้งชื่องานเป็น `bg-1` (รันพร้อมกันได้สูงสุด 4 งานต่อ session) เปิดคำสั่งใน sandbox
        โดยไม่มีเวลาสูงสุด และเขียน output ทั้งหมดลงไฟล์ `background/bg-1.log` ในที่เก็บของ session
      ref: packages/engine/src/background.ts#BackgroundJobs.start
      emits: [bg-1]

    - id: changed
      lane: server
      at: updates
      do: >-
        `backgroundShared` ส่งสถานะของงานไปที่แผง Tasks และส่ง `tool_call_update` ที่มี `BACKGROUND_META`
        ให้หน้าต่างที่แสดง session นี้ ทุกครั้งที่งานเปลี่ยนสถานะหรือพิมพ์ output
      ref: packages/engine/src/background-hooks.ts#backgroundShared
      emits: [tool_call_update, BACKGROUND_META]

    - id: action
      lane: editor
      at: chat
      alongside: true
      do: >-
        `updateActions` เห็น `BACKGROUND_META` จึงส่ง action `background` ที่ผูกกับ call ของ `bash`
      ref: packages/extension/src/chat/session-updates.ts#updateActions
      emits: [background]

    - id: row
      lane: panel
      at: rail
      alongside: true
      do: >-
        ใต้กล่องของคำสั่งขึ้นแถวสถานะงานพร้อมปุ่ม Stop ของงานนั้นเอง ซึ่งไม่ใช่ปุ่ม Stop ของ turn
      sees: >-
        แถว "Running in background as bg-1" ไอคอนจุดทึบ และปุ่ม [Stop] (ชี้แล้วขึ้น "Stop bg-1: SIGTERM, then SIGKILL")
      ref: packages/extension/src/chat/render.ts#jobRow

    - id: returns
      lane: tool
      at: executor
      do: >-
        `bash` คืนผลทันทีโดยไม่รอคำสั่ง ข้อความผลบอกชื่องาน ที่อยู่ไฟล์ output และบอกโมเดลว่าไม่ต้องคอยถาม
        ("Started background command bg-1. ... Geno tells you when it ends, so do not poll it.")
      ref: packages/core/src/background.ts#backgroundStartText

    - use: tool-result-returns

    - id: next
      lane: loop
      at: step
      do: >-
        `loopStep` เห็น `tool-result` ล่าสุดจึงตัดสิน `call-model` โมเดลทำงานอื่นต่อขณะที่ `bg-1` ยังรันอยู่
      ref: packages/core/src/loop.ts#loopStep
      emits: [call-model]
      phase: calling-model
      end: { turn: continues, reason: call-model }
---

งานเบื้องหลังเป็นของ engine ไม่ใช่ของ turn มันรันต่อหลัง turn จบ และแสดงในแผง Tasks จนกว่าจะจบหรือถูกหยุด

| ทำอะไรกับงาน | ใช้อะไร |
| --- | --- |
| อ่าน output | `bash_output` หรือ `read` ไฟล์ output |
| รอบรรทัดที่ต้องการ เช่น "listening" | `monitor` |
| หยุดงาน | `task_stop` (โมเดล) หรือปุ่ม Stop ใต้กล่องคำสั่ง (ผู้ใช้) |

สิ่งที่ควรสังเกต

- **sandbox เดียวกับคำสั่งปกติ** งานเบื้องหลังเขียนได้เฉพาะใน workspace และไดเรกทอรีชั่วคราว และใช้เครือข่ายไม่ได้ถ้าไม่ได้อนุญาตโดเมนไว้
  ความต่างคือไม่มีเวลาสูงสุด
- **การจบของงานกลับมาหาโมเดลเอง** เมื่อ `bg-1` จบ engine ส่งข่าวเข้า inbox ของ session ซึ่ง `deliver()` บันทึกที่จุดปลอดภัยถัดไป
  หรือปลุก session ขึ้นมาใหม่ถ้าไม่มี turn ทำงาน
- **โหมด Plan ไม่มีงานเบื้องหลัง** `approveCommand` ปฏิเสธด้วย `ToolError` ก่อนดูกฎใดๆ
  ("background commands are not available: ...")
