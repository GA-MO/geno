---
title: "reload หน้าต่างขณะ turn ทำงาน"
description: ผู้ใช้ reload หน้าต่าง VS Code ระหว่างที่ turn ทำงาน engine เป็นคนละ process จึงทำงานต่อ หน้าต่างใหม่โหลด session เล่นซ้ำสิ่งที่เกิดขึ้น แล้วรับช่วง turn จนจบ
tableOfContents: false
sidebar:
  order: 3
scenario:
  surface: vscode
  given:
    - turn ของแชตนี้กำลังทำงาน model เขียนคำตอบไปได้ครึ่งหนึ่ง
    - หน้าต่างนี้เป็นหน้าต่างเดียวที่แสดง session นี้
  trigger: >-
    ผู้ใช้รันคำสั่ง "Developer: Reload Window" (หรือปิดหน้าต่างแล้วเปิดโฟลเดอร์เดิมใหม่)
  covers: [sess.reload-while-running]
  related: [sess.leave-running, sess.open-history, start.open-window, ctl.stop-while-streaming]
  steps:
    - id: reload
      beat:
        title: คุณ reload หน้าต่าง
        text: 'model เขียนคำตอบไปได้ครึ่งหนึ่ง คุณรัน "Developer: Reload Window"'
        from: you
        to: panel
      lane: user
      do: ผู้ใช้ reload หน้าต่าง
      phase: calling-model

    - id: dispose
      beat:
        title: ส่วนขยายตัดการเชื่อมต่อ แต่ engine อยู่ต่อ
        text: engine เป็น process แยกที่อยู่ต่อแม้หน้าต่างปิด
        from: panel
        to: engine
      lane: editor
      at: engine-link
      do: >-
        extension host เดิมปิดตัว `Engine.dispose` ตัดการเชื่อมต่อ socket แต่ไม่ปิด engine
        engine ถูกเปิดเป็น process แยกที่อยู่ต่อแม้หน้าต่างปิด
      ref: packages/extension/src/chat/engine.ts#Engine.dispose

    - id: keeps
      beat:
        title: turn ทำงานต่อโดยไม่มีคนดู
        text: ไม่มีใครแสดง session นี้ engine จึงทิ้งอัปเดตสด แต่ log เก็บทุกอย่าง และ engine เก็บ event ของ turn นี้ไว้เล่นซ้ำ
        from: engine
        to: engine
      lane: server
      at: updates
      do: >-
        engine เห็นว่าการเชื่อมต่อปิด ไม่มี editor แสดง session นี้แล้ว `Viewers.notify` จึงทิ้งอัปเดตไป
        แต่ turn ทำงานต่อ log เก็บทุก event และ `live` เก็บ event ของ turn นี้กับข้อความที่ stream มาแล้วแต่ยังไม่ลง log
      ref: packages/engine/src/viewers.ts#Viewers.notify

    - id: activate
      beat:
        title: หน้าต่างใหม่ต่อ engine ตัวเดิม
        text: ส่วนขยายตัวใหม่เห็นว่าหน้าต่างนี้เคยแสดง session ไว้ จึงต่อ engine ทันที การตั้งค่าเหมือนเดิม จึงได้ engine ตัวเดิม
        from: panel
        to: engine
      lane: editor
      at: engine-link
      do: >-
        extension host ใหม่เริ่มทำงาน เห็นว่าหน้าต่างนี้เคยแสดง session ไว้ จึงเชื่อม engine ทันทีโดยไม่รอผู้ใช้
        การตั้งค่าเหมือนเดิม hash เดิม จึงต่อ socket ของ engine ตัวเดิม แล้วส่ง ACP `initialize`
      ref: "packages/extension/src/extension.ts#\"if ((await chat.storedSession()) === undefined) return;\""
      emits: [initialize]

    - id: load
      beat:
        title: แชตขอโหลด session ที่จำไว้
        text: แชตขอ engine เล่น session นี้ซ้ำ
        from: panel
        to: engine
      lane: editor
      at: chat
      do: >-
        `openSession` เห็น session ที่จำไว้ จึงให้ `load` ส่งคำขอ ACP `session/load`
      ref: packages/extension/src/chat/chat.ts#Chat.load

    - id: replay
      beat:
        title: Geno เล่นซ้ำ turn ที่กำลังทำงาน
        text: engine ส่ง event ของ turn ข้อความที่ stream ค้างไว้ การรอ และงานเบื้องหลัง อัปเดตสดรอจนเล่นซ้ำจบ แชตจึงเห็นตามลำดับ
        from: engine
        to: panel
      lane: server
      at: sessions
      do: >-
        `session/load` เล่นซ้ำ event ของ turn ที่กำลังทำงานจาก `live` ตามด้วยข้อความที่ stream ค้างไว้ การรอ และงานเบื้องหลัง
        โดยกักอัปเดตสดไว้ข้างหลังการเล่นซ้ำ editor จึงเห็นแต่ละอัปเดตครั้งเดียวและตามลำดับ
        คำตอบมี `RUNNING_META` บอกว่า turn ยังทำงาน
      ref: "packages/engine/src/serve.ts#\"const replayed = viewers.show(id, self(), true);\""
      emits: [RUNNING_META]

    - id: adopt
      beat:
        title: แผงรับช่วง turn
        text: แผงเห็นว่า turn ยังทำงาน มันรับ turn เป็นของตัว ปุ่ม Stop ใช้ได้ ข้อความครึ่งแรกกลับมาแล้วข้อความใหม่ต่อท้าย
        from: panel
        to: you
        sees: บทสนทนาเดิม หัวข้อ "working" ข้อความครึ่งแรกของคำตอบตามด้วยส่วนที่ stream ต่อ และปุ่ม Stop แทนปุ่ม Send
      lane: editor
      at: chat
      do: >-
        `load` แสดงบทสนทนาที่เล่นซ้ำ เห็น `RUNNING_META` และงานใน Tasks ยังทำงาน จึงรับช่วง turn:
        จำ turn นี้เป็นของแผง ปุ่ม Stop ใช้ได้ แต่ไม่มีคำขอ `session/prompt` ค้างอยู่ เพราะคำขอเดิมเป็นของการเชื่อมต่อที่ปิดไปแล้ว
      ref: "packages/extension/src/chat/chat.ts#\"const adopt = running && (task === undefined || isLive(task.status));\""

    - id: shown
      lane: panel
      at: rail
      alongside: true
      do: >-
        แผงได้ action `reset` ที่มีบทสนทนาทั้งหมด turn สุดท้ายยังไม่จบ ข้อความที่ model เขียนไว้กลับมา แล้วข้อความใหม่ต่อท้าย
      sees: >-
        บทสนทนาเดิม หัวข้อ "working" ข้อความครึ่งแรกของคำตอบตามด้วยส่วนที่ stream ต่อ และปุ่ม Stop แทนปุ่ม Send
      ref: packages/extension/src/chat/webview.ts#render

    - id: ends
      beat:
        title: turn จบ Geno บอกผ่าน Tasks
        text: คำขอเดิมที่เริ่ม turn อยู่กับการเชื่อมต่อที่ปิดไปแล้ว engine จึงบอกการจบผ่านงานในแผง Tasks
        from: engine
        to: panel
      lane: server
      at: tasks
      do: >-
        turn จบ engine ส่งคำตอบของ `session/prompt` ไปที่การเชื่อมต่อเดิมไม่ได้ จึงบอกการจบผ่านงานในแผง Tasks:
        notification `TASK_UPDATE_METHOD` ที่สถานะไม่ใช่กำลังทำงานแล้ว พร้อม usage
      ref: "packages/engine/src/serve.ts#\"if (peer.tasks) void connection.client.notify(TASK_UPDATE_METHOD, update).catch(() => {});\""
      emits: [TASK_UPDATE_METHOD]
      phase: ending

    - id: adopted-end
      lane: editor
      at: chat
      do: >-
        `TaskHost.updated` เห็นงานของ session ที่แสดงอยู่เปลี่ยนจากกำลังทำงานเป็นจบ `adoptedEnded` จึงส่ง action `turn-end`
        ด้วยสถานะและ usage จากงานนั้น
      ref: packages/extension/src/chat/chat.ts#Chat.adoptedEnded
      emits: [turn-end]

    - id: footer
      beat:
        title: แผงปิด turn ตามปกติ
        text: หัวข้อบอกเวลา ท้าย turn มีแถวสรุป model token และค่าใช้จ่าย เหมือน turn ที่ส่งจากหน้าต่างนี้
        from: panel
        to: you
        sees:
          kind: composer
          state: idle
          header: worked for 1m 4s
        end: Turn จบ
      lane: panel
      at: rail
      do: >-
        turn ปิดเหมือน turn ที่ส่งจากหน้าต่างนี้ หัวข้อบอกเวลา และท้าย turn มี usage
      sees: หัวข้อ "worked for 1m 4s" ปุ่ม Send กลับมา และแถวสรุป model token และค่าใช้จ่าย
      ref: packages/extension/src/chat/rail.ts#headerOf
      end: { turn: done, reason: end_turn }
