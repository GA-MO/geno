---
title: "ตั้ง API key หรือเปลี่ยนการตั้งค่า แล้ว Geno ย้าย engine"
description: ผู้ใช้เก็บคีย์ของ provider หรือเปลี่ยนการตั้งค่าที่ engine ใช้ แล้วหน้าต่างย้ายไปใช้ engine ตัวใหม่
scenario:
  surface: vscode
  given:
    - เปิดโฟลเดอร์ใน VS Code และติดตั้ง Geno แล้ว
  trigger: >-
    ผู้ใช้รันคำสั่ง "Geno: Set API Key" (หรือกดปุ่มบน toast) หรือเปลี่ยนการตั้งค่าที่ engine ใช้ เช่น `gcode.model`
  covers: [start.set-api-key, start.settings-change-restart]
  related: [start.first-run-no-key, start.open-window, sess.model-change]
  steps:
    - id: what
      lane: user
      beat:
        title: "คุณเปลี่ยนสิ่งที่ engine ใช้"
        text: >-
          engine (process แยกที่เดิน turn และเรียก model) อ่าน API key และการตั้งค่าได้ครั้งเดียวตอนเริ่ม process
          การเปลี่ยนสองอย่างนี้จึงทำให้หน้าต่างต้องย้ายไปหา engine ตัวใหม่ ลองเลือกว่าคุณเปลี่ยนอะไร
        from: you
        to: panel
        ask: "เปลี่ยนอะไร"
      do: ผู้ใช้เปลี่ยนสิ่งที่ engine ต้องใช้
      phase: idle
      fork:
        ask: ผู้ใช้เปลี่ยนอะไร
        options:
          - id: key
            label: ตั้ง API key
            then: reset
            steps:
              - lane: editor
                at: vscode-ui
                beat:
                  title: "Geno ถามว่าจะตั้งคีย์ของ provider ไหน"
                  text: >-
                    คุณรันคำสั่ง "Geno: Set API Key" หรือกดปุ่มบน toast (ข้อความแจ้งเตือนมุมขวาล่างของ VS Code) Geno เปิด quick pick (รายการให้เลือกที่ขึ้นด้านบนของหน้าต่าง)
                    แต่ละแถวคือคีย์ของ provider หนึ่งเจ้า (บริษัทที่รัน model ให้) แถวของ provider ที่แชตใช้อยู่ขึ้นก่อน
                    คุณเลือก "Model Studio: API key"
                  from: panel
                  to: you
                  sees: "quick pick หัวเรื่อง \"Set a Geno key\" ถามว่า \"Which key?\" แถวแรกคือ \"Model Studio: API key  chat\""
                do: >-
                  `pickSecret` เปิด quick pick ที่มีช่องลับของทุก provider ช่องของ provider ที่ใช้แชตอยู่ขึ้นก่อนและมีคำว่า chat กำกับ
                sees: >-
                  quick pick หัวเรื่อง "Set a Geno key" ข้อความ "Which key?" แถวแรกคือ "Model Studio: API key  chat"
                ref: packages/extension/src/chat-activation.ts#pickSecret
              - lane: user
                do: >-
                  ผู้ใช้เลือก "Model Studio: API key"
              - lane: editor
                at: vscode-ui
                beat:
                  title: "คุณวางคีย์ในช่องที่ซ่อนตัวอักษร"
                  text: >-
                    VS Code เปิดช่องรับรหัสผ่านที่แสดงตัวอักษรเป็นจุด และไม่หายเมื่อคุณคลิกที่อื่น คุณวางคีย์แล้วกด Enter
                  from: you
                  to: panel
                  sees: "ช่องกรอกด้านบนของหน้าต่าง \"Your Model Studio API key\" ตัวอักษรแสดงเป็นจุด"
                do: >-
                  `setApiKey` เปิดช่องรับรหัสผ่านที่ซ่อนตัวอักษร และไม่หายไปเมื่อคลิกที่อื่น
                sees: ช่องกรอกด้านบนของหน้าต่าง "Your Model Studio API key" ตัวอักษรแสดงเป็นจุด
                ref: packages/extension/src/chat-activation.ts#setApiKey
              - lane: user
                do: ผู้ใช้วางคีย์แล้วกด Enter
              - lane: editor
                at: vscode-ui
                beat:
                  title: "VS Code เก็บคีย์ไว้ใน SecretStorage"
                  text: >-
                    คีย์ไม่ถูกเขียนลงไฟล์การตั้งค่า VS Code เก็บไว้ในที่เก็บความลับของมัน แล้ว Geno เห็นว่าคีย์ของ engine เปลี่ยน
                    จึงสั่งย้าย engine
                  from: panel
                  to: panel
                do: >-
                  คีย์ที่ตัดช่องว่างหัวท้ายแล้วถูกเก็บใน SecretStorage ของ VS Code ใต้ชื่อ `gcode.apiKey.modelstudio`
                  ไม่มีการเขียนลงไฟล์การตั้งค่า
                ref: "packages/extension/src/chat-activation.ts#\"await secrets.store(secretName(choice.provider, choice.field), key.trim());\""
              - lane: editor
                at: chat
                do: >-
                  ตัวฟัง `secrets.onDidChange` เห็นชื่อที่ขึ้นต้นด้วย `gcode.apiKey.` จึงเรียก `chat.resetEngine()`
                  คีย์ของ agent ภายนอกไม่ได้ขึ้นต้นแบบนี้ จึงไม่ทำให้ engine เริ่มใหม่
                ref: "packages/extension/src/chat-activation.ts#\"if (event.key.startsWith(ENGINE_SECRETS)) chat.resetEngine();\""
          - id: setting
            label: เปลี่ยนการตั้งค่า เช่น gcode.model
            then: reset
            steps:
              - lane: editor
                at: chat
                beat:
                  title: "VS Code เห็นว่าการตั้งค่าของ engine เปลี่ยน"
                  text: >-
                    คุณเปลี่ยน `gcode.model` หรือการตั้งค่าอื่นที่ engine ใช้ เช่น provider หรือโดเมนที่ sandbox
                    (กรอบที่จำกัดว่าคำสั่ง `bash` เขียนไฟล์และต่อเครือข่ายได้แค่ไหน) ยอมให้ต่อ ส่วนของ Geno ใน VS Code
                    ฟังการเปลี่ยนนี้อยู่ จึงสั่งย้าย engine เหมือนตอนเปลี่ยนคีย์
                  from: panel
                  to: panel
                do: >-
                  ตัวฟัง `onDidChangeConfiguration` เห็นว่าการตั้งค่าที่เปลี่ยนอยู่ใน `ENGINE_SETTINGS`
                  (provider, baseUrl, model, providers, roles, การ resume, การปลุก, โดเมนของ sandbox, ไดเรกทอรีเพิ่ม)
                  จึงเรียก `chat.resetEngine()`
                ref: "packages/extension/src/chat-activation.ts#\"if (ENGINE_SETTINGS.some((section) => event.affectsConfiguration(section))) chat.resetEngine();\""

    - id: reset
      lane: editor
      at: engine-link
      beat:
        title: "Geno ตัดสายกับ engine ตัวเดิม"
        text: >-
          Geno ปิดการเชื่อมต่อปัจจุบัน ครั้งหน้าที่ต่อจะไปหา engine ที่การตั้งค่าใหม่ชี้ ช่องพิมพ์ขึ้นชื่อ model ตามการตั้งค่าปัจจุบัน
          และรายการ model โหลดใหม่ ถ้าคุณเปลี่ยน model ด้วย แชตที่เปิดอยู่ยังใช้ model เดิม model ใหม่มีผลกับแชตใหม่
        from: panel
        to: engine
        ask: "ต่อ engine อยู่ก่อนไหม"
      do: >-
        `resetEngine` ทำลาย socket ของการเชื่อมต่อปัจจุบัน (ถ้ามี) เพื่อให้การเชื่อมต่อครั้งหน้าไปหา engine ที่การตั้งค่าใหม่ชี้
        แล้วส่ง action `model` ให้ช่องพิมพ์แสดงชื่อ model ใหม่ และให้รายการ model โหลดใหม่
      ref: packages/extension/src/chat/chat.ts#Chat.resetEngine
      emits: [model]

    - id: connected
      lane: editor
      at: engine-link
      do: ดูว่าหน้าต่างนี้ต่อ engine อยู่ก่อนหรือไม่
      ref: packages/extension/src/chat/engine.ts#Engine.reset
      fork:
        ask: ก่อนเปลี่ยน หน้าต่างนี้ต่อ engine อยู่หรือไม่
        options:
          - id: was-connected
            label: ต่ออยู่
            steps:
              - lane: editor
                at: engine-link
                beat:
                  title: "Geno ต่อ engine ตัวใหม่ในอีก 1 วินาที"
                  text: >-
                    หน้าต่างนี้ต่อ engine อยู่ เมื่อสายถูกตัด Geno นัดต่อใหม่ในอีก 1 วินาที ที่อยู่ของ engine คือ socket
                    (ช่องคุยระหว่างสอง process ในเครื่องเดียว ใช้ path ของไฟล์แทน port) ซึ่ง path คำนวณจาก hash ของการตั้งค่าและคีย์
                    คีย์หรือการตั้งค่าชุดใหม่จึงได้ path ใหม่ ถ้ายังไม่มี engine ฟังอยู่ที่นั่น Geno เปิด engine ตัวใหม่
                  from: panel
                  to: engine
                do: >-
                  socket ปิด ตัวฟัง `close` เขียน "engine: connection closed" ลง output channel ล้างการเชื่อมต่อเดิม
                  แล้วนัด `restart` ในอีก 1 วินาที
                ref: "packages/extension/src/chat/engine.ts#\"socket.on('close', () => {\""
              - use: start-engine-connects
              - lane: server
                at: turns
                beat:
                  title: "Engine ตัวเก่าทำงานค้างจนจบแล้วออกเอง"
                  text: >-
                    Geno ไม่ปิด engine ตัวเก่า turn ที่ค้างอยู่บนตัวเก่าทำต่อจนจบ แล้วมันออกเองเมื่อไม่มีหน้าต่างต่อและไม่มีงานครบ
                    10 วินาที แชตที่แสดงอยู่จะไปต่อบนตัวใหม่เมื่อคุณส่งข้อความถัดไป
                  from: engine
                  to: engine
                  end: "ย้ายไป engine ตัวใหม่"
                do: >-
                  ที่อยู่ socket มาจาก hash ของการตั้งค่าและคีย์ การตั้งค่าใหม่จึงได้ engine อีกตัว
                  engine ตัวเก่าไม่ถูกปิด มันทำ turn ที่ค้างอยู่ต่อจนจบ แล้วออกเองเมื่อไม่มีหน้าต่างต่อและไม่มีงานครบ 10 วินาที
                ref: packages/extension/src/chat/engine.ts#socketPathOf
                end: { turn: none }
          - id: not-connected
            label: ยังไม่ได้ต่อ (เช่นเพิ่งติดตั้ง)
            steps:
              - lane: editor
                at: engine-link
                beat:
                  title: "ยังไม่มีอะไรให้ปิด"
                  text: >-
                    หน้าต่างนี้ยังไม่เคยต่อ engine เช่นเพิ่งติดตั้ง ข้อความถัดไปที่คุณส่งจะเปิด engine
                    ด้วยคีย์และการตั้งค่าใหม่
                  from: panel
                  to: panel
                  end: "ใช้คีย์หรือการตั้งค่าใหม่ครั้งหน้า"
                do: >-
                  ไม่มี socket ให้ปิด จึงไม่มีอะไรเกิดขึ้นตอนนี้ ข้อความถัดไปที่ส่งจะเรียก `Engine.connection()`
                  ซึ่งอ่านคีย์ใหม่และผ่าน `setupProblem` ถ้าไม่มีช่องอื่นขาด
                ref: packages/extension/src/chat/engine.ts#Engine.connection
                end: { turn: none }
