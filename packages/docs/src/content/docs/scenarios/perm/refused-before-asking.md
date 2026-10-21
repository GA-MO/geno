---
title: "Geno ปฏิเสธก่อนถึงการถาม"
description: สองอย่างที่ไม่มีการ์ดและไม่มี classifier ในทุกโหมด tool ที่ไฟล์ settings ของ Claude Code ห้ามทั้งตัว และการค้นด้วย grep หรือ glob ที่จะแตะไฟล์ลับ
scenario:
  surface: vscode
  given:
    - turn กำลังทำงาน ในโหมดใดก็ได้ (Ask, Auto หรือ Plan)
    - '`.claude/settings.json` ของ repo มี `"permissions": { "deny": ["WebFetch"] }`'
    - workspace มีไฟล์ `.env` และไม่มี hook ที่ตั้งไว้
  trigger: >-
    model ขอเรียก tool ที่ถูกห้ามทั้งตัว หรือขอค้นข้อความในไฟล์ลับ
  covers: [perm.claude-bare-tool-deny, perm.secret-search-refused]
  related: [perm.deny-rule, perm.secret-read, tool.web-fetch, hook.project-untrusted]
  steps:
    - id: asks
      lane: model
      beat:
        title: "Model ขอใช้ tool"
        text: >-
          `.claude/settings.json` ของ repo ห้าม WebFetch ทั้งตัว ไฟล์นี้เป็นไฟล์ตั้งค่าของ Claude Code
          (agent อีกตัวหนึ่ง) ซึ่ง Geno อ่านกฎสิทธิ์ของมันด้วย และ workspace มีไฟล์ `.env` model ขอเรียก tool
          แล้วแชตขึ้นขั้นใหม่พร้อมจุดหมุน การ์ดข้างล่างเป็นคำตอบจริงของ model ในการรันที่ใช้ในทางค้นไฟล์ลับ
          model ขอ `glob` หา `.env*` คู่กับการอ่านสองไฟล์ ดู `input` ของ `glob` ที่ไฮไลต์
        from: model
        to: engine
        sees:
          kind: payload
          source: docs/results/real-usecases/runs/A14-deny-rules/1/session.jsonl#seq=8
          select: content
          collapse: ['[0].thinking']
          highlight: ['[4].input']
      do: >-
        model ขอเรียก tool และจบคำตอบด้วย `stop_reason: tool_use`
      ref: "packages/engine/src/gateway.ts#\"stopReason: message.stop_reason,\""
      emits: [tool_use]
      phase: calling-model

    - use: tool-call-opens

    - id: which
      lane: tool
      at: executor
      beat:
        title: "Geno ดูรายการ tool ที่ถูกห้ามก่อน"
        text: >-
          ทุก tool ของ session ผ่านด่านที่ดูรายการ tool ที่ถูกห้ามก่อนตัว tool จะทำงาน ลองเลือกว่า model เรียกอะไร
        from: engine
        to: engine
        ask: "เรียกอะไร"
      runs: 0
      do: >-
        ทุก executor ของ session ถูกห่อด้วย `withPermissions` ซึ่งดูรายการ tool ที่ถูกห้ามก่อนเรียกตัว tool
      ref: packages/engine/src/tools/agent.ts#withPermissions
      fork:
        ask: model เรียกอะไร
        options:
          - id: bare
            label: web_fetch (ไฟล์ Claude ห้ามทั้งตัว)
            steps:
              - lane: policy
                at: rules
                beat:
                  title: "ไฟล์ settings ของ Claude Code ห้าม WebFetch"
                  text: >-
                    Geno อ่านไฟล์ settings ทุกไฟล์ใหม่ทุกครั้ง แล้วแปลงชื่อ WebFetch ของ Claude Code เป็น `web_fetch` ของ Geno
                    กฎห้ามใช้ได้แม้คุณยังไม่ได้ยืนยันว่าเชื่อถือ workspace นี้ (trusted) เพราะมันแค่ห้าม
                  from: engine
                  to: engine
                do: >-
                  `layeredPermissions` อ่านไฟล์ settings ทุกไฟล์ใหม่ทุกครั้งที่ถูกเรียก `claudePermissions` แปลง deny ของชื่อเปล่า
                  `WebFetch` เป็น `web_fetch` (`Bash` ครอบคลุม `bash`, `check`, `monitor` และ `preview_start` ส่วน `Edit` ครอบคลุม `edit` และ `notebook_edit`)
                  deny ใช้ได้แม้ workspace ยังไม่ trusted เพราะมันแค่ห้าม
                ref: packages/core/src/claude-permissions.ts#claudePermissions
              - lane: policy
                at: rules
                beat:
                  title: "Geno ปฏิเสธก่อน tool ได้ตรวจ URL"
                  text: >-
                    Geno จดว่ากฎเป็นผู้ปฏิเสธ แล้วหยุด call ก่อน tool ได้ดู URL ไม่มีการ์ดและไม่มี classifier (การเรียก model แยกที่ตัดสินคำสั่งแทนคุณในโหมด Auto) ในทุกโหมด
                  from: engine
                  to: engine
                do: >-
                  `deniedTool` คืนกฎนั้น `withPermissions` สร้างบันทึก `decidedBy: rule, verdict: deny` แบบ `workspace-deny`
                  แล้วโยน `ToolDenied` ก่อน tool ได้ตรวจ URL ไม่ถึง `settle` ไม่มีการ์ด และไม่มี classifier
                ref: "packages/engine/src/tools/agent.ts#\"if (denied !== undefined) throw refusalOf({ mode: modeOf(approval), ...ruleDenial('deny', denied.text, denied.source, name), decidedBy: 'rule', verdict: 'deny' });\""
                emits: [ToolDenied, workspace-deny]
              - lane: loop
                at: tools
                beat:
                  title: "Geno เตรียมผลว่ากฎของคุณห้าม"
                  text: >-
                    Geno เขียนข้อความผลไว้ใน log ผลนี้ถึง model ตอนเรียกครั้งถัดไป ระหว่างนี้ model ไม่ได้ตอบอะไร
                    ผลบอกว่า call ตรงกับกฎห้าม WebFetch ที่คุณตั้งไว้ ห้ามลองซ้ำ ให้หาทางอื่นหรือบอกว่ากฎกันไว้
                    ผลกลับมาที่แชตพร้อมบันทึกของกฎ
                  from: engine
                  to: engine
                do: >-
                  ผลมีสถานะ `denied` ข้อความบอก model ว่า call ตรงกับกฎ deny `WebFetch` ที่ผู้ใช้ตั้งใน `.claude/settings.json`
                  ห้ามลองซ้ำ ให้หาทางอื่นหรือบอกว่ากฎกันไว้ `ToolDenied` พาบันทึกของกฎ (`approval`) มากับผล
                  อัปเดตผลของ call นี้จึงมี `APPROVAL_META` ซึ่งแผงใช้ขึ้นป้าย
                ref: packages/engine/src/tools/agent.ts#denialText
                emits: [denied]
              - use: tool-result-returns
              - lane: panel
                at: rail
                beat:
                  title: "แชตขึ้นป้าย Denied by a rule"
                  text: >-
                    ขั้นของ call ขึ้นป้ายปฏิเสธของกฎ ข้อความเต็มที่ model ได้อยู่หลัง Show details
                  from: panel
                  to: you
                  sees: { kind: step, label: web_fetch https://date-fns.org, status: denied, note: Denied by a rule }
                do: >-
                  `denialOf` เห็นว่าผู้ปฏิเสธคือกฎ ขั้นของ call ขึ้นป้ายปฏิเสธของกฎ ข้อความเต็มอยู่หลัง Show details
                sees: ขั้น "web_fetch https://..." พร้อมป้าย "Denied by a rule"
                ref: packages/extension/src/chat/render.ts#DENIED_BY
              - lane: loop
                at: step
                beat:
                  title: "Model ทำต่อโดยไม่ใช้เว็บ"
                  text: >-
                    turn ไม่จบ Geno ส่งบทสนทนาทั้งหมดไปให้ model อีกครั้งในคำขอใหม่ ท้ายคำขอคือคำขอของ model
                    และผลปฏิเสธที่ Geno เตรียมไว้ model จึงทำงานต่อโดยไม่ใช้เว็บ การ์ดข้างล่างเป็นคำขอจริงจากการรันที่กฎของ
                    workspace ใน `.g-code/settings.json` ห้าม `curl` แบบเดียวกัน ในรอบนั้น model ขอ `list` คู่กับ `curl`
                    ข้อความท้ายจึงมีผลสองชิ้น ชิ้นที่สองคือคำปฏิเสธ
                  from: engine
                  to: model
                  end: "กฎห้าม turn ทำต่อ"
                  sees:
                    kind: payload
                    source: docs/results/real-usecases/runs/A14-deny-rules/sonnet-1/wire.jsonl#line=3
                    select: messages
                    collapse: ['[0]']
                    highlight: ['[1].content[2]', '[2].content[1]']
                do: >-
                  `loopStep` ตัดสิน `call-model` turn ไม่จบ model อ่านคำปฏิเสธแล้วทำต่อโดยไม่ใช้เว็บ
                ref: packages/core/src/loop.ts#loopStep
                emits: [call-model]
                phase: calling-model
                end: { turn: continues, reason: call-model }

          - id: secret
            label: grep หา API_KEY ใน .env
            steps:
              - lane: tool
                at: executor
                beat:
                  title: "grep เห็นว่า .env เป็นไฟล์ลับ"
                  text: >-
                    `grep` ไม่ได้ถูกห้าม จึงทำงาน แต่ `.env` ตรงกฎในตัวของ Geno สำหรับไฟล์เก็บรหัส การค้นถามคุณไม่ได้
                    ต่างจากการอ่านไฟล์เดียวกันที่ถามได้ จึงล้มทันที
                  from: engine
                  to: machine
                do: >-
                  `grep` ไม่ได้ถูกห้าม จึงทำงาน `scopeOf` เห็นว่า path `.env` ตรงกฎในตัวของ Geno สำหรับไฟล์เก็บรหัส
                  จึงโยน `ToolError` ทันทีโดยไม่ถามใคร เพราะการค้นถามผู้ใช้ไม่ได้ (การ `read` ไฟล์เดียวกันถามได้)
                ref: packages/engine/src/tools/context.ts#secretRefusal
                emits: [off limits]
              - lane: tool
                at: executor
                beat:
                  title: "Geno เตรียม error ที่บอกให้ถามคุณ"
                  text: >-
                    Geno เขียนข้อความผลไว้ใน log ผลนี้ถึง model ตอนเรียกครั้งถัดไป ระหว่างนี้ model ไม่ได้ตอบอะไร
                    ผลเป็น error ที่บอกว่าไฟล์นั้นห้ามค้น และบอกให้ถามคุณถ้างานต้องการค่าจากไฟล์นั้น ไม่มีบันทึกการปฏิเสธ
                    run จริงด้านล่างใช้ `glob` และได้ข้อความแบบเดียวกัน การ์ดแสดงท้ายของ error: ห้ามหาเนื้อไฟล์ทางอื่น และถ้างานต้องการค่าจากไฟล์ ให้ถามคุณ
                  from: engine
                  to: engine
                  sees:
                    kind: payload
                    source: docs/results/real-usecases/runs/A14-deny-rules/1/requests.jsonl#seq=13
                    select: messages[-1].content[2]
                    highlight: [content]
                    quote: If the task needs a value from it, ask the user.
                do: >-
                  ผลมีสถานะ `error` ข้อความว่า ".env is off limits to grep: it matches Geno's built-in rule for credentials files ..."
                  และบอกให้ถามผู้ใช้ถ้างานต้องการค่าจากไฟล์นั้น `ToolError` ไม่มีบันทึกการอนุญาต อัปเดตผลจึงไม่มี `APPROVAL_META`
                ref: "packages/engine/src/tools/index.ts#\"if (error instanceof ToolError) return { status: 'error', text: error.message };\""
              - use: tool-result-returns
              - lane: loop
                at: step
                beat:
                  title: "Model ทำต่อ ขั้นของ grep ล้มเหลว"
                  text: >-
                    turn ไม่จบ แชตไม่ขึ้นป้ายปฏิเสธ ขั้นของ `grep` แสดงเป็นล้มเหลว Geno ส่งบทสนทนาทั้งหมดไปให้ model
                    อีกครั้งในคำขอใหม่ ท้ายคำขอคือคำขอค้นของ model และ error ที่ Geno เตรียมไว้ การ์ดข้างล่างเป็นคำขอจริงจากการรันเดียวกับการ์ดก่อนหน้า
                    ในรอบนั้น model ขอสาม call พร้อมกัน ข้อความท้ายจึงมีผลสามชิ้น ชิ้นที่สามคือ error ของ `glob`
                  from: engine
                  to: model
                  end: "ไฟล์ลับห้ามค้น turn ทำต่อ"
                  sees:
                    kind: payload
                    source: docs/results/real-usecases/runs/A14-deny-rules/1/requests.jsonl#seq=13
                    select: messages
                    collapse: ['[0]', '[1]', '[2]']
                    highlight: ['[3].content[4]', '[4].content[2]']
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
| ตรวจที่ | `withPermissions` ก่อน tool ทำงาน | ตัว tool ก่อนค้น |
| สถานะของผล | `denied` (Denied by a rule) | `error` (ขั้นล้มเหลว) |
| ทางที่ถามได้ | ไม่มี ต้องแก้ไฟล์ settings | `read` ไฟล์นั้น ซึ่งถามผู้ใช้ ดู [Model อ่านไฟล์ลับอย่าง .env](/scenarios/perm/secret-read/) |

สิ่งที่ควรสังเกต

- **tool ที่ถูกห้ามยังอยู่ในรายการ** Geno ยังส่ง `web_fetch` ให้ model ทุกคำขอ เพื่อให้ prompt cache ไม่หลุดเมื่อไฟล์เปลี่ยน
  model จึงอาจเรียกมันแล้วได้คำปฏิเสธ แทนที่จะไม่รู้ว่ามี
- **การค้นแบบเหมาไม่แตะไฟล์ลับ** `grep -r API_KEY .` ทั้ง workspace ข้ามไฟล์ลับไปเงียบๆ การปฏิเสธเกิดเฉพาะเมื่อ path หรือ glob ชี้ไปที่ไฟล์ลับตรงๆ
- **`bash cat .env` ไม่ใช่ทางนี้** คำสั่ง shell ที่มีคำแบบไฟล์ลับไปที่กฎ `secret-path` ซึ่งถาม ส่งให้ classifier หรือปฏิเสธตามโหมด
  และ sandbox ยังกันโฟลเดอร์อย่าง `~/.ssh` และ `~/.aws` จากทุกคำสั่ง

กฎที่คุณตั้งใน Settings ดู [กฎของ workspace อนุญาตหรือปฏิเสธคำสั่ง](/scenarios/perm/workspace-rules/)
