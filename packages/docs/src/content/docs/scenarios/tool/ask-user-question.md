---
title: "Model ถามคุณด้วยฟอร์มคำถาม"
description: โมเดลเรียก ask_user เพื่อถามผู้ใช้กลางงาน engine ส่งฟอร์มผ่าน ACP แผงแชตแสดงการ์ดคำถาม และคำตอบหรือการข้ามกลับไปเป็นผลของ call
tableOfContents: false
sidebar:
  order: 8
scenario:
  surface: vscode
  given:
    - turn กำลังทำงานในแผงแชตของ VS Code ซึ่งบอก engine ตอน `initialize` ว่าแสดงฟอร์มได้ (`elicitation`)
    - session อยู่ในโหมด Ask หรือ Plan ตอนที่โมเดลส่งคำตอบ
  trigger: >-
    โมเดลเรียก `ask_user` ถามหนึ่งข้อ หัวข้อ "Date library" คำถาม "ใช้ไลบรารีไหนจัดการวันที่"
    ตัวเลือก `date-fns` (แนะนำ) และ `dayjs`
  covers: [tool.ask-user-question]
  related: [perm.ask-allow, ctl.stop-at-card, perm.mode-switch-mid-turn]
  steps:
    - id: asks
      lane: model
      beat:
        title: "Model ถามคุณกลางงาน"
        text: >-
          โมเดลอยากให้คุณเลือกก่อนทำต่อ มันเรียก tool ถามคำถามหนึ่งข้อว่า "ใช้ไลบรารีไหนจัดการวันที่" พร้อมตัวเลือก
          date-fns ที่มันแนะนำ และ dayjs
        from: model
        to: engine
      do: >-
        โมเดลส่งบล็อก `tool_use` ของ `ask_user` ที่มี `questions` หนึ่งข้อ พร้อมตัวเลือกและคำอธิบาย จบด้วย `stop_reason: tool_use`
      ref: "packages/engine/src/gateway.ts#\"stopReason: message.stop_reason,\""
      emits: [tool_use]
      phase: calling-model

    - id: logged
      lane: loop
      at: drive
      do: >-
        `drive` บันทึก event `assistant` ที่มีบล็อก `tool_use` ลง log
      ref: "packages/engine/src/drive.ts#\"await record({ kind: 'assistant', seq: nextSeq(events), at, ...result.turn\""
      emits: [assistant]

    - use: tool-call-opens
      beat:
        title: "แชตขึ้นขั้นของคำถาม"
        text: >-
          Geno จัดคิวคำถามนี้ให้รันทีละตัว เพราะต้องรอคุณ แชตขึ้นขั้นใหม่พร้อมจุดหมุน
        from: engine
        to: panel

    - id: mode
      lane: tool
      at: executor
      beat:
        title: "Geno ดูโหมดตอนที่ call รัน"
        text: >-
          Geno อ่านโหมดของ session ตอนที่ call รัน ไม่ใช่ตอนที่ turn เริ่ม แล้วตรวจคำถามและตัวเลือกตามขีดจำกัด
          ถ้าคุณสลับโหมดระหว่าง turn ผลจึงเปลี่ยนตาม
        from: engine
        to: engine
        ask: "โหมดไหน"
      runs: 0
      do: >-
        `ask_user` ถูกห่อด้วย `inMode` ซึ่งอ่านโหมดของ session ตอนที่ call รัน ไม่ใช่ตอนที่ turn เริ่ม
        แล้ว `parseAskUser` ตรวจคำถามและตัวเลือกตามขีดจำกัด
      ref: packages/engine/src/tools/user.ts#inMode
      fork:
        ask: ตอนนี้ session อยู่ในโหมดไหน
        options:
          - id: ask-or-plan
            label: Ask หรือ Plan
            then: elicit
          - id: auto
            label: Auto
            then: result
            steps:
              - lane: tool
                at: executor
                beat:
                  title: "โหมด Auto ไม่มีใครรอตอบ"
                  text: >-
                    โหมด Auto ไม่ถามคุณ call จึงล้มเหลวทันทีพร้อมข้อความบอกโมเดลว่าอย่าเรียกซ้ำ ไม่มีการ์ดขึ้น
                  from: engine
                  to: model
                do: >-
                  `USER_TOOL_MODES` ไม่ให้ `ask_user` ในโหมด Auto ซึ่งไม่มีใครรอตอบ call จึงล้มเหลวด้วย `ToolError`
                  "ask_user is not available in auto mode. Do not retry it." และไม่มีการ์ด
                ref: packages/core/src/user-tools.ts#USER_TOOL_MODES
                emits: [ToolError]

    - id: elicit
      lane: server
      at: approvals
      beat:
        title: "Geno ส่งฟอร์มไปที่ VS Code"
        text: >-
          Geno ส่งอัปเดตที่ค้างออกไปก่อน แล้วส่งฟอร์มคำถามไปที่ VS Code งานในแผง Tasks เปลี่ยนเป็นรอคุณ VS Code
          ตรวจคำถามด้วยตัวตรวจเดียวกับ engine แล้วโฟกัสแผงแชต
        from: engine
        to: panel
        sees: { kind: task, title: เพิ่มเทสต์ให้ parseDate, status: needs-input }
      runs: 1
      do: >-
        `editorUser.ask_user` ส่งอัปเดตที่ค้างออกไปก่อน แล้วส่งคำขอ ACP `elicitation/create` แบบฟอร์ม
        พร้อมคำถามตัวจริงใน `_meta` ใต้ `ASK_USER_META` งานในแผง Tasks เปลี่ยนเป็น `needs-input`
      ref: "packages/engine/src/serve.ts#\"async ask_user(request, signal) {\""
      emits: [ASK_USER_META, needs-input]
      phase: waiting-user

    - id: forward
      lane: editor
      at: chat
      do: >-
        `askQuestion` อ่านคำถามจาก `_meta` ผ่านตัวตรวจเดียวกับที่ engine ใช้ ส่ง action `permission` ชนิดคำถามให้ webview และโฟกัสแผงแชต
      ref: packages/extension/src/chat/chat.ts#Chat.askQuestion
      emits: [permission]

    - id: card
      lane: panel
      at: card
      beat:
        title: "คุณเห็นการ์ดคำถาม"
        text: >-
          การ์ดแสดงตัวเลือกพร้อมช่อง Other ให้พิมพ์เอง และใช้แป้นพิมพ์เลือกได้ turn รออยู่ตรงนี้ ลองเลือกแต่ละทาง
        from: panel
        to: you
        ask: "ทำอะไรกับการ์ด"
        sees: { kind: question, question: ใช้ไลบรารีไหนจัดการวันที่, options: [ date-fns (Recommended), dayjs, "Other: type your own answer" ] }
      do: >-
        `questionCard` วาดคำถามเป็นรายการตัวเลือกแบบ radio มีช่อง Other ท้ายรายการ และใช้แป้นพิมพ์เลือกได้
      sees: >-
        การ์ด "ใช้ไลบรารีไหนจัดการวันที่" ตัวเลือก date-fns (Recommended), dayjs, ช่อง "Other: type your own answer"
        ปุ่ม [Submit answers] [Skip] และคำใบ้ "↑↓ move · 1–3 pick · Enter submit · Esc skip"
      ref: packages/extension/src/chat/question-view.ts#questionCard

    - id: choice
      lane: user
      do: ผู้ใช้ตอบการ์ด turn รออยู่ตรงนี้
      fork:
        ask: ผู้ใช้ทำอะไรกับการ์ด
        options:
          - id: answer
            label: เลือก date-fns แล้ว Submit answers
            then: result
            steps:
              - lane: panel
                at: card
                beat:
                  title: "คุณเลือก date-fns แล้วกด Submit answers"
                  text: >-
                    การ์ดย่อเหลือบรรทัดเดียวที่บอกคำตอบ VS Code ส่งคำตอบกลับไปที่ engine งานใน Tasks กลับเป็นกำลังทำงาน
                  from: you
                  to: engine
                  sees: { kind: question, question: ใช้ไลบรารีไหนจัดการวันที่, options: [ date-fns (Recommended), dayjs ], chosen: date-fns (Recommended) }
                do: การ์ดโพสต์ `answer` พร้อมคำตอบ แล้วย่อเหลือบรรทัดเดียวที่บอกคำตอบ
                sees: การ์ดย่อเหลือบรรทัดที่มีเครื่องหมายถูกและ "date-fns"
                ref: "packages/extension/src/chat/question-view.ts#\"if ('submit' in step.effect) return answer({ type: 'answer', id, answer: { kind: 'answered', answers: answersOf(request, state) } });\""
                emits: [answer]
              - lane: editor
                at: chat
                do: >-
                  `askQuestion` ตอบ engine ด้วย `action: accept` และคำตอบในรูปฟอร์ม
                ref: packages/extension/src/chat/chat.ts#Chat.askQuestion
                emits: [accept]
              - lane: server
                at: approvals
                do: >-
                  เมื่อคำตอบมาถึง `askEditor` คืนงานใน Tasks เป็นกำลังทำงานก่อน แล้ว `askUserReplyOf` แปลงคำตอบเป็นคำตอบของแต่ละคำถาม
                ref: packages/engine/src/serve.ts#askUserReplyOf
                phase: running-tools
          - id: skip
            label: Skip (หรือ Esc)
            then: result
            steps:
              - lane: panel
                at: card
                beat:
                  title: "คุณกด Skip"
                  text: >-
                    การ์ดย่อเหลือคำว่า Skipped VS Code บอก engine ว่าคุณไม่ตอบ
                  from: you
                  to: engine
                do: การ์ดโพสต์ `answer` ชนิด `declined`
                sees: การ์ดย่อเหลือ "Skipped"
                ref: "packages/extension/src/chat/question-view.ts#\"if ('cancel' in step.effect) return answer({ type: 'answer', id, answer: { kind: 'declined' } });\""
                emits: [declined]
              - lane: editor
                at: chat
                do: >-
                  `askQuestion` ตอบ engine ด้วย `action: decline`
                ref: packages/extension/src/chat/chat.ts#Chat.askQuestion
                emits: [decline]
              - lane: server
                at: approvals
                do: >-
                  `askUserReplyOf` เห็นว่าไม่ใช่ `accept` จึงถือว่าผู้ใช้ไม่ตอบ
                ref: packages/engine/src/serve.ts#askUserReplyOf
                phase: running-tools

    - id: result
      lane: tool
      at: executor
      beat:
        title: "Geno เขียนผลให้ model อ่าน"
        text: >-
          ผลของ call บอกคำตอบของคุณ หรือบอกว่าคุณไม่ตอบ ให้โมเดลใช้วิจารณญาณแล้วบอกว่าสมมติอะไร
          หรือบอกว่าใช้ไม่ได้ในโหมด Auto ผลกลับมาที่แชตใต้ขั้นนั้น
        from: engine
        to: model
      do: >-
        `askUserResult` เขียนผลให้โมเดลอ่าน: "The user answered: date-fns" หรือถ้าข้าม
        "The user declined to answer. Go on with your best judgment and say what you assumed."
        ถ้า editor ที่บอกว่าแสดงฟอร์มได้กลับตอบคำขอนี้ด้วย error (`unshown`) ผลบอกให้โมเดลจบ turn แล้วถามเป็นข้อความธรรมดาแทน
      ref: packages/core/src/ask-user.ts#askUserResult

    - use: tool-result-returns

    - id: next
      lane: loop
      at: step
      beat:
        title: "Model ทำต่อตามผล"
        text: >-
          Geno เรียกโมเดลอีกรอบ โมเดลอ่านผลแล้วทำงานต่อใน turn เดิม
        from: engine
        to: model
        end: "model ทำต่อ"
      do: >-
        `loopStep` เห็น `tool-result` ล่าสุดจึงตัดสิน `call-model` โมเดลทำงานต่อตามคำตอบ
      ref: packages/core/src/loop.ts#loopStep
      emits: [call-model]
      phase: calling-model
      end: { turn: continues, reason: call-model }
