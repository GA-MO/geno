---
title: "ส่งข้อความแรกโดยยังไม่มี API key"
description: ติดตั้งใหม่แล้วส่งข้อความทันที Geno ตรวจคีย์ก่อนเปิด engine แสดง toast ให้ตั้งคีย์ และ turn จบแบบ failed
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
      beat:
        title: "คุณส่งข้อความแรก “สวัสดี”"
        text: >-
          คุณเพิ่งติดตั้ง Geno และพิมพ์ "สวัสดี" แล้วกด Enter ทันที แผงไม่มี turn ค้างอยู่ จึงส่งข้อความต่อให้ VS Code
        from: you
        to: panel
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
      beat:
        title: "แชตขึ้นข้อความของคุณทันที"
        text: >-
          แผงแสดงข้อความของคุณก่อนติดต่อ engine ด้วยซ้ำ หัวข้อขึ้น working และปุ่ม Stop มาแทน Send
        from: panel
        to: you
        sees: { kind: composer, state: working, header: working }
      do: >-
        `Chat.send` ส่งต่อให้ `prompt()` ซึ่งส่ง action `turn-start` ไปที่แผงก่อนติดต่อ engine
        ผู้ใช้จึงเห็นข้อความของตัวเองทันที
      sees: บับเบิลข้อความ "สวัสดี" หัวข้อข้างโลโก้เป็น "working" และปุ่ม Stop มาแทนปุ่ม Send
      ref: packages/extension/src/chat/chat.ts#Chat.prompt
      emits: [turn-start]

    - id: settings
      lane: editor
      at: engine-link
      beat:
        title: "Geno ตรวจการตั้งค่าก่อนเปิด engine"
        text: >-
          ก่อนเปิด engine ครั้งแรก Geno อ่าน provider model และ API key แล้วตรวจว่าครบไหม provider ตั้งต้นคือ Model
          Studio และช่องแรกที่ขาดคือ API key
        from: panel
        to: panel
      do: >-
        `prompt()` เรียก `link()` ซึ่งเรียก `Engine.connection()` การเชื่อมต่อครั้งแรกเริ่มที่ `engineSettings`
        ซึ่งอ่าน provider model และคีย์ แล้วให้ `setupProblem` ตรวจ ช่องที่ขาดช่องแรกของ Model Studio คือ API key
      ref: packages/extension/src/chat-activation.ts#engineSettings

    - id: toast
      lane: editor
      at: vscode-ui
      beat:
        title: "VS Code ขึ้น toast ว่ายังไม่มี API key"
        text: >-
          Geno แสดง toast พร้อมปุ่มที่แก้ปัญหานั้นตรงๆ แล้วหยุด ไม่มี engine ถูกเปิด และไม่มี session ถูกสร้าง
        from: panel
        to: you
        sees: { kind: toast, text: "Geno has no Model Studio API key. Run Geno: Set API Key.", actions: [ Set API Key ] }
      do: >-
        `engineSettings` แสดง toast เตือนพร้อมปุ่มที่แก้ปัญหานั้น แล้วโยน error ที่มีข้อความเดียวกัน
        engine ไม่ถูกเปิด และไม่มี session ใดถูกสร้าง
      sees: >-
        toast สีเหลืองมุมขวาล่าง: "Geno has no Model Studio API key. Run Geno: Set API Key." พร้อมปุ่ม [Set API Key]
      ref: "packages/extension/src/chat-activation.ts#\"void vscode.window.showWarningMessage(problem.message, problem.fix.label).then((choice) => {\""

    - id: failed
      lane: editor
      at: chat
      beat:
        title: "Turn นี้ล้มเหลวทันที"
        text: >-
          VS Code บอกแผงว่า turn ล้มเหลว พร้อมข้อความเดียวกับใน toast
        from: panel
        to: panel
      do: >-
        `prompt()` จับ error ได้ จึงส่ง action `error` ที่มีข้อความเดียวกับ toast แล้วส่ง `turn-end` สถานะ `failed`
      ref: "packages/extension/src/chat/chat.ts#\"this.dispatch({ type: 'turn-end', at: Date.now(), status: 'failed', usage: undefined });\""
      emits: [error, turn-end]

    - id: shown
      lane: panel
      at: rail
      beat:
        title: "แชตขึ้นบรรทัด error"
        text: >-
          ใต้ข้อความของคุณมีบรรทัด error สีแดง หัวข้อบอกว่าล้มเหลวในเสี้ยววินาที และปุ่ม Send กลับมา
          ไม่มีการเรียก model เลย
        from: panel
        to: you
        sees: { kind: notice, text: "Geno has no Model Studio API key. Run Geno: Set API Key.", tone: error }
      do: >-
        turn ขึ้นบล็อก error และท้าย turn บอกว่าล้มเหลว `missingReply` ไม่แสดงประกาศ "stopped without a reply"
        เพราะ error บอกเหตุผลอยู่แล้ว
      sees: >-
        ใต้บับเบิลมีบรรทัด error สีแดง "Geno has no Model Studio API key. Run Geno: Set API Key."
        หัวข้อเป็น "failed after 120ms" (ไม่ถึงวินาที) ท้าย turn ขึ้น "Failed" และปุ่ม Send กลับมา
      ref: packages/extension/src/chat/render.ts#turnFooter

    - id: choice
      lane: user
      beat:
        title: "คุณเลือกว่าจะกดปุ่มบน toast ไหม"
        text: >-
          toast ยังค้างอยู่มุมขวาล่าง ลองเลือกแต่ละทางเพื่อดูว่าไปต่อที่ไหน
        from: you
        to: panel
        ask: "กดปุ่มบน toast ไหม"
      do: ผู้ใช้เห็น toast และเลือกว่าจะกดปุ่มหรือไม่
      fork:
        ask: ผู้ใช้กดปุ่มบน toast หรือไม่
        options:
          - id: set-key
            label: กด Set API Key
            steps:
              - lane: editor
                at: vscode-ui
                beat:
                  title: "คุณกด Set API Key"
                  text: >-
                    ปุ่มนี้เปิดคำสั่งเดียวกับ "Geno: Set API Key" ใน Command Palette ทัวร์ต่อไปเล่าว่า Geno เก็บคีย์ไว้ที่ไหน
                  from: you
                  to: panel
                  end: "ไปตั้ง API key"
                do: >-
                  ปุ่มบน toast เรียกคำสั่ง `gcode.setApiKey` (คำสั่งเดียวกับ "Geno: Set API Key" ใน Command Palette)
                ref: "packages/extension/src/chat-activation.ts#\"if (choice !== undefined) void vscode.commands.executeCommand(problem.fix.command, ...problem.fix.args);\""
                goto: start.set-api-key
          - id: dismiss
            label: ปิด toast
            steps:
              - lane: panel
                at: rail
                beat:
                  title: "คุณปิด toast"
                  text: >-
                    toast หายไป turn ที่ล้มเหลวยังอยู่ในแผง ข้อความถัดไปจะเดินทางเดิมและได้ toast เดิม จนกว่าคุณจะตั้งคีย์
                  from: you
                  to: panel
                  end: "ยังไม่มีคีย์ turn ล้มเหลว"
                do: >-
                  toast หายไป turn ที่ล้มเหลวยังอยู่ในแผง ข้อความถัดไปที่ส่งจะเดินทางเดิมและได้ toast เดิม จนกว่าจะตั้งคีย์
                ref: packages/extension/src/chat/rail.ts#headerOf
                end: { turn: failed }
