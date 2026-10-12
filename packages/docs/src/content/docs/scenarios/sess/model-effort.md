---
title: "เปลี่ยน effort หรือเปลี่ยน model"
description: เมนู model ในช่องพิมพ์เปลี่ยนได้สองอย่างที่มีผลต่างกัน effort เป็นของ session และมีผลจากรอบถัดไป ส่วน model เป็นการตั้งค่าของ VS Code ที่เปลี่ยน engine และมีผลกับแชตใหม่
tableOfContents: false
sidebar:
  order: 6
scenario:
  surface: vscode
  given:
    - แชตนี้มี turn ที่จบแล้ว และไม่มี turn ทำงาน
    - provider ของแชตคือ Model Studio และมีอีก model ของ provider เดียวกันพร้อมใช้
  trigger: >-
    ผู้ใช้คลิกปุ่มชื่อ model ในช่องพิมพ์ เมนูแสดง backend model ของ provider ที่พร้อมใช้ และระดับ effort
  covers: [sess.effort-change, sess.model-change]
  related: [perm.mode-switch-mid-turn, start.set-api-key, sess.new-chat]
  steps:
    - id: menu
      beat:
        title: คุณเปิดเมนู model ในช่องพิมพ์
        text: เมนูรวม backend ที่คุยกับแชต model ของ Geno และ effort ของ session สองอย่างหลังมีผลต่างกัน
        from: you
        to: panel
        ask: คุณเลือกอะไร
      lane: panel
      at: composer
      do: >-
        เมนู model รวมสามเรื่องไว้ที่เดียว: backend ที่ใช้คุยกับแชต model ของ Geno และ effort ของ session
      ref: packages/extension/src/chat/composer-view.ts#modelMenu
      phase: idle

    - id: pick
      lane: user
      do: ผู้ใช้เลือกรายการหนึ่งในเมนู
      fork:
        ask: ผู้ใช้เลือกอะไร
        options:
          - id: effort
            label: effort high
            steps:
              - lane: panel
                beat:
                  title: คุณเลือก effort high
                  text: แชตส่งค่าใหม่ให้ engine
                  from: you
                  to: panel
                at: composer
                do: เมนูโพสต์ `set-effort` พร้อมค่า `high`
                ref: "packages/extension/src/chat/composer-view.ts#\"if (!e.current) post({ type: 'set-effort', value: e.value });\""
                emits: [set-effort]
              - lane: editor
                at: chat
                do: >-
                  `ComposerHost` ส่งคำขอ ACP `session/set_config_option` ที่มี `configId` ของ effort ไปที่ engine
                ref: "packages/extension/src/chat/composer-host.ts#\"const { configOptions } = await connection.agent.request(acp.methods.agent.session.setConfigOption, { sessionId, configId: EFFORT_CONFIG_ID, value });\""
              - lane: server
                beat:
                  title: Geno บันทึก effort ลง log
                  text: effort เป็นของ session ถ้า turn ทำงานอยู่ Geno บันทึกข้าง turn นั้น ช่องพิมพ์แสดง effort ใหม่
                  from: engine
                  to: engine
                  sees: ปุ่ม model ในช่องพิมพ์บอก effort "high"
                at: sessions
                do: >-
                  engine บันทึก event `effort` ลง log ของ session (ถ้า turn ทำงานอยู่ บันทึกข้าง turn นั้น)
                  แล้วตอบด้วยตัวเลือก effort ชุดใหม่
                ref: "packages/engine/src/serve.ts#\"await logSetting(sessionId, { kind: 'effort', effort });\""
                emits: [effort]
              - lane: panel
                at: composer
                alongside: true
                do: ช่องพิมพ์แสดง effort ใหม่ข้างชื่อ model
                sees: ปุ่ม model ในช่องพิมพ์บอก effort "high"
                ref: packages/extension/src/chat/composer-view.ts#modelMenu
              - lane: loop
                beat:
                  title: มีผลตั้งแต่การเรียก model ครั้งถัดไป
                  text: ทุกการเรียก model อ่าน effort ล่าสุดจาก log แล้วปรับระดับตามชนิดของการเรียก
                  from: engine
                  to: model
                  end: effort ใหม่มีผล
                at: model-call
                do: >-
                  ตั้งแต่รอบถัดไป ทุกการเรียก model อ่าน effort ล่าสุดจาก log ผ่าน `withTurnEffort` ซึ่งขยับระดับตาม policy ของชนิดการเรียก
                  (หลัง prompt หลัง tool หรือหลัง tool ล้ม) แล้วส่งเป็น `output_config.effort` สำหรับ model ที่รองรับ effort
                ref: packages/core/src/effort.ts#withTurnEffort
                end: { turn: none }
          - id: model
            label: model อื่นของ provider เดียวกัน
            steps:
              - lane: panel
                beat:
                  title: คุณเลือก model อื่น
                  text: model ของ Geno เป็นการตั้งค่าของ VS Code ไม่ใช่ของ session VS Code เขียนการตั้งค่าระดับผู้ใช้ โดยไม่ส่งอะไรถึง engine
                  from: you
                  to: panel
                at: composer
                do: เมนูโพสต์ `set-model` พร้อม provider และ model
                ref: "packages/extension/src/chat/composer-view.ts#\"if (!m.current) post(m.pick.kind === 'geno' ? { type: 'set-model', provider: m.pick.provider, model: m.pick.model } : { type: 'set-agent-model', value: m.pick.value });\""
                emits: [set-model]
              - lane: editor
                at: vscode-ui
                do: >-
                  `setRole` เขียนการตั้งค่า `gcode.provider` และ `gcode.model` ระดับผู้ใช้ ไม่ได้ส่งอะไรถึง engine
                ref: packages/extension/src/chat/settings-host.ts#setRole
              - lane: editor
                beat:
                  title: ส่วนขยายเปลี่ยนไปใช้ engine ตัวใหม่
                  text: การตั้งค่าที่ engine ใช้เปลี่ยน ส่วนขยายจึงตัดการเชื่อมต่อ และเปิด engine ตัวใหม่ตามการตั้งค่าชุดใหม่ ปุ่มในช่องพิมพ์ขึ้นชื่อ model ใหม่
                  from: panel
                  to: engine
                  sees: ปุ่ม model ในช่องพิมพ์เปลี่ยนเป็นชื่อ model ใหม่
                at: engine-link
                do: >-
                  การตั้งค่าที่ engine ใช้เปลี่ยน `resetEngine` จึงตัดการเชื่อมต่อ socket ครั้งต่อไปที่ต้องใช้ engine
                  ส่วนขยายคำนวณที่อยู่ socket ใหม่จาก hash ของการตั้งค่าชุดใหม่ และเปิด engine ตัวใหม่ถ้ายังไม่มี
                ref: packages/extension/src/chat/chat.ts#Chat.resetEngine
              - lane: panel
                at: composer
                alongside: true
                do: แผงได้ action `model` ที่มีชื่อ model ใหม่
                sees: ปุ่ม model ในช่องพิมพ์เปลี่ยนเป็นชื่อ model ใหม่
                ref: packages/extension/src/chat/composer-view.ts#modelMenu
              - lane: server
                beat:
                  title: engine ตัวเดิมปิดตัวเอง
                  text: engine ตัวเดิมไม่มีหน้าต่างเชื่อมแล้ว มันปิดตัวหลังว่าง 10 วินาที engine ตัวใหม่รับแชตที่เปิดอยู่ model ใหม่มีผลกับแชตใหม่
                  from: engine
                  to: engine
                  end: model ใหม่ใช้กับแชตใหม่
                at: sessions
                do: >-
                  engine ตัวเดิมไม่มีหน้าต่างเชื่อมแล้ว มันปิดตัวเองหลังว่างและไม่มีการเชื่อมต่อ 10 วินาที
                  engine ตัวใหม่รับแชตที่เปิดอยู่ด้วย `session/resume` แต่ provider และ model ของ session อ่านจาก `session-start` ใน log
                  แชตนี้จึงยังใช้ model เดิม model ใหม่มีผลกับแชตที่สร้างหลังจากนี้
                ref: packages/engine/src/chat.ts#resumeSession
                end: { turn: none }
