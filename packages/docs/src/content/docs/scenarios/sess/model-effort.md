---
title: "เปลี่ยน effort หรือเปลี่ยน model"
description: เมนู model ในช่องพิมพ์เปลี่ยนได้สองอย่างที่มีผลต่างกัน effort เป็นของ session และมีผลจาก turn ถัดไป ส่วน model เป็นการตั้งค่าของ VS Code ที่เปลี่ยน engine และมีผลกับแชตใหม่
scenario:
  surface: vscode
  given:
    - แชตนี้มี turn ที่จบแล้ว และไม่มี turn ทำงาน
    - provider ของแชต (บริการที่ให้เรียก model ผ่าน API) คือ Model Studio และมีอีก model ของ provider เดียวกันพร้อมใช้
  trigger: >-
    ผู้ใช้คลิกปุ่มชื่อ model ในช่องพิมพ์ เมนูแสดง backend model ของ provider ที่พร้อมใช้ และระดับ effort
  covers: [sess.effort-change, sess.model-change]
  related: [perm.mode-switch-mid-turn, start.set-api-key, sess.new-chat]
  steps:
    - id: menu
      beat:
        title: คุณเปิดเมนู model ในช่องพิมพ์
        text: >-
          เมนูรวมสามเรื่อง backend คือตัวที่รันแชต (loop ของ Geno เองหรือ agent ภายนอกที่ engine รู้จัก)
          model คือ model ที่ Geno เรียก และ effort คือระดับที่บอก model ว่าให้คิดหนักแค่ไหน ตั้งแต่ `low` ถึง `max`
          ทัวร์นี้ดูสองอย่างหลัง (model และ effort) ซึ่งเก็บไว้คนละที่จึงมีผลต่างกัน
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
                  text: แผงส่งค่าใหม่ผ่าน VS Code ไปให้ engine เพราะ effort เป็นค่าของ session ซึ่ง engine ถือไว้
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
                  text: >-
                    engine บันทึก event `effort` ต่อท้าย session log ของแชตนี้ (ไฟล์ที่ Geno ต่อท้ายทุกเหตุการณ์ของแชต) แล้วตอบรายการระดับ effort ที่มีเครื่องหมายบอกระดับปัจจุบัน
                    ช่องพิมพ์แสดง effort ใหม่ ถ้า turn ทำงานอยู่ ค่าใหม่ถูกบันทึกลงไฟล์ทันที แต่ turn นั้นยังใช้ค่าเดิมจนจบ
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
                  title: มีผลตั้งแต่ turn ถัดไป
                  text: >-
                    ตอนเริ่ม turn ถัดไป Geno อ่าน log ซึ่งมี event `effort` ใหม่อยู่แล้ว ก่อนเรียก model ทุกครั้งใน turn นั้น
                    Geno ใส่ระดับที่คุณเลือกตรงๆ ลงใน request เป็น `output_config.effort` ถ้า model รองรับ effort
                    (ถ้าไม่รองรับ request ไม่มี field นี้)
                    การ์ดข้างล่างเป็นการบันทึกที่รัน Geno จริงกับ model จำลองที่ตอบตามบทที่เขียนไว้ก่อน บน qwen3.8-flash ซึ่งรองรับ effort การ์ดแรกคือ request แรกของ turn แรกซึ่งส่ง `medium` (request ที่สองของ turn นั้นส่งค่าเดียวกัน) การ์ดที่สองคือ request ของ turn ถัดไปหลังคุณเลือก high ซึ่งส่ง `high` ดูที่ไฮไลต์ของทั้งสองใบ
                  from: engine
                  to: model
                  sees:
                    - kind: payload
                      source: packages/docs/src/data/recorded/sess-model-effort.jsonl#line=2
                      collapse: [tools, system, messages]
                      highlight: [output_config.effort]
                    - kind: payload
                      source: packages/docs/src/data/recorded/sess-model-effort.jsonl#line=6
                      collapse: [tools, system, messages]
                      highlight: [output_config.effort]
                  end: effort ใหม่มีผล
                at: model-call
                do: >-
                  ทุกการเรียก model ใน turn อ่าน effort ล่าสุดจากสำเนา event ที่ `drive` คัดลอกจาก log ตอนเริ่ม turn ผ่าน `withTurnEffort`
                  ซึ่งใช้ policy `flat` ไม่ขยับระดับ (policy อื่นที่ลดระดับหลัง tool สำเร็จใช้แค่ใน eval)
                  แล้วส่งเป็น `output_config.effort` สำหรับ model ที่รองรับ effort
                ref: packages/core/src/effort.ts#withTurnEffort
                end: { turn: none }
          - id: model
            label: model อื่นของ provider เดียวกัน
            steps:
              - lane: panel
                beat:
                  title: คุณเลือก model อื่น
                  text: model ของ Geno เป็นการตั้งค่าของ VS Code (`gcode.provider` และ `gcode.model`) ไม่ใช่ของ session VS Code เขียนการตั้งค่าระดับผู้ใช้ โดยยังไม่ส่งอะไรถึง engine
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
                  text: >-
                    engine หนึ่งตัวเริ่มจากการตั้งค่าชุดหนึ่ง และส่วนขยายหา engine ด้วยที่อยู่ socket
                    (ไฟล์พิเศษที่ส่วนขยายใช้ต่อกับ engine เหมือนพอร์ตของ server) ที่คำนวณจากการตั้งค่า
                    การตั้งค่าเปลี่ยน ส่วนขยายจึงตัดการเชื่อมต่อกับ engine ตัวเดิม และเปิด engine ตัวใหม่ตามการตั้งค่าชุดใหม่เมื่อต้องใช้
                    ปุ่มในช่องพิมพ์ขึ้นชื่อ model ใหม่
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
                  text: >-
                    engine ตัวเดิมไม่มีหน้าต่างเชื่อมแล้ว มันปิดตัวหลังว่าง 10 วินาที engine ตัวใหม่เปิดแชตที่แสดงอยู่ต่อ
                    แต่แชตนี้อ่าน provider และ model จากบรรทัดแรกของ log ที่เขียนตอนสร้างแชต จึงยังใช้ model เดิม model ใหม่มีผลกับแชตใหม่
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
| effort | event `effort` ใน log ของ session | แชตนี้ | turn ถัดไป |
| model | การตั้งค่า `gcode.model` ของ VS Code | แชตใหม่ | หลัง engine ตัวใหม่เริ่ม |