---

`ask_user` เป็น tool ที่ไม่ได้ตัดสินสิทธิ์ แต่ใช้ทางเดียวกับการ์ดขออนุญาต: engine ถาม editor และ turn รออยู่ระหว่างนั้น
ต่างกันที่ ACP method การ์ดขออนุญาตใช้ `session/request_permission` ส่วนคำถามใช้ `elicitation/create` แบบฟอร์ม

| โหมด | ผล |
| --- | --- |
| Ask, Plan | การ์ดคำถาม |
| Auto | `ToolError` ไม่มีการ์ด |
| editor ที่ไม่แสดงฟอร์ม | ไม่มี tool นี้ในรายการตั้งแต่ต้น |

สิ่งที่ควรสังเกต

- **Skip ไม่จบ turn** ต่างจาก Deny บนการ์ดขออนุญาต การข้ามคำถามเป็นผลธรรมดา โมเดลทำต่อด้วยการตัดสินใจของตัวเอง
- **โหมดอ่านตอน call รัน** ถ้าผู้ใช้สลับเป็น Auto ระหว่าง turn call ถัดไปของ `ask_user` จะล้มเหลว แม้ turn เริ่มในโหมด Ask
- **Stop ปิดการ์ด** `Chat.stop` ตอบการ์ดคำถามที่เปิดอยู่ว่ายกเลิกก่อนส่ง `session/cancel` การ์ดจึงขึ้น "Cancelled"

การ์ดอีกแบบที่หยุด turn รอคุณ ดู [โหมด Ask ขอ permission ก่อนรันคำสั่ง](/scenarios/perm/ask-mode-bash-approval/)