---

สองตัวเลือกในเมนูเดียวกันเก็บไว้คนละที่ จึงมีผลต่างกัน

| เปลี่ยน | เก็บที่ | มีผลกับ | เมื่อไร |
| --- | --- | --- | --- |
| effort | event `effort` ใน log ของ session | แชตนี้ | รอบถัดไป |
| model | การตั้งค่า `gcode.model` ของ VS Code | แชตใหม่ | หลัง engine ตัวใหม่เริ่ม |

สิ่งที่ควรสังเกต

- **effort ระหว่าง turn ไม่มีผลกับ turn นั้น** engine บันทึก effort ข้าง turn ที่ทำงานทันที แต่ `drive` ทำงานกับสำเนาของ event
  ที่อ่านตอนเริ่มรอบ การเรียก model ที่เหลือของ turn นั้นจึงใช้ effort เดิม ต่างจากโหมดที่มีผลกับ call ถัดไปทันที
- **ชื่อในช่องพิมพ์ไม่ตรงกับ model ของแชตที่เปิดอยู่** หลังเปลี่ยน model ปุ่มแสดงชื่อ model ใหม่
  แต่ turn ถัดไปของแชตที่เปิดอยู่ยังเรียก model เดิมที่บันทึกไว้ตอนสร้าง session ผู้ใช้ต้องเปิดแชตใหม่จึงได้ model ใหม่
- **เปลี่ยน provider อาจทำให้แชตเดิมใช้ไม่ได้** engine ตัวใหม่ได้คีย์ของ provider ที่เลือกใหม่ (และของบทบาทอื่นที่ตั้งไว้)
  ถ้าแชตเดิมใช้ provider อื่น ตามโค้ด `resumeSession` จะหาคีย์ของ provider เดิมไม่พบในสภาพแวดล้อมของ engine ตัวใหม่
  ทัวร์นี้เลือก model ของ provider เดียวกันจึงไม่เจอกรณีนี้
