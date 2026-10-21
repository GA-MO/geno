---
title: "hook UserPromptSubmit บล็อกหรือเพิ่มบริบท"
description: hook ที่ตั้งไว้ได้อ่าน prompt ก่อน model ถ้าบล็อก prompt ไม่ถึง model และ turn จบแบบ failed ถ้าพิมพ์ข้อความออกมา ข้อความนั้นไปกับ prompt
scenario:
  surface: vscode
  given:
    - workspace ที่เชื่อถือแล้ว มี UserPromptSubmit hook ใน `.claude/settings.json` ซึ่งรันสคริปต์ `check-prompt.sh`
    - สคริปต์บล็อก prompt ที่มีสิ่งที่หน้าตาเหมือน API key และพิมพ์ชื่อ branch ปัจจุบันออกมาสำหรับ prompt อื่น
  trigger: >-
    ผู้ใช้ส่ง prompt ในแผงแชต
  covers: [hook.user-prompt-submit]
  related: [hook.pretooluse-deny, hook.stop-keeps-going, hook.project-untrusted, turn.text-answer]
  steps:
    - use: prompt-starts-turn
      beat:
        title: คุณส่ง prompt
        text: คุณพิมพ์ในแชตแล้วกด Enter แชตเริ่ม turn (รอบที่ Geno ทำงานตั้งแต่รับข้อความจนตอบเสร็จ) และส่ง prompt ไปที่ engine
        from: you
        to: panel
        sees:
          kind: composer
          state: working

    - id: run
      beat:
        title: Geno ส่ง prompt ให้ hook ก่อน model
        text: hook คือคำสั่ง shell ที่คุณตั้งไว้ใน settings ให้ Geno รันเมื่อเกิดเหตุการณ์หนึ่ง UserPromptSubmit คือเหตุการณ์ที่คุณส่ง prompt ก่อน model เห็น Geno รัน `check-prompt.sh` พร้อม prompt ทาง stdin ถ้ามี hook ใดบล็อก prompt ไม่ไปถึง model ไม่เช่นนั้นข้อความของทุก hook ไปกับ prompt
        from: engine
        to: machine
        ask: hook ตอบอะไร
      lane: policy
      at: hooks
      do: >-
        `HookSessions.userPromptSubmit` รันทุก hook ของเหตุการณ์นี้ ส่ง JSON ที่มี `prompt` ทาง stdin
        แล้ว `promptDecision` รวมผล: hook ใดบล็อกก็บล็อกทั้งหมด ไม่เช่นนั้นข้อความของทุก hook ไปกับ prompt
      ref: packages/engine/src/hooks.ts#HookSessions.userPromptSubmit
      emits: [UserPromptSubmit]
      fork:
        ask: hook ตอบอะไร
        options:
          - id: block
            label: บล็อก (exit 2)
            steps:
              - lane: policy
                beat:
                  title: hook บล็อก prompt
                  text: สคริปต์จบด้วย exit 2 และเขียนว่า prompt มีสิ่งที่หน้าตาเหมือน API key
                  from: machine
                  to: engine
                at: hooks
                do: >-
                  สคริปต์จบด้วย exit 2 และเขียนเหตุผลลง stderr ว่า "prompt มีสิ่งที่หน้าตาเหมือน API key"
                  (JSON `decision: "block"` หรือ `continue: false` ได้ผลเดียวกัน) `promptDecision` จึงได้ `block`
                ref: packages/core/src/hooks.ts#promptDecision
                emits: [block]
              - lane: loop
                beat:
                  title: Geno ไม่เรียก model
                  text: Geno บันทึก error ว่า hook บล็อก prompt และ model ไม่เห็นมัน prompt นี้ถูกทิ้ง ข้อความถัดไปของคุณจะไม่พามันไปด้วย
                  from: engine
                  to: engine
                at: drive
                do: >-
                  `submitted()` บันทึก event `error` ชนิด `blocked`: "A UserPromptSubmit hook blocked this prompt,
                  so the model did not see it: prompt มีสิ่งที่หน้าตาเหมือน API key" ไม่มีการเรียก model
                ref: packages/engine/src/drive.ts#submitted
                emits: [blocked]
              - lane: server
                beat:
                  title: แชตขึ้นแถบ error ใต้ข้อความของคุณ
                  text: แถบสีแดงบอกเหตุผลของ hook
                  from: panel
                  to: you
                  sees:
                    kind: notice
                    text: "A UserPromptSubmit hook blocked this prompt, so the model did not see it: prompt มีสิ่งที่หน้าตาเหมือน API key"
                    tone: error
                at: updates
                do: >-
                  `errorUpdate` ส่ง `agent_message_chunk` พร้อม `TURN_ERROR_META` ชนิด `blocked`
                ref: packages/engine/src/session-replay.ts#errorUpdate
                emits: [agent_message_chunk, TURN_ERROR_META]
              - lane: editor
                at: chat
                alongside: true
                do: >-
                  `agentChunkAction` แปลงเป็น action `error`
                ref: packages/extension/src/chat/compact-host.ts#agentChunkAction
              - lane: panel
                at: rail
                alongside: true
                do: ใต้ข้อความของผู้ใช้ขึ้นแถบ error สีแดง
                sees: >-
                  "A UserPromptSubmit hook blocked this prompt, so the model did not see it: prompt มีสิ่งที่หน้าตาเหมือน API key"
                ref: packages/extension/src/chat/render.ts#errorBlock
              - lane: loop
                beat:
                  title: Turn ล้มเหลว
                  text: Stop hook (hook ที่รันตอน turn จะจบ) ไม่ทำงานในทางนี้ แชตไม่ขึ้นปุ่ม Continue หรือ Retry เพราะมีแถบ error แล้ว ปุ่ม Send กลับมา
                  from: engine
                  to: panel
                  end: prompt ไม่ถึง model
                  sees:
                    kind: composer
                    state: idle
                    header: failed after ...
                at: step
                do: >-
                  `loopStep` เห็น error ล่าสุด `ERROR_REASON` แปลง `blocked` เป็น `done(error)` Stop hook ไม่ทำงาน
                  และ `blocked` เป็นชนิดที่ทิ้ง prompt: ข้อความถัดไปของผู้ใช้จะไม่พา prompt นี้ไปด้วย
                ref: packages/core/src/session.ts#KEEPS_PENDING_PROMPT
                emits: [error]
                phase: ending
              - lane: server
                at: turns
                do: >-
                  `runTurn` ใช้ `TURN_ENDS.error`: `stopReason: end_turn` กับงานที่จบแบบ `failed`
                ref: packages/engine/src/serve.ts#TURN_ENDS
                emits: [TURN_END_META, failed]
              - lane: editor
                at: chat
                do: >-
                  `turnEndOf` อ่าน `_meta` ได้ `failed` แล้ว `prompt()` ส่ง action `turn-end`
                ref: "packages/extension/src/chat/chat.ts#\"this.dispatch({ type: 'turn-end', at: Date.now(), status, usage: usageOf(response)\""
                emits: [turn-end]
              - lane: panel
                at: rail
                do: >-
                  หัวข้อเป็น "failed after ..." ไม่มีประกาศ Continue หรือ Retry เพราะ turn มีแถบ error แล้ว
                sees: หัวข้อ "failed after" ตามด้วยเวลาที่ใช้ และปุ่ม Send กลับมา
                ref: packages/extension/src/chat/rail.ts#headerOf
                end: { turn: failed, reason: error }

          - id: notes
            label: พิมพ์ข้อความ (exit 0)
            steps:
              - lane: policy
                beat:
                  title: hook พิมพ์ชื่อ branch
                  text: 'สคริปต์จบด้วย exit 0 และพิมพ์ "branch: main" สำหรับ hook นี้ ข้อความที่พิมพ์ออกมานับเป็นบริบท'
                  from: machine
                  to: engine
                at: hooks
                do: >-
                  สคริปต์จบด้วย exit 0 และพิมพ์ "branch: main" ลง stdout UserPromptSubmit เป็นเหตุการณ์ที่ stdout
                  นับเป็นบริบท ข้อความนี้จึงเป็นโน้ตของ hook (JSON `additionalContext` ก็ได้ผลเดียวกัน)
                ref: packages/core/src/hooks.ts#promptDecision
              - lane: loop
                beat:
                  title: Geno แนบข้อความไว้กับ prompt
                  text: Geno บันทึกข้อความของ hook ไว้ คุณไม่เห็นมันในแชต
                  from: engine
                  to: engine
                at: drive
                do: >-
                  `submitted()` บันทึก event `hook-context` ของ `UserPromptSubmit` ผู้ใช้ไม่เห็นโน้ตนี้ในแผงแชต
                ref: "packages/engine/src/drive.ts#\"await record({ kind: 'hook-context', seq: nextSeq(events), at, event: 'UserPromptSubmit'\""
                emits: [hook-context]
              - use: model-call
                beat:
                  title: Geno ส่ง prompt ให้ model
                  text: >-
                    Geno เก็บ checkpoint (ภาพถ่ายไฟล์ใน workspace ไว้ย้อนกลับได้) แล้วส่งบทสนทนาให้ model
                    การ์ดข้างล่างเป็นการบันทึกที่รัน Geno จริงกับ model จำลองที่ตอบตามบทที่เขียนไว้ก่อน hook ในการบันทึกรัน `git branch --show-current` จริงและได้ `main`
                    ดูข้อความ user ข้อความแรก บล็อกแรกที่พับไว้คือข้อมูลสภาพแวดล้อมที่ Geno ใส่ให้ทุก session ต่อด้วย prompt ของคุณ และโน้ตของ hook ที่ไฮไลต์
                  from: engine
                  to: model
                  sees:
                    kind: payload
                    source: packages/docs/src/data/recorded/hook-user-prompt-submit.jsonl#line=2
                    select: messages[0]
                    collapse: ['content[0].text']
                    highlight: ['content[1].text', 'content[2].text']
              - lane: model
                beat:
                  title: Model ตอบโดยรู้ว่าอยู่ branch ไหน
                  text: >-
                    model ได้ข้อความของคุณตามด้วย `[Geno] UserPromptSubmit hook success: branch: main` ในข้อความ user เดียวกัน คำว่า `[Geno]` บอก model ว่าเป็นโน้ตจาก Geno ไม่ใช่สิ่งที่คุณพิมพ์
                    การ์ดข้างล่างเป็น event หนึ่งใน stream ของคำตอบจากการบันทึกเดียวกับการ์ดก่อน model ส่งข้อความทีละประโยค
                    ประโยคแรกที่ไฮไลต์ใช้ชื่อ branch จาก hook ประโยคถัดไป (อยู่ใน event ถัดไป ไม่อยู่ในการ์ด) แนะนำให้ push ขึ้น feature branch แล้วเปิด pull request
                  from: model
                  to: engine
                  end: Model ตอบโดยใช้ข้อมูลจาก hook
                  sees:
                    kind: payload
                    source: packages/docs/src/data/recorded/hook-user-prompt-submit.jsonl#line=3
                    select: '[2]'
                    highlight: [data.delta.text]
                do: >-
                  model ได้ข้อความของผู้ใช้ตามด้วยโน้ต "[Geno] UserPromptSubmit hook success: branch: main"
                  ในข้อความผู้ใช้เดียวกัน แล้วตอบโดยรู้ว่าอยู่ branch ไหน ในการบันทึก model ตอบเป็นข้อความและจบด้วย `stop_reason: end_turn`
                ref: packages/core/src/hooks.ts#hookNoteText
                emits: [end_turn]
                end: { turn: done, reason: end_turn }