---

Geno ตรวจการตั้งค่าใน extension host ก่อนเปิด engine เสมอ ข้อความแรกจึงล้มเหลวเร็วและไม่ทิ้งอะไรไว้:
ไม่มี process ของ engine ไม่มีไฟล์ log ของ session และไม่มีการเรียก model

สิ่งที่ควรสังเกต

- **toast อาจมาก่อนผู้ใช้ส่งข้อความ** การเปิดแผงครั้งแรกก็เรียก `Engine.connection()` อยู่แล้ว
  (หน้าเริ่มต้นขอรายการแชต และแถบสถานะ PR ขอข้อมูลจาก engine) ผู้ใช้ที่ยังไม่มีคีย์จึงเห็น toast เดียวกันตั้งแต่เปิดแผง
  ดู [เปิดหน้าต่าง VS Code แล้ว Geno ต่อ engine](/scenarios/start/open-window/)
- **ปุ่มบน toast เปลี่ยนตามสิ่งที่ขาด** ขาดคีย์ได้ "Set API Key" ขาด endpoint ของ Model Studio ได้ "Open Settings"
  ที่เปิดไปที่ `gcode.baseUrl` ขาด model หรือช่องอื่นได้ "Open Geno Settings"
- **Model Studio ต้องมีทั้งคีย์และ endpoint** `setupProblem` รายงานทีละอย่าง เรียงตามลำดับช่องของ provider
  ผู้ใช้ Model Studio ที่ตั้งคีย์แล้วจึงอาจได้ toast รอบที่สองเรื่อง `gcode.baseUrl` เมื่อส่งข้อความถัดไป
- **turn ที่ล้มเหลวอยู่แค่ในแผง** มันไม่มีใน log ของ session ใด เมื่อส่งข้อความหลังตั้งคีย์แล้ว Geno สร้าง session ใหม่
  โดยเก็บบทสนทนาที่แผงแสดงอยู่ไว้ turn ที่ล้มเหลวจึงยังเห็นอยู่ แต่จะหายไปเมื่อ reload หน้าต่าง

อ่านต่อที่ [ตั้ง API key หรือเปลี่ยนการตั้งค่า แล้ว Geno ย้าย engine](/scenarios/start/set-api-key/)
