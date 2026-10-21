---
title: "Model ดึงหน้าเว็บด้วย web_fetch"
description: model เรียก web_fetch กับหน้าเว็บของโฮสต์อื่น โหมด Ask ถามผู้ใช้ก่อน แล้ว engine ดึงหน้า ให้ model ผู้ช่วยอ่านและตอบคำถาม ผลไปถึง model ในรั้วข้อมูล
scenario:
  surface: vscode
  given:
    - turn กำลังทำงานในโหมด Ask
    - ยังไม่มีกฎ `WebFetch(domain:date-fns.org)` ของ workspace
  trigger: >-
    model เรียก `web_fetch` ด้วย `url` "https://date-fns.org/docs/format" และ `question` "รูปแบบ token ของวันในสัปดาห์คืออะไร"
  covers: [tool.web-fetch]
  related: [perm.ask-allow, perm.always-allow-workspace, perm.ask-deny-ends-turn]
  steps:
    - id: asks
      lane: model
      beat:
        title: "Model ขอดึงหน้าเว็บพร้อมคำถาม"
        text: >-
          model ขอดึง https://date-fns.org/docs/format พร้อมคำถามว่า "รูปแบบ token ของวันในสัปดาห์คืออะไร"
          การ์ดข้างล่างมาจาก run จริงที่เรียก `web_fetch` แบบเดียวกันกับ example.com ดู `input` ที่มีสองฟิลด์
          `url` คือหน้าที่จะดึง และ `question` คือสิ่งที่ model อยากรู้จากหน้านั้น
        from: model
        to: engine
        sees:
          kind: payload
          source: docs/results/real-usecases/runs/A05-deferred-web-fetch/1/session.jsonl#seq=7
          select: content
          collapse:
            - "[0].thinking"
      do: >-
        model ส่งบล็อก `tool_use` ของ `web_fetch` พร้อม URL และคำถามที่อยากรู้จากหน้านั้น จบด้วย `stop_reason: tool_use`
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
          กฎของ workspace คือรายการที่คุณบันทึกไว้ว่าโดเมนหรือคำสั่งไหนอนุญาตหรือปฏิเสธ ยังไม่มีกฎสำหรับ date-fns.org
          กฎในตัวของ URL ภายนอกในโหมด Ask คือถามคุณ ไม่มี hook (คำสั่ง shell ที่คุณตั้งให้ตัดสินแทน) ตอบแทน Geno
          จึงส่งคำถามไปที่แชต พร้อมกฎของโดเมนให้เลือกบันทึก งานในแผง Tasks ซึ่งเป็นรายการงานของ Geno เปลี่ยนเป็นรอคุณ
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
        sees: { kind: permission, face: fetch, host: date-fns.org, command: https://date-fns.org/docs/format, reason: Geno asks about fetching a page from another host. }
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
                  to: panel
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
                  to: panel
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
          engine ดึงหน้าเองใน process ของมัน ไม่ได้รันใน sandbox ซึ่งกันเฉพาะคำสั่ง shell
          ก่อนต่อ engine เช็ก DNS ของโฮสต์ภายนอก ถ้าชื่อนั้นชี้ไปที่อยู่ภายในเครื่องหรือเครือข่ายส่วนตัว ก็ปฏิเสธ
          (ส่วน `localhost`, 127.0.0.1 และ [::1] ที่ระบุตรงๆ ดึงได้เสมอโดยไม่ถาม) ถ้าหน้าพาไปโฮสต์อื่น (redirect)
          การไปต่อแต่ละครั้งผ่านกฎและการถามใหม่ หน้าที่ตอบ HTTP 400 ขึ้นไปหรือช้าเกินทำให้ call ล้มเหลว
        from: engine
        to: machine
      do: >-
        engine ดึงหน้าเองนอก sandbox สำหรับโฮสต์ภายนอก `guardedResolve` ปฏิเสธชื่อที่ DNS ชี้ไปที่อยู่ private, loopback
        หรือ link-local และตรึงการต่อไว้ที่ที่อยู่ที่ตรวจแล้ว (กัน DNS rebinding) ส่วน `localhost` ไปทางกฎ `web-local-url` ที่อนุญาตทุกโหมด
        ถ้าหน้าพาไปโฮสต์อื่น การไปต่อแต่ละครั้งผ่านกฎและการถามใหม่ หน้าที่ตอบ HTTP 400 ขึ้นไปหรือช้าเกินกำหนดทำให้ call ล้มเหลว
      ref: "packages/engine/src/tools/web.ts#\"response = await get(here, resolve, limit.signal);\""

    - id: read
      lane: external
      beat:
        title: "Model ผู้ช่วยอ่านหน้าแล้วตอบคำถาม"
        text: >-
          หน้าถูกแปลงเป็น markdown แล้วให้ model ผู้ช่วยอ่านและตอบคำถาม (model ของบทบาท explore ถ้าตั้งไว้ ไม่อย่างนั้น model ของ classifier ถ้าตั้งไว้ ไม่อย่างนั้นใช้ model ของ session เอง) model หลักจึงไม่ต้องอ่านทั้งหน้า
          การ์ดข้างล่างเป็นคำตอบจริงของ model ผู้ช่วยจากการรันอื่นที่ดึงหน้า `/health` ของเซิร์ฟเวอร์ในเครื่อง
          ซึ่งไม่ต้องถามเพราะเป็น `localhost`
          คำตอบมาเป็น stream ทีละชิ้น ดู event ที่ไฮไลต์ `content_block_start` เปิดบล็อกข้อความ
          แล้ว `text_delta` ส่งข้อความชิ้นแรกคือ "The" ข้อความเต็มอยู่ในผลของ call ในขั้นถัดไป
        from: model
        to: engine
        sees:
          kind: payload
          source: docs/results/real-usecases/runs/A12-background-server/fix-s1-2/wire.jsonl#line=12
          highlight: ['[2].data.content_block', '[3].data.delta']
      do: >-
        model ผู้ช่วยอ่านหน้าที่แปลงเป็น markdown แล้วตอบ `question` `readerChoices` เรียงตัวเลือก:
        model ของบทบาท explore ถ้าตั้ง `GCODE_EXPLORE_PROVIDER` แล้ว model ของ classifier ถ้าตั้ง `GCODE_CLASSIFIER_*` แล้วจึงเป็น model ของ session `helperCall` ใช้ตัวแรกที่มี credentials
      ref: packages/engine/src/tools/web.ts#readerChoices

    - id: answer
      lane: tool
      at: executor
      beat:
        title: "Geno ล้อมรั้วคำตอบว่าเป็นข้อมูล"
        text: >-
          Geno ครอบคำตอบด้วยรั้ว คือแท็ก `<web_fetch_answer>` ที่บอก model ว่านี่คือข้อมูลจากเว็บ ไม่ใช่คำสั่ง
          ข้อความในหน้าที่พยายามปิดรั้วเองถูกทำให้ใช้ไม่ได้ ผลมีบันทึกว่าคุณอนุญาต แล้วกลับมาที่แชต
          ผลนี้ถึง model ตอนเรียกครั้งถัดไป
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
          Geno ส่งบทสนทนาทั้งหมดไปให้ model อีกครั้งในคำขอใหม่ ท้ายคำขอคือคำขอ `web_fetch` ของ model
          และคำตอบในรั้วที่ Geno เตรียมไว้ model ได้คำตอบของคำถาม ไม่ใช่หน้าเว็บทั้งหน้า
          การ์ดข้างล่างเป็นข้อความท้ายสุดของคำขอจริงจากการรันอื่นที่ดึงหน้า `/health` ของเซิร์ฟเวอร์ในเครื่องด้วย `web_fetch` แบบเดียวกัน
          บทสนทนาก่อนหน้ายาวเกินกว่าจะแสดงทั้งหมด ดู `content` ของ `tool_result` ที่ขึ้นต้นด้วยรั้ว `<web_fetch_answer>`
          ข้างในคือคำตอบของ model ผู้ช่วย
        from: engine
        to: model
        sees:
          kind: payload
          source: docs/results/real-usecases/runs/A12-background-server/fix-s1-2/wire.jsonl#line=13
          select: messages[-1]
          highlight: ['content[0]']
      do: >-
        `loopStep` เห็น `tool-result` ล่าสุดจึงตัดสิน `call-model` model ได้คำตอบจากหน้าเว็บ ไม่ใช่หน้าเว็บทั้งหน้า
      ref: packages/core/src/loop.ts#loopStep
      emits: [call-model]
      phase: calling-model

    - id: reply
      lane: model
      beat:
        title: "Model ตอบหลังเห็นคำตอบ"
        text: >-
          model ตอบหลังได้คำขอนี้เท่านั้น ในการรันจริงนี้ model ได้ JSON ของหน้า `/health` แล้ว
          แต่ไม่แน่ใจว่า model ผู้ช่วยคัดลอกมาตรงทุกตัวหรือไม่ จึงขอรัน `bash` เพื่อดึงหน้าเองอีกครั้ง
          ดู `command` ใน `input` ที่ไฮไลต์ไว้
        from: model
        to: engine
        sees:
          kind: payload
          source: docs/results/real-usecases/runs/A12-background-server/fix-s1-2/session.jsonl#seq=18
          select: content
          collapse: ['[0].thinking']
          highlight: ['[2].input']
        end: "model ทำต่อ"
      do: >-
        model อ่าน `tool_result` ของ `web_fetch` แล้วตอบด้วยคำขอใหม่ ในการรันนี้คือ `bash` และจบคำตอบด้วย `stop_reason: tool_use`
        turn วนต่อไปจนกว่า model จะตอบโดยไม่ขอ tool
      ref: "packages/engine/src/gateway.ts#\"stopReason: message.stop_reason,\""
      emits: [tool_use]
      end: { turn: continues, reason: run-tools }
---

`web_fetch` ไม่ส่งหน้าเว็บให้ model หลัก มันส่งหน้าให้ model ผู้ช่วยอ่านแล้วตอบคำถาม (ถ้าไม่ได้ตั้ง model ของ explore หรือ classifier ผู้ช่วยคือ model ของ session เอง)
model หลักจึงได้คำตอบสั้นๆ ในรั้วข้อมูล ซึ่งกันไม่ให้ข้อความในหน้าเว็บกลายเป็นคำสั่ง

| โหมด | URL ของโฮสต์อื่น |
| --- | --- |
| Ask | ถามผู้ใช้ |
| Auto | classifier ตัดสิน |
| Plan | อนุญาต |
| ไม่มีคนดู (non-interactive) | ปฏิเสธ |

URL บนเครื่องนี้ (`localhost`, 127.0.0.1 และ [::1]) ผ่านเสมอโดยไม่ถาม และ URL ที่ `web_fetch` ห้ามดึงถูกปฏิเสธเสมอในทุกโหมด
เช่น URL ที่ไม่ใช่ http หรือ https และ IP ส่วนตัวที่เขียนตรงๆ อย่าง 192.168.1.5

สิ่งที่ควรสังเกต

- **การดึงไม่ได้อยู่ใน sandbox** sandbox ปิดเครือข่ายของคำสั่ง shell แต่ `web_fetch` รันใน process ของ engine
  ด่านของมันคือกฎ `web-remote-url` และ `guardedResolve` ที่ห้ามชื่อโฮสต์ภายนอกซึ่ง DNS ชี้ไปที่อยู่ส่วนตัว
- **Always allow บันทึกเป็นโดเมน** ไม่ใช่ URL กฎ `WebFetch(domain:date-fns.org)` ครอบคลุมทุกหน้าบนโฮสต์นั้น
- **Plan ดึงเว็บได้** ต่างจากคำสั่ง shell การอ่านเว็บไม่เปลี่ยนอะไรใน workspace โหมด Plan จึงอนุญาต

อ่านต่อที่ [Model ค้นเว็บด้วย web_search](/scenarios/tool/web-search/)
