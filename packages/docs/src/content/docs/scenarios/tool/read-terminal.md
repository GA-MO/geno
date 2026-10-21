---
title: "Model อ่านเทอร์มินัลของคุณ"
description: model เรียก read_terminal เพื่อดูคำสั่งที่ผู้ใช้รันในเทอร์มินัลของ VS Code engine ขอให้ extension อ่าน ซึ่งตัด ลบความลับ และจำกัดขนาดก่อนส่งกลับ ไม่มีการถาม
scenario:
  surface: vscode
  given:
    - ผู้ใช้รัน `pnpm install` แล้วรัน `pnpm build` ในเทอร์มินัลของ VS Code หลังจากที่ Geno เริ่มในหน้าต่างนี้แล้ว และ build ล้มเหลว
    - shell ของเทอร์มินัลเปิด shell integration ของ VS Code อยู่ (bash, zsh, fish หรือ PowerShell)
  trigger: >-
    ผู้ใช้ถามว่า "build ที่ผมเพิ่งรันพังเพราะอะไร" model เรียก `read_terminal` โดยไม่ระบุเทอร์มินัล
  covers: [tool.read-terminal]
  related: [tool.parallel-read-batch, sec.hidden-unicode, tool.bash-safe-runs]
  steps:
    - id: recorded
      lane: editor
      at: vscode-ui
      beat:
        title: "VS Code จดคำสั่งในเทอร์มินัลไว้"
        text: >-
          ตั้งแต่ Geno ทำงานในหน้าต่างนี้ ส่วนของ Geno ใน VS Code (extension) จดคำสั่งล่าสุด 20 คำสั่งต่อเทอร์มินัล
          พร้อมท้าย output และ exit code มันรู้ว่าคำสั่งเริ่มและจบเมื่อไรจาก shell integration ซึ่งเป็นฟีเจอร์ของ VS Code
          คุณรัน `pnpm install` ซึ่งผ่าน แล้วรัน `pnpm build` ซึ่งล้ม เทอร์มินัลนี้จึงมีคำสั่งที่จดไว้ 2 คำสั่ง จากนั้นถามว่า "build ที่ผมเพิ่งรันพังเพราะอะไร"
        from: panel
        to: panel
      do: >-
        ตั้งแต่ extension ทำงาน `TerminalRecorder` ฟัง event เริ่มและจบคำสั่งของ shell integration
        เก็บคำสั่งล่าสุด 20 คำสั่งต่อเทอร์มินัล พร้อมท้าย output ไม่เกิน 64,000 ตัวอักษรต่อคำสั่ง และ exit code
      ref: packages/extension/src/chat/terminals.ts#TerminalRecorder
      phase: calling-model

    - id: asks
      lane: model
      beat:
        title: "Model ขออ่านเทอร์มินัล"
        text: >-
          model ไม่เห็นเทอร์มินัลของคุณเอง มันจึงเรียก tool `read_terminal` เพื่อขอดู โดยไม่ระบุเทอร์มินัลและจำนวนคำสั่ง
          แล้วหยุดรอผล `read_terminal` เป็น tool ที่เลื่อนไว้ (Geno ส่งแค่ชื่อในคำอธิบายของ `tool_search`) model จึงโหลดมันด้วย `tool_search` ก่อน
          การ์ดข้างล่างมาจากการบันทึกที่รัน Geno จริงกับ model จำลองที่ตอบตามบทที่เขียนไว้ก่อน ฝั่ง VS Code ในการบันทึกเป็นตัวบันทึกที่ตอบแทน extension
          การ์ดคือคำตอบของ model ตามที่ Geno ใส่กลับในคำขอถัดไป ดู `input` ที่ไฮไลต์ ว่างเปล่า แปลว่าอ่านเทอร์มินัลที่ active
        from: model
        to: engine
        sees:
          kind: payload
          source: packages/docs/src/data/recorded/tool-read-terminal.jsonl#line=7
          select: messages[-2]
          highlight: ['content[1].input']
      do: >-
        model ส่งบล็อก `tool_use` ของ `read_terminal` ไม่ระบุ `terminal` และ `commands` จบด้วย `stop_reason: tool_use`
      ref: "packages/engine/src/gateway.ts#\"stopReason: message.stop_reason,\""
      emits: [tool_use]

    - use: tool-call-opens
      beat:
        title: "แชตขึ้นขั้นของ read_terminal"
        text: >-
          Geno จัดคิว call แล้วแชตขึ้นขั้นใหม่พร้อมจุดหมุน
        from: engine
        to: panel

    - id: no-ask
      lane: policy
      at: rules
      beat:
        title: "Geno ไม่ถาม เพราะอ่านอย่างเดียว"
        text: >-
          การอ่านเทอร์มินัลไม่แก้อะไร โหมด Plan Ask และ Auto ซึ่งมีคุณดูแชตอยู่ จึงได้ tool นี้และไม่ถามก่อน
          run ที่ไม่มีใครดู เช่น `gcode agent` ในสคริปต์ ไม่ได้รับ tool นี้เลย
        from: engine
        to: engine
      do: >-
        ไม่มีการตัดสินของนโยบาย `read_terminal` อ่านอย่างเดียว ทุกโหมดที่มีคนดู (Plan, Ask, Auto) ได้ tool นี้และไม่ถาม
        run ที่ไม่มีคนดูไม่ได้รับ tool นี้เลย
      ref: packages/core/src/terminal.ts#READ_TERMINAL_MODES

    - id: request
      lane: server
      at: updates
      beat:
        title: "Geno ขอ VS Code อ่านเทอร์มินัล"
        text: >-
          engine หา editor ที่แสดง session นี้และอ่านเทอร์มินัลได้ แล้วขอคำสั่งล่าสุด ค่าตั้งต้นคือ 3 คำสั่ง
          เทอร์มินัลนี้มีแค่ 2 คำสั่ง VS Code จึงส่งกลับทั้งสอง เรียงจากเก่าไปใหม่
        from: engine
        to: panel
      do: >-
        executor เรียก `editorTerminals` ซึ่งหา editor ที่แสดง session นี้และอ่านเทอร์มินัลได้
        แล้วส่งคำขอ ACP ส่วนขยาย `_gcode/readTerminal` พร้อมจำนวนคำสั่งที่ต้องการ (ค่าเริ่มต้น 3)
      ref: packages/engine/src/serve.ts#editorTerminals
      emits: [_gcode/readTerminal]

    - id: read
      lane: editor
      at: chat
      beat:
        title: "VS Code ลบความลับและตัด output"
        text: >-
          extension เลือกเทอร์มินัลที่ active ล้าง escape code (รหัสสีและการเลื่อนเคอร์เซอร์ของเทอร์มินัล)
          ลบความลับอย่าง token หรือรหัสผ่านทั้งจากคำสั่งและ output แล้วเก็บท้าย output ไม่เกิน 40 บรรทัดต่อคำสั่ง
          ไม่มีข้อความดิบออกจาก VS Code
        from: panel
        to: engine
      do: >-
        `TerminalRecorder.read` เลือกเทอร์มินัลที่ active ล้าง escape code ของเทอร์มินัล ลบความลับด้วย `redactSecrets`
        ทั้งจากบรรทัดคำสั่งและ output ก่อนตัด แล้วเก็บท้าย output ไม่เกิน 40 บรรทัดหรือ 3,000 ตัวอักษรต่อคำสั่ง
        ไม่มีข้อความดิบออกจาก extension
      ref: packages/core/src/terminal.ts#terminalCommand

    - id: checked
      lane: server
      at: updates
      beat:
        title: "Geno ตรวจคำตอบ"
        text: >-
          ถ้า VS Code ตอบผิดรูป หรือไม่มี editor แสดง session อยู่ call ล้มเหลวพร้อมเหตุผล
        from: engine
        to: engine
      do: >-
        engine ตรวจคำตอบด้วย `readTerminalResponse` ถ้า editor ตอบผิดรูปหรือไม่มี editor แสดง session อยู่ call ล้มเหลวพร้อมเหตุผล
      ref: packages/engine/src/tools/terminal.ts#readTerminalResponse

    - id: fenced
      lane: tool
      at: executor
      beat:
        title: "Geno ล้อมรั้ว output ว่าเป็นข้อมูล"
        text: >-
          แต่ละคำสั่งเขียนเป็นบรรทัดคำสั่ง โฟลเดอร์ และ exit code ตามด้วย output ในรั้ว คือแท็ก `<terminal_output>` ที่ครอบไว้
          บรรทัดท้ายบอกว่านี่คือข้อมูล ไม่ใช่คำสั่ง เพื่อกันข้อความใน output ที่พยายามสั่ง model
          ตัวอักษรที่มองไม่เห็นถูกตัดทิ้ง ผลกลับมาที่แชต และถึง model ตอนเรียกครั้งถัดไป
        from: engine
        to: engine
        sees: { kind: step, label: read_terminal, status: done, output: "[1] $ pnpm install\nin /home/dev/shop, exit code 0\n[2] $ pnpm build\nin /home/dev/shop, exit code 1" }
      do: >-
        `terminalReadText` เขียนแต่ละคำสั่งเป็น `$ pnpm build` โฟลเดอร์ และ exit code ตามด้วย output ในรั้ว `<terminal_output>`
        บรรทัดท้ายบอกว่านี่คือข้อมูล ไม่ใช่คำสั่ง และความลับถูกแทนด้วย `[redacted]` จากนั้น `toolText` ตัดตัวอักษรซ่อนทิ้ง
      ref: packages/core/src/terminal.ts#terminalReadText
      emits: [terminal_output]

    - use: tool-result-returns

    - id: next
      lane: loop
      at: step
      beat:
        title: "Model อธิบายว่า build พังเพราะอะไร"
        text: >-
          Geno เรียก model ต่อ โดยส่งผลเป็น `tool_result` ท้ายคำขอ model อ่าน error ของ build จากเทอร์มินัลแล้วอธิบายสาเหตุ
          การ์ดข้างล่างคือ `tool_result` จากการบันทึกเดียวกัน ดู `content` ที่ไฮไลต์ บรรทัดแรกบอกว่าได้ 2 คำสั่งล่าสุด เรียงจากเก่าไปใหม่
          ในรั้ว `<terminal_output>` มี `[1] $ pnpm install` ที่ผ่าน (exit code 0, แท็บแรก) และ `[2] $ pnpm build` ที่ล้ม (exit code 1, แท็บสอง)
          แต่ละคำสั่งมีโฟลเดอร์ exit code และ output ของมัน ท้ายผลมีบรรทัดที่บอกว่าเป็นข้อมูล ไม่ใช่คำสั่ง model อ่าน error ของคำสั่งที่ 2
        from: engine
        to: model
        end: "model อธิบายสาเหตุ"
        sees:
          - kind: payload
            source: packages/docs/src/data/recorded/tool-read-terminal.jsonl#line=7
            select: messages[-1]
            highlight: ['content[0].content']
            quote: the last 2 commands, oldest first.
          - kind: payload
            source: packages/docs/src/data/recorded/tool-read-terminal.jsonl#line=7
            select: messages[-1]
            highlight: ['content[0].content']
            quote: "[2] $ pnpm build\nin /home/dev/shop, exit code 1\n> shop@ build /home/dev/shop\n> tsc -p .\n\nsrc/update.ts(3,59): error TS2554: Expected 1 arguments, but got 2."
      do: >-
        `loopStep` เห็น `tool-result` ล่าสุดจึงตัดสิน `call-model` model อ่าน error ของ build จากเทอร์มินัลแล้วอธิบายสาเหตุ
      ref: packages/core/src/loop.ts#loopStep
      emits: [call-model]
      phase: calling-model
      end: { turn: continues, reason: call-model }
