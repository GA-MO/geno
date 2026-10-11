---
title: ปฏิเสธก่อนถึงการถาม
description: สองอย่างที่ไม่มีการ์ดและไม่มี classifier ในทุกโหมด เครื่องมือที่ไฟล์ settings ของ Claude Code ห้ามทั้งตัว และการค้นด้วย grep หรือ glob ที่จะแตะไฟล์ลับ
tableOfContents: false
sidebar:
  order: 10
scenario:
  surface: vscode
  given:
    - turn กำลังทำงาน ในโหมดใดก็ได้ (Ask, Auto หรือ Plan)
    - '`.claude/settings.json` ของ repo มี `"permissions": { "deny": ["WebFetch"] }`'
    - workspace มีไฟล์ `.env` และไม่มี hook ที่ตั้งไว้
  trigger: >-
    โมเดลขอเรียกเครื่องมือที่ถูกห้ามทั้งตัว หรือขอค้นข้อความในไฟล์ลับ
  covers: [perm.claude-bare-tool-deny, perm.secret-search-refused]
  related: [perm.deny-rule, perm.secret-read, tool.web-fetch, hook.project-untrusted]
  steps:
    - id: asks
      lane: model
      do: >-
        โมเดลขอเรียกเครื่องมือ และจบคำตอบด้วย `stop_reason: tool_use`
      ref: "packages/engine/src/gateway.ts#\"stopReason: message.stop_reason,\""
      emits: [tool_use]
      phase: calling-model

    - use: tool-call-opens

    - id: which
      lane: tool
      at: executor
      do: >-
        ทุก executor ของ session ถูกห่อด้วย `withPermissions` ซึ่งดูรายการเครื่องมือที่ถูกห้ามก่อนเรียกตัวเครื่องมือ
      ref: packages/engine/src/tools/agent.ts#withPermissions
      fork:
        ask: โมเดลเรียกอะไร
        options:
          - id: bare
            label: web_fetch (ไฟล์ Claude ห้ามทั้งตัว)
            steps:
              - lane: policy
                at: rules
                do: >-
                  `layeredPermissions` อ่านไฟล์ settings ทุกไฟล์ใหม่ทุกครั้งที่ถูกเรียก `claudePermissions` แปลง deny ของชื่อเปล่า
                  `WebFetch` เป็น `web_fetch` (`Bash` ครอบคลุม `bash`, `check`, `monitor` และ `preview_start` ส่วน `Edit` ครอบคลุม `edit` และ `notebook_edit`)
                  deny ใช้ได้แม้ workspace ยังไม่ trusted เพราะมันแค่ห้าม
                ref: packages/core/src/claude-permissions.ts#claudePermissions
              - lane: policy
                at: rules
                do: >-
                  `deniedTool` คืนกฎนั้น `withPermissions` สร้างบันทึก `decidedBy: rule, verdict: deny` แบบ `workspace-deny`
                  แล้วโยน `ToolDenied` ก่อนเครื่องมือได้ตรวจ URL ไม่ถึง `settle` ไม่มีการ์ด และไม่มี classifier
                ref: "packages/engine/src/tools/agent.ts#\"if (denied !== undefined) throw refusalOf({ mode: modeOf(approval), ...ruleDenial('deny', denied.text, denied.source, name), decidedBy: 'rule', verdict: 'deny' });\""
                emits: [ToolDenied, workspace-deny]
              - lane: loop
                at: tools
                do: >-
                  ผลมีสถานะ `denied` ข้อความบอกโมเดลว่า call ตรงกับกฎ deny `WebFetch` ที่ผู้ใช้ตั้งใน `.claude/settings.json`
                  ห้ามลองซ้ำ ให้หาทางอื่นหรือบอกว่ากฎกันไว้
                ref: packages/engine/src/tools/agent.ts#denialText
                emits: [denied]
              - use: tool-result-returns
              - lane: panel
                at: rail
                do: >-
                  `denialOf` เห็นว่าผู้ปฏิเสธคือกฎ ขั้นของ call ขึ้นป้ายปฏิเสธของกฎ ข้อความเต็มอยู่หลัง Show details
                sees: ขั้น "web_fetch https://..." พร้อมป้าย "Denied by a rule"
                ref: packages/extension/src/chat/render.ts#DENIED_BY
              - lane: loop
                at: step
                do: >-
                  `loopStep` ตัดสิน `call-model` turn ไม่จบ โมเดลอ่านคำปฏิเสธแล้วทำต่อโดยไม่ใช้เว็บ
                ref: packages/core/src/loop.ts#loopStep
                emits: [call-model]
                phase: calling-model
                end: { turn: continues, reason: call-model }

          - id: secret
            label: grep หา API_KEY ใน .env
            steps:
              - lane: tool
                at: executor
                do: >-
                  `grep` ไม่ได้ถูกห้าม จึงทำงาน `scopeOf` เห็นว่า path `.env` ตรงกฎในตัวของ Geno สำหรับไฟล์เก็บรหัส
                  จึงโยน `ToolError` ทันทีโดยไม่ถามใคร เพราะการค้นถามผู้ใช้ไม่ได้ (การ `read` ไฟล์เดียวกันถามได้)
                ref: packages/engine/src/tools/context.ts#secretRefusal
                emits: [off limits]
              - lane: tool
                at: executor
                do: >-
                  ผลมีสถานะ `error` ข้อความว่า ".env is off limits to grep: it matches Geno's built-in rule for credentials files ..."
                  และบอกให้ถามผู้ใช้ถ้างานต้องการค่าจากไฟล์นั้น
                ref: "packages/engine/src/tools/index.ts#\"if (error instanceof ToolError) return { status: 'error', text: error.message };\""
              - use: tool-result-returns
              - lane: loop
                at: step
                do: >-
                  `loopStep` ตัดสิน `call-model` turn ไม่จบ ไม่มีป้ายปฏิเสธ ขั้นของ `grep` แสดงเป็นล้มเหลว
                ref: packages/core/src/loop.ts#loopStep
                emits: [call-model]
                phase: calling-model
                end: { turn: continues, reason: call-model }
