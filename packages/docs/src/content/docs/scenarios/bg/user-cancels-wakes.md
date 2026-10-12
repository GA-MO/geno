---
title: ผู้ใช้ยกเลิกการปลุก
description: ผู้ใช้กด Cancel บนงานที่รอถูกปลุกในแผง Tasks engine เลิกรอทุกอย่างของ session ลูกเบื้องหลังจบโดยไม่รายงาน monitor และการเฝ้า PR หยุด และสิ่งที่มาถึงแล้วก็ไม่ปลุก
tableOfContents: false
sidebar:
  order: 11
scenario:
  surface: vscode
  given:
    - turn ก่อนจบไปแล้ว session รอสามอย่าง ลูก `explore` แบบเบื้องหลัง monitor `wake-1` บน `bg-1` ที่ monitor เริ่มเอง และ wake-up `wake-2`
    - แผง Tasks แสดงงานของ session ว่า "Wakes on explore, a monitor on bg-1 and a wake-up at 14:30"
  trigger: >-
    ผู้ใช้เปลี่ยนใจ ไม่อยากให้ Geno กลับมาทำต่อเอง จึงกด Cancel บนแถวนั้น
  covers: [bg.user-cancels-wakes]
  related: [bg.task-stop-or-list, bg.wake-held-or-paused, bg.child-wakes-parent, sess.rewind]
  steps:
    - id: sees
      lane: panel
      at: tasks
      do: >-
        แถวของงานที่รอถูกปลุกมีป้าย "Waiting to wake" บรรทัดว่ารออะไร และปุ่ม Cancel
      sees: >-
        ป้าย "Waiting to wake" บรรทัด "Wakes on explore, a monitor on bg-1 and a wake-up at 14:30" และปุ่ม [Cancel]
        ที่มี tooltip "Stop waiting: nothing wakes this chat until you send it a message"
      ref: packages/extension/src/chat/lanes-panel.ts#tasksPanel
      phase: idle

    - id: click
      lane: user
      do: ผู้ใช้กด Cancel

    - id: post
      lane: editor
      at: chat
      do: >-
        แผงโพสต์ `task-wake-cancel` แล้ว `TaskHost` ส่งคำขอ ACP `_gcode/wakeCancel` พร้อม session id
      ref: packages/extension/src/chat/tasks-host.ts#TaskHost
      emits: [_gcode/wakeCancel]

    - id: cancel
      lane: server
      at: wakes
      do: >-
        `Wakes.cancel` เลิกรอทุกอย่างของ session: ลูกเบื้องหลังถูกปิดเสียงแล้ว abort จึงไม่มีรายงานมา
        monitor เลิกเฝ้าและหยุด `bg-1` ที่มันเริ่มเอง การเฝ้า PR หยุด นาฬิกาของ wake-up ถูกล้าง
        คำสั่งเบื้องหลังอื่นของ session ยังรันต่อ แต่ถูกจดว่าเงียบ จบแล้วไม่ปลุก
      ref: packages/engine/src/wakes.ts#Wakes.cancel

    - id: logged
      lane: server
      at: wakes
      do: >-
        engine บันทึกโน้ต `wake` ชนิด `cancelled` ลง log ของ session โน้ตนี้เป็นเส้นแบ่ง:
        สิ่งที่มาถึงก่อนหน้านี้แต่ยังไม่ได้ปลุกก็จะไม่ปลุกแล้ว และ engine ตัวถัดไปจะไม่รับช่วง wake-up ที่ค้างใน log
      ref: "packages/engine/src/serve.ts#\"await appendEvent(log.file, { kind: 'wake', seq: nextSeq(log.events), at: new Date().toISOString(), note: { kind: 'cancelled' } });\""
      emits: [wake, cancelled]

    - id: gate
      lane: server
      at: wakes
      do: >-
        `wakes.soon` ดูประตูอีกครั้ง `unwokenOf` เห็นโน้ต `cancelled` เป็นเส้นแบ่ง จึงไม่มีอะไรรอปลุก งานในแผง Tasks อัปเดต
      ref: packages/core/src/wake.ts#unwokenOf

    - id: child-ends
      lane: child@explore
      at: loop
      do: >-
        หลังจากนั้น explore ที่ถูก abort ปิดตัวเสร็จ จบแบบ `cancelled` `child-end` มาถึงทางกล่องข้อความและถูกบันทึกลง log หลังโน้ต `cancelled`
        ไม่มีรายงานให้โมเดลได้ยิน และ `child-end` ไม่ใช่สิ่งที่ปลุก
      ref: "packages/engine/src/subagents.ts#\"const report = async (text: string, ended: ChildEndNote | undefined) => {\""
      emits: [cancelled, child-end]

    - id: row
      lane: panel
      at: tasks
      do: >-
        แถวของงานไม่มีบรรทัดว่ารออะไรแล้ว ปุ่ม Cancel หายไป และงานกลับเป็นงานที่จบแล้วตามปกติ
      sees: แถวของ session ไม่มี "Wakes on ..." และไม่มีปุ่ม Cancel
      ref: packages/extension/src/chat/lanes-model.ts#taskRowOf
      end: { turn: none }
---

Cancel ในแผง Tasks คือคำตอบของผู้ใช้ต่อคำถามว่า "ให้ Geno กลับมาทำต่อเองไหม": ไม่
ทุกอย่างที่ session รอถูกปิด และ Geno จะไม่เริ่ม turn เองจนกว่าผู้ใช้จะส่งข้อความ

| สิ่งที่รอ | หลัง Cancel |
| --- | --- |
| ลูกเบื้องหลัง | abort ไม่มีรายงาน |
| monitor | เลิกเฝ้า คำสั่งที่ monitor เริ่มเองหยุดด้วย |
| wake-up | ไม่ดัง และไม่ถูกรับช่วงหลัง engine เริ่มใหม่ |
| การเฝ้า PR | หยุด |
| คำสั่งเบื้องหลังอื่น | ยังรัน แต่จบแล้วไม่ปลุก |

สิ่งที่ควรสังเกต

- **ต่างจาก `task_stop`** `task_stop` ของโมเดลหยุดทีละตัวและได้ผลกลับเป็นข้อความ Cancel ของผู้ใช้หยุดทุกตัวพร้อมกันและโมเดลไม่ได้รับรู้ทันที
  ครั้งหน้าที่โมเดลถูกเรียก log มี `child-end` แบบ cancelled ให้ `list_agents` เห็น
- **Rewind ใช้ทางเดียวกัน** การ rewind บทสนทนาเรียก `Wakes.cancel` เฉพาะสิ่งที่ turn ที่ถูกตัดเริ่มไว้