---

engine กับหน้าต่างเป็นคนละ process หน้าต่างที่ปิดไม่ได้หยุด turn ของมัน
สิ่งที่หายไปมีแค่การเชื่อมต่อ ซึ่งหน้าต่างใหม่สร้างใหม่และรับช่วงด้วยการเล่นซ้ำ

| อะไร | ระหว่างไม่มีหน้าต่าง | เมื่อหน้าต่างใหม่โหลด |
| --- | --- | --- |
| อัปเดตสด | ถูกทิ้ง | เล่นซ้ำจาก `live` |
| ข้อความที่ stream ค้าง | อยู่ใน `live.text` | ส่งเป็นข้อความเดียว |
| การ์ดขออนุญาตที่รอ | รอ editor ตัวใหม่ | ถามซ้ำในหน้าต่างใหม่ |
| การจบของ turn | ไม่มีใครรับคำตอบ | มาทางงานในแผง Tasks |

สิ่งที่ควรสังเกต

- **การ์ดถูกถามซ้ำ** `Viewers.ask` รอ editor ที่แสดง session แล้วถามใหม่ การ์ดที่ค้างตอน reload จึงขึ้นอีกครั้งในหน้าต่างใหม่
- **Stop ใช้ได้กับ turn ที่รับช่วง** แผงจำ turn ไว้พร้อมการเชื่อมต่อใหม่ ปุ่ม Stop จึงส่ง `session/cancel` ไปที่ engine ตามปกติ
  ต่างกันแค่ว่าการจบมาจากงานใน Tasks ไม่ใช่คำตอบของ `session/prompt`
