---
title: "สลับโหมดระหว่าง turn"
description: ผู้ใช้เปลี่ยนจาก Ask เป็น Auto ขณะที่ turn ทำงาน engine ใช้โหมดใหม่กับ call ถัดไปทันที และบอก model ที่จุดปลอดภัยถัดไป
tableOfContents: false
sidebar:
  order: 3
scenario:
  surface: vscode
  given:
    - session อยู่ในโหมด Ask และ turn กำลังรัน `pnpm test` ซึ่งอยู่ใน safe list
  trigger: >-
    ผู้ใช้คลิกปุ่มโหมด "Ask" ในช่องพิมพ์ แล้วเลือก Auto จากเมนู
  covers: [perm.mode-switch-mid-turn]
  related: [perm.auto-classifier-allows, perm.ask-allow, sess.effort-change, perm.plan-start-building]
  steps:
    - id: choose
      lane: user
      beat:
        title: "คุณเลือก Auto ระหว่าง turn ทำงาน"
        text: >-
          turn กำลังรัน `pnpm test` ในโหมด Ask คุณคลิกปุ่มโหมดในช่องพิมพ์แล้วเลือก Auto แผงส่งคำขอไปที่ VS Code
          ปุ่มยังไม่เปลี่ยนจนกว่า engine จะยืนยัน
        from: you
        to: panel
      do: ผู้ใช้เปิดเมนูโหมดแล้วเลือก Auto ระหว่างที่ turn ยังทำงาน
      phase: running-tools

    - id: post
      lane: panel
      at: composer
      do: >-
        `modePicker` ปิดเมนูแล้วโพสต์ `set-mode` ไปให้ extension host ปุ่มยังไม่เปลี่ยนจนกว่า engine จะยืนยัน
      ref: packages/extension/src/chat/modes.ts#modePicker
      emits: [set-mode]

    - id: request
      lane: editor
      at: chat
      beat:
        title: "VS Code ขอเปลี่ยนโหมด"
        text: >-
          VS Code ขอ engine เปลี่ยนโหมดของ session นี้เป็น Auto
        from: panel
        to: engine
      do: >-
        `Chat.setMode` ส่งคำขอ ACP `session/set_mode` พร้อม `modeId: auto` ไปที่ engine
      ref: packages/extension/src/chat/chat.ts#Chat.setMode

    - id: switch
      lane: server
      at: sessions
      beat:
        title: "Geno เปลี่ยนโหมดทันที"
        text: >-
          engine เปลี่ยนโหมดทันทีโดยไม่รอให้ turn จบ ยืนยันกลับไป และบันทึกการเปลี่ยนโหมดลงบันทึกของ session
        from: engine
        to: panel
      do: >-
        `switchMode` เปลี่ยนโหมดใน `modes` ทันที ส่ง `current_mode_update` กลับ
        แล้วบันทึก event `mode` ลง log ข้าง turn ที่กำลังทำงาน (ไม่รอให้ turn จบ)
      ref: "packages/engine/src/serve.ts#\"const switchMode = async (client: acp.AgentContext, sessionId: string, mode: SessionMode) => {\""
      emits: [current_mode_update, mode]

    - id: confirmed
      lane: editor
      at: chat
      alongside: true
      do: >-
        `current_mode_update` ของ session ที่แสดงอยู่ทำให้ `remode` ส่งโหมดใหม่ให้ webview
      ref: "packages/extension/src/chat/chat.ts#\"if (update.sessionUpdate === 'current_mode_update') {\""

    - id: shown
      lane: panel
      at: composer
      beat:
        title: "ปุ่มโหมดเปลี่ยนเป็น Auto"
        text: >-
          ปุ่มโหมดในช่องพิมพ์เปลี่ยนจาก Ask ไอคอนโล่ เป็น Auto ไอคอนสายฟ้า
        from: panel
        to: you
        sees: { kind: composer, state: working, header: working }
      alongside: true
      do: ปุ่มโหมดเปลี่ยนชื่อและไอคอน
      sees: ปุ่มโหมดในช่องพิมพ์เปลี่ยนจาก "Ask" (ไอคอนโล่) เป็น "Auto" (ไอคอนสายฟ้า)
      ref: packages/extension/src/chat/modes.ts#modePicker

    - id: per-call
      lane: policy
      at: settle
      beat:
        title: "Call ถัดไปใช้โหมดใหม่"
        text: >-
          Geno อ่านโหมดทุกครั้งที่ตัดสิน call ไม่ได้จำโหมดตอน turn เริ่ม คำสั่งนอกรายการปลอดภัยตัวถัดไปจึงไปที่
          classifier แทนการ์ด ส่วน `pnpm test` ที่รันอยู่ไม่ได้รับผลใดๆ
        from: engine
        to: engine
      do: >-
        `Approval` ของ turn นี้อ่านโหมดผ่าน `mode()` ทุกครั้งที่ตัดสิน call ไม่ได้จำโหมดตอน turn เริ่ม
        คำสั่งนอก safe list ตัวถัดไปใน turn นี้จึงไปที่ classifier แทนการ์ด ส่วน `pnpm test` ที่รันอยู่แล้วไม่ได้รับผลใดๆ
      ref: "packages/engine/src/serve.ts#\"const approval: Approval = {\""

    - use: tool-result-returns
      beat:
        title: "pnpm test จบ ผลกลับมาที่แชต"
        text: >-
          คำสั่งจบ Geno บันทึกผลแล้วส่งไปที่แชต ขั้นต่อไปคือเรียก model
        from: engine
        to: panel
        sees: { kind: step, label: pnpm test, status: done }

    - id: decide
      lane: loop
      at: step
      do: >-
        `loopStep` เห็น `tool-result` ล่าสุดจึงตัดสิน `call-model`
      ref: packages/core/src/loop.ts#loopStep
      emits: [call-model]
      phase: calling-model

    - id: notice
      lane: loop
      at: drive
      beat:
        title: "Geno บอก model ว่าโหมดเปลี่ยน"
        text: >-
          ที่จุดปลอดภัยก่อนเรียก model Geno เห็นว่าโหมดต่างจากที่ model รู้ จึงเพิ่มประกาศต่อจากผลของ tool
          ประกาศนี้ไม่ขึ้นในแชต ใน run จริงด้านล่างโหมดถูกตั้งก่อนข้อความแรก แต่ประกาศมีข้อความเดียวกัน
        from: engine
        to: model
        sees:
          kind: payload
          source: docs/results/real-usecases/runs/A09-auto-classifier/1/requests.jsonl#seq=6
          select: messages[-1].content[3]
      do: >-
        ที่จุดปลอดภัย `deliver()` ถาม `noticeFor` ว่าโหมดตอนนี้ต่างจากที่ model รู้หรือไม่ ต่างจริง จึงบันทึก event `notice`
        ที่มีโหมด Auto ซึ่งคำขอถัดไปแสดงเป็นข้อความ `MODE_NOTICES.auto` ต่อจากผลของ tool ประกาศนี้ไม่แสดงในแผง
      ref: packages/core/src/notice.ts#noticeFor
      emits: [notice]

    - id: reads
      lane: model
      beat:
        title: "Model ทำต่อในโหมด Auto"
        text: >-
          คำขอยังส่ง tool ชุดเดิมและ system prompt เดิม prompt cache จึงไม่หลุด
          model ทำงานต่อโดยรู้ว่าตอนนี้ถามคุณด้วยฟอร์มไม่ได้แล้ว
        from: model
        to: engine
        end: "turn ทำต่อในโหมดใหม่"
      do: >-
        คำขอยังส่ง tool ชุดเดิมและ system prompt เดิม prompt cache จึงไม่หลุด model อ่าน
        "[Geno] The user switched this session to Auto mode. ..." แล้วทำงานต่อโดยรู้ว่า `ask_user` ใช้ไม่ได้แล้ว
      ref: packages/core/src/notice.ts#MODE_NOTICES
      end: { turn: continues, reason: call-model }
