---
title: ตั้งค่า API key
description: ผู้ใช้เก็บคีย์ของ provider หรือเปลี่ยนการตั้งค่าที่ engine ใช้ แล้วหน้าต่างย้ายไปใช้ engine ตัวใหม่
tableOfContents: false
sidebar:
  order: 3
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
                do: >-
                  `pickSecret` เปิด quick pick ที่มีช่องลับของทุก provider ช่องของ provider ที่ใช้แชตอยู่ขึ้นก่อนและมีคำว่า chat กำกับ
                sees: >-
                  quick pick หัวเรื่อง "Set a Geno key" ข้อความ "Which key?" แถวแรกคือ "Model Studio: API key  chat"
                ref: packages/extension/src/extension.ts#pickSecret
              - lane: user
                do: >-
                  ผู้ใช้เลือก "Model Studio: API key"
              - lane: editor
                at: vscode-ui
                do: >-
                  `setApiKey` เปิดช่องรับรหัสผ่านที่ซ่อนตัวอักษร และไม่หายไปเมื่อคลิกที่อื่น
                sees: ช่องกรอกด้านบนของหน้าต่าง "Your Model Studio API key" ตัวอักษรแสดงเป็นจุด
                ref: packages/extension/src/extension.ts#setApiKey
              - lane: user
                do: ผู้ใช้วางคีย์แล้วกด Enter
              - lane: editor
                at: vscode-ui
                do: >-
                  คีย์ที่ตัดช่องว่างหัวท้ายแล้วถูกเก็บใน SecretStorage ของ VS Code ใต้ชื่อ `gcode.apiKey.modelstudio`
                  ไม่มีการเขียนลงไฟล์การตั้งค่า
                ref: "packages/extension/src/extension.ts#\"await secrets.store(secretName(choice.provider, choice.field), key.trim());\""
              - lane: editor
                at: chat
                do: >-
                  ตัวฟัง `secrets.onDidChange` เห็นชื่อที่ขึ้นต้นด้วย `gcode.apiKey.` จึงเรียก `chat.resetEngine()`
                  คีย์ของ agent ภายนอกไม่ได้ขึ้นต้นแบบนี้ จึงไม่ทำให้ engine เริ่มใหม่
                ref: "packages/extension/src/extension.ts#\"if (event.key.startsWith(ENGINE_SECRETS)) chat.resetEngine();\""
          - id: setting
            label: เปลี่ยนการตั้งค่า เช่น gcode.model
            then: reset
            steps:
              - lane: editor
                at: chat
                do: >-
                  ตัวฟัง `onDidChangeConfiguration` เห็นว่าการตั้งค่าที่เปลี่ยนอยู่ใน `ENGINE_SETTINGS`
                  (provider, baseUrl, model, providers, roles, การ resume, การปลุก, โดเมนของ sandbox, ไดเรกทอรีเพิ่ม)
                  จึงเรียก `chat.resetEngine()`
                ref: "packages/extension/src/extension.ts#\"if (ENGINE_SETTINGS.some((section) => event.affectsConfiguration(section))) chat.resetEngine();\""

    - id: reset
      lane: editor
      at: engine-link
      do: >-
        `resetEngine` ทำลาย socket ของการเชื่อมต่อปัจจุบัน (ถ้ามี) เพื่อให้การเชื่อมต่อครั้งหน้าไปหา engine ที่การตั้งค่าใหม่ชี้
        แล้วส่ง action `model` ให้ช่องพิมพ์แสดงชื่อโมเดลใหม่ และให้รายการโมเดลโหลดใหม่
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
                do: >-
                  socket ปิด ตัวฟัง `close` เขียน "engine: connection closed" ลง output channel ล้างการเชื่อมต่อเดิม
                  แล้วนัด `restart` ในอีก 1 วินาที
                ref: "packages/extension/src/chat/engine.ts#\"socket.on('close', () => {\""
              - use: start-engine-connects
              - lane: server
                at: turns
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
                do: >-
                  ไม่มี socket ให้ปิด จึงไม่มีอะไรเกิดขึ้นตอนนี้ ข้อความถัดไปที่ส่งจะเรียก `Engine.connection()`
                  ซึ่งอ่านคีย์ใหม่และผ่าน `setupProblem` ถ้าไม่มีช่องอื่นขาด
                ref: packages/extension/src/chat/engine.ts#Engine.connection
                end: { turn: none }
---

engine ได้คีย์และการตั้งค่าตอนเริ่ม process เท่านั้น คีย์อยู่ในตัวแปรสภาพแวดล้อมของ process
การเปลี่ยนคีย์หรือการตั้งค่าจึงไม่แก้ engine ตัวที่ทำงานอยู่ แต่ย้ายหน้าต่างไปหา engine ตัวใหม่
ซึ่งมีที่อยู่ socket ต่างออกไปเพราะคำนวณจาก hash ของการตั้งค่าชุดใหม่

สิ่งที่ควรสังเกต

- **มีสามทางที่ไปถึงจุดเดียวกัน** คำสั่ง "Geno: Set API Key" ปุ่ม Set API Key บน toast
  และหน้า Models and Keys ในแผงแชต ทั้งหมดเก็บคีย์ใน SecretStorage และทำให้ `secrets.onDidChange` เรียก `resetEngine`
- **แชตที่เปิดอยู่ยังใช้โมเดลเดิม** session จดโมเดลและ provider ไว้ตอนสร้าง การเปลี่ยน `gcode.model` มีผลกับแชตใหม่
- **การเชื่อมต่อใหม่ยังไม่ผูกกับ session** `restart` ต่อ engine อย่างเดียว แชตที่แสดงอยู่จะ resume บน engine ตัวใหม่
  เมื่อมีอะไรเรียก `link()` เช่นการส่งข้อความถัดไป
- **turn ที่ทำงานอยู่ตอนเปลี่ยนคีย์** คำขอ `session/prompt` ของมันวิ่งอยู่บน socket ที่ถูกทำลาย
  ฝั่ง extension จึงได้ error และแผงแสดง turn นั้นว่าล้มเหลว ขณะที่ engine ตัวเก่าทำ turn นั้นต่อจนจบในเบื้องหลัง
