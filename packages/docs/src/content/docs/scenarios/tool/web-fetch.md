---
title: "Model ดึงหน้าเว็บด้วย web_fetch"
description: โมเดลเรียก web_fetch กับหน้าเว็บของโฮสต์อื่น โหมด Ask ถามผู้ใช้ก่อน แล้ว engine ดึงหน้า ให้โมเดลผู้ช่วยอ่านและตอบคำถาม ผลไปถึงโมเดลในรั้วข้อมูล
tableOfContents: false
sidebar:
  order: 9
scenario:
  surface: vscode
  given:
    - turn กำลังทำงานในโหมด Ask
    - ยังไม่มีกฎ `WebFetch(domain:date-fns.org)` ของ workspace
  trigger: >-
    โมเดลเรียก `web_fetch` ด้วย `url` "https://date-fns.org/docs/format" และ `question` "รูปแบบ token ของวันในสัปดาห์คืออะไร"
  covers: [tool.web-fetch]
  related: [perm.ask-allow, perm.always-allow-workspace, perm.ask-deny-ends-turn]
  steps:
    - id: asks
      lane: model
      beat:
        title: "Model ขอดึงหน้าเว็บพร้อมคำถาม"
        text: >-
          โมเดลขอดึง https://date-fns.org/docs/format พร้อมคำถามว่า "รูปแบบ token ของวันในสัปดาห์คืออะไร" run
          จริงด้านล่างเรียก `web_fetch` แบบเดียวกันกับ example.com
        from: model
        to: engine
        sees:
          kind: payload
          direction: response
          source: docs/results/real-usecases/runs/A05-deferred-web-fetch/1/session.jsonl#seq=7
          select: content
          collapse:
            - "[0].thinking"
      do: >-
        โมเดลส่งบล็อก `tool_use` ของ `web_fetch` พร้อม URL และคำถามที่อยากรู้จากหน้านั้น จบด้วย `stop_reason: tool_use`
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
        title: "แชตขึ้นขั้นของ web_fetch"
        text: >-
          Geno จัดคิว call ให้รันทีละตัว เพราะอาจต้องถามคุณ แชตขึ้นขั้นใหม่พร้อมจุดหมุน
        from: engine
        to: panel

    - id: judge
      lane: policy
      at: rules
      beat:
        title: "Geno ตรวจกฎของโดเมน"
        text: >-
          ยังไม่มีกฎของ workspace สำหรับ date-fns.org กฎของ URL ภายนอกในโหมด Ask คือถาม ไม่มี hook ตอบแทน Geno
          จึงส่งคำถามไปที่แชต พร้อมกฎของโดเมนให้เลือกบันทึก งานใน Tasks เปลี่ยนเป็นรอคุณ
        from: engine
        to: panel
      do: >-
        `webDenialFor` ดูกฎโดเมนของ workspace ก่อน ไม่พบ จึงใช้กฎ `web-remote-url` ซึ่งในโหมด Ask คือถาม
        (Plan อนุญาต Auto ส่งให้ classifier) และแนบกฎ `WebFetch(domain:date-fns.org)` ไว้ให้เลือกบันทึก
      ref: packages/core/src/web.ts#webDenialFor
      emits: [web-remote-url]

    - id: settle
      lane: policy
      at: settle
      do: >-
        `settle` ไม่มี hook ตอบแทน จึงส่งคำถามต่อให้ผู้ใช้ผ่าน `approval.approve`
      ref: packages/engine/src/tools/agent.ts#settle

    - id: ask
      lane: server
      at: approvals
      do: >-
        `editorTurn.approve` ส่งคำขอ ACP `session/request_permission` ตัวเลือกมีปุ่มบันทึกกฎเพราะคำขอนี้แนบกฎมา
        งานในแผง Tasks เปลี่ยนเป็น `needs-input`
      ref: packages/engine/src/serve.ts#editorTurn.approve
      emits: [requestPermission, needs-input]
      phase: waiting-user

    - id: forward
      lane: editor
      at: chat
      do: >-
        `askPermission` ส่ง action `permission` ให้ webview และโฟกัสแผงแชต
      ref: packages/extension/src/chat/chat.ts#Chat.askPermission
      emits: [permission]

    - id: card
      lane: panel
      at: card
      beat:
        title: "คุณเห็นการ์ด “Fetch from date-fns.org?”"
        text: >-
          การ์ดของการดึงเว็บมีไอคอนลูกโลกและชื่อโฮสต์ turn รออยู่ตรงนี้ ลองเลือกแต่ละทาง
        from: panel
        to: you
        ask: "กดปุ่มไหน"
        sees: "การ์ด \"Fetch from date-fns.org?\" \"Geno asks about fetching a page from another host.\" ปุ่ม Allow, Deny, Always allow in this workspace และ No, and tell the agent…"
      do: >-
        การ์ดใช้หน้าตาของการดึงเว็บ ไอคอนลูกโลก หัวข้อบอกชื่อโฮสต์
      sees: >-
        "Fetch from date-fns.org?" "Geno asks about fetching a page from another host."
        [Allow] [Deny] [Always allow in this workspace] [No, and tell the agent…]
      ref: "packages/extension/src/chat/render.ts#\"fetch: reachFace('Geno asks to fetch a page', 'globe'),\""

    - id: choice
      lane: user
      do: ผู้ใช้เลือกปุ่มบนการ์ด
      fork:
        ask: ผู้ใช้กดปุ่มไหน
        options:
          - id: allow
            label: Allow
            then: get
            steps:
              - lane: editor
                at: chat
                beat:
                  title: "คุณกด Allow"
                  text: >-
                    การ์ดย่อเหลือ Allowed Geno จดว่าคุณอนุญาตครั้งนี้
                  from: you
                  to: engine
                do: >-
                  การ์ดย่อเหลือ Allowed `askPermission` ตอบ engine ว่า `selected` ตัวเลือก `allow`
                ref: packages/extension/src/chat/chat.ts#Chat.askPermission
                emits: [permission-done]
              - lane: server
                at: approvals
                do: >-
                  `permissionAnswerOf` แปลงคำตอบเป็น `allow`
                ref: packages/engine/src/serve.ts#permissionAnswerOf
              - lane: policy
                at: settle
                do: >-
                  `settle` คืนบันทึก `decidedBy: user, verdict: allow`
                ref: packages/engine/src/tools/agent.ts#settle
                phase: running-tools
          - id: allow-workspace
            label: Always allow in this workspace
            then: get
            steps:
              - lane: editor
                at: chat
                beat:
                  title: "คุณกด Always allow"
                  text: >-
                    Geno บันทึกกฎอนุญาต `web_fetch` สำหรับโดเมน date-fns.org ลงที่เก็บของ workspace ครั้งหน้าทุก URL
                    บนโฮสต์นี้ผ่านโดยไม่ถาม ทั้งในโหมด Ask และ Auto
                  from: you
                  to: engine
                do: >-
                  `askPermission` ตอบ engine ว่า `selected` ตัวเลือก `allow-workspace`
                ref: packages/extension/src/chat/chat.ts#Chat.askPermission
                emits: [permission-done, allow-workspace]
              - lane: server
                at: approvals
                do: >-
                  `permissionAnswerOf` แปลงคำตอบเป็น `allow-workspace`
                ref: packages/engine/src/serve.ts#permissionAnswerOf
              - lane: policy
                at: rules
                do: >-
                  ตัวเก็บกฎของ `judge` บันทึกกฎ allow `web_fetch` โดเมน `date-fns.org` ลงที่เก็บของ workspace
                  ครั้งต่อไปทุก URL บนโฮสต์นี้ผ่านโดยไม่ถาม ทั้งในโหมด Ask และ Auto
                ref: "packages/engine/src/tools/web.ts#\"await ctx.permissions?.add({ effect: 'allow', tool: 'web_fetch', domain: hostnameOf(action.target.url) });\""
                phase: running-tools
          - id: reject
            label: Deny
            steps:
              - lane: editor
                at: chat
                beat:
                  title: "คุณกด Deny"
                  text: >-
                    ไม่มีการดึงหน้า turn จบรอคุณ เหมือนการปฏิเสธคำสั่งในโหมด Ask ทัวร์นั้นเล่าต่อว่าเกิดอะไรขึ้น
                  from: you
                  to: panel
                  end: "คุณปฏิเสธ turn จบ"
                do: >-
                  `askPermission` ตอบ engine ว่า `selected` ตัวเลือก `reject`
                ref: packages/extension/src/chat/chat.ts#Chat.askPermission
                emits: [permission-done]
              - lane: server
                at: approvals
                do: >-
                  `permissionAnswerOf` แปลงคำตอบเป็น `reject`
                ref: packages/engine/src/serve.ts#permissionAnswerOf
              - lane: policy
                at: settle
                do: >-
                  `settle` คืนบันทึก `verdict: deny` และ `judge` โยน `ToolRejected` ไม่มีการดึงหน้า turn จบรอผู้ใช้
                  เหมือนการปฏิเสธคำสั่งในโหมด Ask
                ref: packages/engine/src/tools/agent.ts#refusalOf
                emits: [ToolRejected]
                phase: running-tools
                goto: perm.ask-deny-ends-turn

    - id: get
      lane: external
      beat:
        title: "Engine ดึงหน้าเองนอก sandbox"
        text: >-
          engine ปฏิเสธที่อยู่ภายในเครื่องหรือเครือข่ายส่วนตัว ถ้าหน้าพาไปโฮสต์อื่น
          การไปต่อแต่ละครั้งผ่านกฎและการถามใหม่ หน้าที่ตอบ error หรือช้าเกินทำให้ call ล้มเหลว
        from: engine
        to: machine
      do: >-
        engine ดึงหน้าเองนอก sandbox ผ่าน `guardedResolve` ซึ่งปฏิเสธที่อยู่ภายในเครื่องหรือเครือข่ายส่วนตัวและตรึง DNS ไว้
        ถ้าหน้าพาไปโฮสต์อื่น การไปต่อแต่ละครั้งผ่านกฎและการถามใหม่ หน้าที่ตอบ HTTP 400 ขึ้นไปหรือช้าเกินกำหนดทำให้ call ล้มเหลว
      ref: "packages/engine/src/tools/web.ts#\"response = await get(here, resolve, limit.signal);\""

    - id: read
      lane: external
      beat:
        title: "Model ผู้ช่วยอ่านหน้าแล้วตอบคำถาม"
        text: >-
          หน้าถูกแปลงเป็น markdown แล้วให้โมเดลผู้ช่วยที่ถูกที่สุดอ่านและตอบคำถาม โมเดลหลักจึงไม่ต้องอ่านทั้งหน้า
        from: model
        to: engine
      do: >-
        โมเดลผู้ช่วยอ่านหน้าที่แปลงเป็น markdown แล้วตอบ `question` เลือกโมเดลที่ถูกที่สุดก่อน:
        โมเดลของบทบาท explore ถ้าตั้งไว้ แล้ว classifier แล้วจึงเป็นโมเดลของ session
      ref: packages/engine/src/tools/web.ts#readerChoices

    - id: answer
      lane: tool
      at: executor
      beat:
        title: "Geno ล้อมรั้วคำตอบว่าเป็นข้อมูล"
        text: >-
          คำตอบอยู่ในรั้ว ข้อความในหน้าที่พยายามปิดรั้วเองถูกทำให้ใช้ไม่ได้ ผลมีบันทึกว่าคุณอนุญาต แล้วกลับมาที่แชต
        from: engine
        to: engine
        sees: { kind: step, label: fetch date-fns.org, status: done }
      do: >-
        `web_fetch` ห่อคำตอบในรั้ว `<web_fetch_answer>` ข้อความในหน้าที่พยายามปิดรั้วเองถูกทำให้ใช้ไม่ได้
        ผลมีบันทึกว่าผู้ใช้อนุญาต (`approval`) อัปเดตผลของ call นี้จึงมี `APPROVAL_META`
      ref: packages/core/src/web.ts#fetchAnswerText

    - use: tool-result-returns

    - id: next
      lane: loop
      at: step
      beat:
        title: "Model ได้คำตอบจากหน้าเว็บ"
        text: >-
          Geno เรียกโมเดลต่อ โมเดลได้คำตอบของคำถาม ไม่ใช่หน้าเว็บทั้งหน้า
        from: engine
        to: model
        end: "model ทำต่อ"
      do: >-
        `loopStep` เห็น `tool-result` ล่าสุดจึงตัดสิน `call-model` โมเดลได้คำตอบจากหน้าเว็บ ไม่ใช่หน้าเว็บทั้งหน้า
      ref: packages/core/src/loop.ts#loopStep
      emits: [call-model]
      phase: calling-model
      end: { turn: continues, reason: call-model }