---

โหมดมีผลสองที่ และเวลาที่มีผลต่างกัน

| ที่ไหน | เมื่อไร |
| --- | --- |
| การตัดสินของนโยบาย (การ์ด classifier การปฏิเสธ) | call ถัดไปที่ถูกตัดสิน แม้อยู่ใน turn เดิม |
| สิ่งที่ model รู้ | การเรียก model ครั้งถัดไป ผ่าน `notice` ที่จุดปลอดภัย |

สิ่งที่ควรสังเกต

- **ทุกโหมดได้ tool เหมือนกัน** Plan ไม่ได้เอา `edit` ออกจากคำขอ มันปฏิเสธตอน call รัน
  การสลับโหมดจึงไม่เปลี่ยนไบต์ของ system prompt และรายการ tool
- **การ์ดที่เปิดอยู่ไม่เปลี่ยน** ถ้าการ์ดขออนุญาตรออยู่ตอนสลับเป็น Auto การ์ดนั้นยังรอผู้ใช้ตอบ โหมดใหม่มีผลกับ call ที่ถูกตัดสินหลังจากนี้
- **effort ต่างจากโหมด** การเปลี่ยน effort ระหว่าง turn มีผลกับรอบถัดไป ไม่ใช่การเรียก model ครั้งถัดไป
  ดู [เปลี่ยน effort](/scenarios/sess/model-effort/)

อ่านต่อที่ [โหมด Auto ให้ classifier ตัดสินคำสั่ง](/scenarios/perm/auto-classifier/)