---

`read_terminal` ให้ model เห็นสิ่งที่ผู้ใช้รันเองนอก Geno โดยผู้ใช้ไม่ต้องคัดลอก output มาวาง
ข้อมูลทั้งหมดผ่าน extension ก่อน engine ไม่เคยเห็นเทอร์มินัลดิบ

| ผลที่ extension ตอบ | model ได้อ่าน |
| --- | --- |
| ไม่มีเทอร์มินัลเปิด | "The user has no terminal open in VS Code." |
| เทอร์มินัลไม่มี shell integration | วิธีเปิด shell integration และให้ขอผู้ใช้รันใหม่หรือวาง output |
| ไม่มีคำสั่งตั้งแต่ Geno เริ่ม | ให้ขอผู้ใช้รันคำสั่งอีกครั้ง |
| ชื่อเทอร์มินัลที่ไม่มี | รายชื่อเทอร์มินัลที่เปิดอยู่ |

สิ่งที่ควรสังเกต

- **คำสั่งก่อน extension ทำงานไม่ถูกเก็บ** `TerminalRecorder` อ่าน output ได้เฉพาะคำสั่งที่เริ่มหลังจากมันฟังแล้ว
  ผู้ใช้ที่ reload หน้าต่างหลังรัน build ต้องรันใหม่
- **ลบความลับก่อนตัด** `redactSecrets` ทำงานบน output ทั้งก้อนก่อนเก็บแค่ท้าย ความลับจึงไม่ถูกตัดครึ่งจนหลุดรูปแบบที่จับได้
  ต่างจาก output ของ `bash` ที่ไม่ผ่าน `redactSecrets`
- **ไม่มีการ์ด** การอ่านเทอร์มินัลไม่ผ่าน `settle` เลย ไม่มีกฎ workspace หรือ classifier ที่กันมันได้ ยกเว้น [hook](/start/glossary/) PreToolUse

ตัวอักษรที่ถูกตัดทิ้ง ดู [ตัวอักษรที่มองไม่เห็นในไฟล์](/scenarios/sec/hidden-unicode/)
