---
title: ส่งข้อความแรกโดยไม่มี API key
description: ติดตั้งใหม่แล้วส่งข้อความทันที Geno ตรวจคีย์ก่อนเปิด engine แสดง toast ให้ตั้งคีย์ และ turn จบแบบ failed
tableOfContents: false
sidebar:
  order: 2
scenario:
  surface: vscode
  given:
    - เพิ่งติดตั้ง Geno เปิดโฟลเดอร์แล้ว และแผงแชตแสดงหน้าเริ่มต้น
    - ยังไม่ได้ตั้ง API key ของ provider ที่เลือกไว้ (ค่าเริ่มต้นคือ Model Studio) ทั้งใน SecretStorage และในตัวแปรสภาพแวดล้อม
  trigger: >-
    ผู้ใช้พิมพ์ "สวัสดี" แล้วกด Enter
  covers: [start.first-run-no-key]
  related: [start.set-api-key, start.open-window, turn.text-answer]
  steps:
    - id: type
      lane: user
      do: ผู้ใช้พิมพ์ข้อความแรกในช่องพิมพ์แล้วกด Enter
      phase: idle

    - id: send
      lane: panel
      at: composer
      do: >-
        `submit()` เห็นว่าไม่มี turn ทำงานอยู่ จึงโพสต์ข้อความ `send` ไปให้ extension host
      ref: packages/extension/src/chat/webview.ts#submit
      emits: [send]

    - id: turn-start
      lane: editor
      at: chat
      do: >-
        `Chat.send` ส่งต่อให้ `prompt()` ซึ่งส่ง action `turn-start` ไปที่แผงก่อนติดต่อ engine
        ผู้ใช้จึงเห็นข้อความของตัวเองทันที
      sees: บับเบิลข้อความ "สวัสดี" หัวข้อข้างโลโก้เป็น "working" และปุ่ม Stop มาแทนปุ่ม Send
      ref: packages/extension/src/chat/chat.ts#Chat.prompt
      emits: [turn-start]

    - id: settings
      lane: editor
      at: engine-link
      do: >-
        `prompt()` เรียก `link()` ซึ่งเรียก `Engine.connection()` การเชื่อมต่อครั้งแรกเริ่มที่ `engineSettings`
        ซึ่งอ่าน provider โมเดล และคีย์ แล้วให้ `setupProblem` ตรวจ ช่องที่ขาดช่องแรกของ Model Studio คือ API key
      ref: packages/extension/src/extension.ts#engineSettings

    - id: toast
      lane: editor
      at: vscode-ui
      do: >-
        `engineSettings` แสดง toast เตือนพร้อมปุ่มที่แก้ปัญหานั้น แล้วโยน error ที่มีข้อความเดียวกัน
        engine ไม่ถูกเปิด และไม่มี session ใดถูกสร้าง
      sees: >-
        toast สีเหลืองมุมขวาล่าง: "Geno has no Model Studio API key. Run Geno: Set API Key." พร้อมปุ่ม [Set API Key]
      ref: "packages/extension/src/extension.ts#\"void vscode.window.showWarningMessage(problem.message, problem.fix.label).then((choice) => {\""

    - id: failed
      lane: editor
      at: chat
      do: >-
        `prompt()` จับ error ได้ จึงส่ง action `error` ที่มีข้อความเดียวกับ toast แล้วส่ง `turn-end` สถานะ `failed`
      ref: "packages/extension/src/chat/chat.ts#\"this.dispatch({ type: 'turn-end', at: Date.now(), status: 'failed', usage: undefined });\""
      emits: [error, turn-end]

    - id: shown
      lane: panel
      at: rail
      do: >-
        turn ขึ้นบล็อก error และท้าย turn บอกว่าล้มเหลว `missingReply` ไม่แสดงประกาศ "stopped without a reply"
        เพราะ error บอกเหตุผลอยู่แล้ว
      sees: >-
        ใต้บับเบิลมีบรรทัด error สีแดง "Geno has no Model Studio API key. Run Geno: Set API Key."
        หัวข้อเป็น "failed after 120ms" (ไม่ถึงวินาที) ท้าย turn ขึ้น "Failed" และปุ่ม Send กลับมา
      ref: packages/extension/src/chat/render.ts#turnFooter

    - id: choice
      lane: user
      do: ผู้ใช้เห็น toast และเลือกว่าจะกดปุ่มหรือไม่
      fork:
        ask: ผู้ใช้กดปุ่มบน toast หรือไม่
        options:
          - id: set-key
            label: กด Set API Key
            steps:
              - lane: editor
                at: vscode-ui
                do: >-
                  ปุ่มบน toast เรียกคำสั่ง `gcode.setApiKey` (คำสั่งเดียวกับ "Geno: Set API Key" ใน Command Palette)
                ref: "packages/extension/src/extension.ts#\"if (choice !== undefined) void vscode.commands.executeCommand(problem.fix.command, ...problem.fix.args);\""
                goto: start.set-api-key
          - id: dismiss
            label: ปิด toast
            steps:
              - lane: panel
                at: rail
                do: >-
                  toast หายไป turn ที่ล้มเหลวยังอยู่ในแผง ข้อความถัดไปที่ส่งจะเดินทางเดิมและได้ toast เดิม จนกว่าจะตั้งคีย์
                ref: packages/extension/src/chat/rail.ts#headerOf
                end: { turn: failed }
---

Geno ตรวจการตั้งค่าใน extension host ก่อนเปิด engine เสมอ ข้อความแรกจึงล้มเหลวเร็วและไม่ทิ้งอะไรไว้:
ไม่มี process ของ engine ไม่มีไฟล์ log ของ session และไม่มีการเรียกโมเดล

สิ่งที่ควรสังเกต

- **toast อาจมาก่อนผู้ใช้ส่งข้อความ** การเปิดแผงครั้งแรกก็เรียก `Engine.connection()` อยู่แล้ว
  (หน้าเริ่มต้นขอรายการแชต และแถบสถานะ PR ขอข้อมูลจาก engine) ผู้ใช้ที่ยังไม่มีคีย์จึงเห็น toast เดียวกันตั้งแต่เปิดแผง
  ดู [เปิดหน้าต่างและเชื่อม engine](/scenarios/start/open-window/)
- **ปุ่มบน toast เปลี่ยนตามสิ่งที่ขาด** ขาดคีย์ได้ "Set API Key" ขาด endpoint ของ Model Studio ได้ "Open Settings"
  ที่เปิดไปที่ `gcode.baseUrl` ขาดโมเดลหรือช่องอื่นได้ "Open Geno Settings"
- **Model Studio ต้องมีทั้งคีย์และ endpoint** `setupProblem` รายงานทีละอย่าง เรียงตามลำดับช่องของ provider
  ผู้ใช้ Model Studio ที่ตั้งคีย์แล้วจึงอาจได้ toast รอบที่สองเรื่อง `gcode.baseUrl` เมื่อส่งข้อความถัดไป
- **turn ที่ล้มเหลวอยู่แค่ในแผง** มันไม่มีใน log ของ session ใด เมื่อส่งข้อความหลังตั้งคีย์แล้ว Geno สร้าง session ใหม่
  โดยเก็บบทสนทนาที่แผงแสดงอยู่ไว้ turn ที่ล้มเหลวจึงยังเห็นอยู่ แต่จะหายไปเมื่อ reload หน้าต่าง