---

`web_fetch` ไม่ส่งหน้าเว็บให้โมเดลหลัก มันส่งหน้าให้โมเดลผู้ช่วยตัวเล็กอ่านแล้วตอบคำถาม
โมเดลหลักจึงได้คำตอบสั้นๆ ในรั้วข้อมูล ซึ่งกันไม่ให้ข้อความในหน้าเว็บกลายเป็นคำสั่ง

| โหมด | URL ของโฮสต์อื่น |
| --- | --- |
| Ask | ถามผู้ใช้ |
| Auto | classifier ตัดสิน |
| Plan | อนุญาต |
| ไม่มีคนดู (non-interactive) | ปฏิเสธ |

URL บนเครื่องนี้ (`localhost`) ผ่านเสมอ และ URL ที่ `web_fetch` ห้ามดึงถูกปฏิเสธเสมอในทุกโหมด

สิ่งที่ควรสังเกต

- **การดึงไม่ได้อยู่ใน sandbox** sandbox ปิดเครือข่ายของคำสั่ง shell แต่ `web_fetch` รันใน process ของ engine
  ด่านของมันคือกฎ `web-remote-url` และ `guardedResolve` ที่ห้ามที่อยู่ส่วนตัว
- **Always allow บันทึกเป็นโดเมน** ไม่ใช่ URL กฎ `WebFetch(domain:date-fns.org)` ครอบคลุมทุกหน้าบนโฮสต์นั้น
- **Plan ดึงเว็บได้** ต่างจากคำสั่ง shell การอ่านเว็บไม่เปลี่ยนอะไรใน workspace โหมด Plan จึงอนุญาต

อ่านต่อที่ [Model ค้นเว็บด้วย web_search](/scenarios/tool/web-search/)