---

หน้านี้เล่าสิ่งที่เกิดเมื่อคุณตั้ง API key หรือเปลี่ยนการตั้งค่าอย่าง `gcode.model` คุณไม่เห็นอะไรเปลี่ยนมาก
แต่เบื้องหลังหน้าต่างย้ายไปใช้ engine อีกตัว ซึ่งอธิบายว่าทำไมแชตที่เปิดอยู่ยังใช้ model เดิม และทำไม turn ที่กำลังทำงานอาจขึ้นว่าล้มเหลว

engine ได้คีย์และการตั้งค่าตอนเริ่ม process เท่านั้น คีย์อยู่ในตัวแปรสภาพแวดล้อมของ process
การเปลี่ยนคีย์หรือการตั้งค่าจึงไม่แก้ engine ตัวที่ทำงานอยู่ แต่ย้ายหน้าต่างไปหา engine ตัวใหม่
ซึ่งมีที่อยู่ socket ต่างออกไปเพราะคำนวณจาก hash ของการตั้งค่าชุดใหม่

สิ่งที่ควรสังเกต

- **มีสามทางที่ไปถึงจุดเดียวกัน** คำสั่ง "Geno: Set API Key" ปุ่ม Set API Key บน toast
  และหน้า Models and Keys ในแผงแชต ทั้งหมดเก็บคีย์ใน SecretStorage และทำให้ `secrets.onDidChange` เรียก `resetEngine`
- **แชตที่เปิดอยู่ยังใช้ model เดิม** session จด model และ provider ไว้ตอนสร้าง การเปลี่ยน `gcode.model` มีผลกับแชตใหม่
- **การเชื่อมต่อใหม่ยังไม่ผูกกับ session** `restart` ต่อ engine อย่างเดียว แชตที่แสดงอยู่จะ resume บน engine ตัวใหม่
  เมื่อมีอะไรเรียก `link()` เช่นการส่งข้อความถัดไป
- **turn ที่ทำงานอยู่ตอนเปลี่ยนคีย์** คำขอ `session/prompt` (ข้อความ [ACP](/start/glossary/) ที่เริ่ม turn) ของมันวิ่งอยู่บน socket ที่ถูกทำลาย
  ฝั่ง extension จึงได้ error และแผงแสดง turn นั้นว่าล้มเหลว ขณะที่ engine ตัวเก่าทำ turn นั้นต่อจนจบในเบื้องหลัง

เมื่อมีคีย์แล้ว อ่านต่อที่ [เปิดหน้าต่าง VS Code แล้ว Geno ต่อ engine](/scenarios/start/open-window/)