---

ทั้งสองทางไม่ขึ้นกับโหมด และไม่ผ่านจุดที่การ์ดหรือ classifier ทำงาน

| | ไฟล์ Claude ห้ามทั้งตัว | `grep`/`glob` กับไฟล์ลับ |
| --- | --- | --- |
| ตรวจที่ | `withPermissions` ก่อนเครื่องมือทำงาน | ตัวเครื่องมือ ก่อนค้น |
| สถานะของผล | `denied` (Denied by a rule) | `error` (ขั้นล้มเหลว) |
| ทางที่ถามได้ | ไม่มี ต้องแก้ไฟล์ settings | `read` ไฟล์นั้น ซึ่งถามผู้ใช้ ดู [อ่านไฟล์ลับอย่าง .env](/scenarios/perm/secret-read/) |

สิ่งที่ควรสังเกต

- **เครื่องมือที่ถูกห้ามยังอยู่ในรายการ** Geno ยังส่ง `web_fetch` ให้โมเดลทุกคำขอ เพื่อให้ prompt cache ไม่หลุดเมื่อไฟล์เปลี่ยน
  โมเดลจึงอาจเรียกมันแล้วได้คำปฏิเสธ แทนที่จะไม่รู้ว่ามี
- **การค้นแบบเหมาไม่แตะไฟล์ลับ** `grep -r API_KEY .` ทั้ง workspace ข้ามไฟล์ลับไปเงียบๆ การปฏิเสธเกิดเฉพาะเมื่อ path หรือ glob ชี้ไปที่ไฟล์ลับตรงๆ
- **`bash cat .env` ไม่ใช่ทางนี้** คำสั่ง shell ที่มีคำแบบไฟล์ลับไปที่กฎ `secret-path` ซึ่งถาม ส่งให้ classifier หรือปฏิเสธตามโหมด
  และ sandbox ยังกันโฟลเดอร์อย่าง `~/.ssh` และ `~/.aws` จากทุกคำสั่ง