สิ่งที่ควรสังเกต

- **effort ระหว่าง turn ไม่มีผลกับ turn นั้น** engine เขียน event `effort` ต่อท้ายไฟล์ log ทันที แต่ `drive` (ฟังก์ชันที่เดิน turn)
  ทำงานกับสำเนาของ event ที่อ่านจาก log ตอนเริ่ม turn และสำเนานั้นไม่ได้รับ event ใหม่นี้
  การเรียก model ที่เหลือของ turn นั้นจึงใช้ effort เดิม turn ถัดไปอ่าน log ใหม่จึงได้ค่าใหม่
  ต่างจากโหมด ซึ่ง engine ถือไว้ในหน่วยความจำและอ่านใหม่ทุกครั้งที่ใช้ จึงมีผลกับ call ถัดไปทันที
- **ชื่อในช่องพิมพ์ไม่ตรงกับ model ของแชตที่เปิดอยู่** หลังเปลี่ยน model ปุ่มแสดงชื่อ model ใหม่
  แต่ turn ถัดไปของแชตที่เปิดอยู่ยังเรียก model เดิมที่บันทึกไว้ตอนสร้าง session ผู้ใช้ต้องเปิดแชตใหม่จึงได้ model ใหม่
- **เปลี่ยน provider แชตเดิมยังใช้ provider เดิม** engine ตัวใหม่ได้ค่าของทุก provider ที่ผู้ใช้ตั้งไว้ ไม่ใช่แค่ provider ที่เลือกใหม่
  แชตเดิมจึงทำงานต่อบน provider เดิมได้ถ้าคีย์ของมันยังอยู่ ถ้าไม่มี `resumeSession` โยน `SessionUnreachable`
  แผงขึ้นแถบที่บอก provider และ model ของแชตนี้ พร้อมปุ่ม New chat และ Set key แทน "Internal error"
  ทัวร์นี้เลือก model ของ provider เดียวกันจึงไม่เจอกรณีนี้