---

UserPromptSubmit เป็น [hook](/start/glossary/) ที่ทำงานกับทุก prompt ที่ผู้ใช้พิมพ์ ก่อน model เห็น prompt นั้น (SessionStart hook ทำงานก่อนนั้นอีก ตอน session เปิดครั้งแรกใน engine)
ข้อความ [steer](/start/glossary/) turn ที่[ถูกปลุก](/start/glossary/) และการเปิด session เดิมทำต่อ (resume) ไม่ผ่าน hook นี้ (`isTyped` ในโค้ดเป็นตัวตัดสิน)

สิ่งที่ควรสังเกต

- **บล็อกแล้ว prompt หายจากบทสนทนาของ model** Geno ไม่เก็บ prompt ที่ถูกบล็อกไว้ส่งต่อ (`KEEPS_PENDING_PROMPT.blocked` เป็น false)
  ต่างจาก error ของผู้ให้บริการที่ prompt ยังค้างอยู่ให้ไปกับข้อความถัดไป
- **โน้ตไปและหายพร้อม prompt** โน้ตของ UserPromptSubmit ถูกวางไว้ข้าง prompt ของมัน ถ้า prompt ถูกทิ้ง โน้ตก็ถูกทิ้งด้วย
- **โน้ตอยู่ใน log** event `hook-context` ทำให้ resume หรือเล่นซ้ำส่ง byte เดิมให้ model โดยไม่ต้องรัน hook ใหม่
- **โน้ตยาวถูกตัด** ข้อความของ hook ยาวเกิน 10,000 ตัวอักษรถูกตัด และมีบรรทัดบอกว่าตัดแล้ว
- **hook ของโปรเจกต์ต้องเชื่อถือ workspace ก่อน** hook ใน `.claude/settings.json` ของ repo ไม่รันใน workspace ที่ไม่เชื่อถือ
