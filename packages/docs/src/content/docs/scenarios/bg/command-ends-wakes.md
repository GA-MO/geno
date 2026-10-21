---
title: คำสั่งเบื้องหลังจบแล้วปลุก
description: model รัน build แบบเบื้องหลัง เมื่อคำสั่งจบ model ได้รู้ที่จุดปลอดภัยถ้า turn ยังรัน หรือ engine เปิด turn ใหม่ให้ถ้า turn จบไปแล้ว
scenario:
  surface: vscode
  given:
    - เปิด Geno ในโหมด Ask การปลุกอัตโนมัติเปิดอยู่ และหน้าต่างที่แสดง session นี้ยังเปิดอยู่
    - กฎของ workspace อนุญาต `pnpm build` ไว้แล้ว จึงไม่ขึ้นการ์ด
  trigger: >-
    model ขอรัน `bash` ด้วย `pnpm build` และ `run_in_background: true`
  covers: [bg.command-ends-wakes]
  related: [bg.child-wakes-parent, bg.monitor-wakes, bg.task-stop-or-list, tool.bash-background]
  steps:
    - use: tool-call-opens
      beat:
        title: Model ขอรัน `pnpm build` เบื้องหลัง
        text: >-
          model ขอเรียก `bash` พร้อม `run_in_background: true` คือให้คำสั่งรันต่อไปโดย turn ไม่ต้องรอให้จบ
          การ์ดเป็นบล็อก `tool_use` จริงจากการรันที่เริ่ม `npm run dev` เบื้องหลังแบบเดียวกัน ดู `run_in_background` ที่ไฮไลต์
        from: model
        to: engine
        sees:
          kind: payload
          source: docs/results/real-usecases/runs/A12-background-server/fix-s3-1/session.jsonl#seq=3
          select: content[2]
          highlight:
            - input.run_in_background

    - id: approve
      beat:
        title: Geno ตรวจคำสั่งกับกฎของคุณ
        text: คำสั่งเบื้องหลังผ่านกฎชุดเดียวกับคำสั่งปกติ กฎ allow ของ workspace ครอบ `pnpm build` จึงไม่ขึ้นการ์ด ในโหมด Plan คำสั่งเบื้องหลังถูกปฏิเสธทันที
        from: engine
        to: engine
      lane: policy
      at: rules
      do: >-
        `approveCommand` ตรวจคำสั่งเบื้องหลังด้วยกฎชุดเดียวกับคำสั่งปกติ (ในโหมด Plan คำสั่งเบื้องหลังถูกปฏิเสธทันที)
        กฎ allow ของ workspace ครอบคลุม `pnpm build` จึงผ่าน
      ref: packages/engine/src/tools/agent.ts#approveCommand

    - id: start
      beat:
        title: build เริ่มรันเบื้องหลัง
        text: >-
          คำสั่งได้ id `bg-1` และรันใน sandbox (กรอบของระบบปฏิบัติการที่จำกัดว่าคำสั่งเขียนไฟล์และต่อเครือข่ายได้แค่ไหน)
          output ทั้งหมดไปลงไฟล์ Geno ตอบ model ทันทีโดยไม่รอคำสั่งจบ การ์ดคือ `tool_result` จากการรันเดียวกับการ์ดแรก ส่วนที่ไฮไลต์บอก id
          และที่อยู่ไฟล์ output ซึ่งลงท้ายด้วย `background/bg-1.log`
        from: engine
        to: machine
        sees:
          kind: payload
          source: docs/results/real-usecases/runs/A12-background-server/fix-s3-1/wire.jsonl#line=3
          select: messages[-1].content[0]
          highlight: [content]
          quote: background/bg-1.log
      lane: tool
      at: shell
      do: >-
        `BackgroundJobs.start` ให้ id `bg-1` (session หนึ่งรันได้พร้อมกันไม่เกิน 4 ตัว) เริ่มคำสั่งใน sandbox
        และเขียนผลทั้งหมดลงไฟล์ `background/bg-1.log` ในโฟลเดอร์ spill ของ session แล้วคืนผลทันทีโดยไม่รอคำสั่งจบ
      ref: packages/engine/src/background.ts#BackgroundJobs.start
      emits: [Started background command]

    - id: shown
      beat:
        title: แชตและ Tasks แสดงคำสั่งที่รันอยู่
        text: ขั้นของคำสั่งในแชต และงานในแผง Tasks (รายการงานของทุกแชตพร้อมสถานะ) อัปเดตทุกครั้งที่งานเปลี่ยน
        from: panel
        to: you
        sees:
          kind: task
          title: pnpm build
          status: running
      lane: server
      at: updates
      do: >-
        ทุกครั้งที่งานเปลี่ยน `backgroundUpdate` ส่ง `tool_call_update` ที่มี `BACKGROUND_META` ให้ขั้นของ `bash`
        และงานในแผง Tasks แสดงคำสั่งที่รันอยู่
      ref: packages/engine/src/session-replay.ts#backgroundUpdate
      emits: [tool_call_update, BACKGROUND_META]

    - use: tool-result-returns

    - id: when
      beat:
        title: build รันต่อไป
        text: loop ทำงานอื่นได้ระหว่างนั้น ทางที่ model ได้รู้ผลขึ้นกับว่า turn ยังรันอยู่ไหม
        from: machine
        to: machine
        ask: build จบตอนไหน
      lane: tool
      at: shell
      do: >-
        `pnpm build` รันต่อไปเรื่อยๆ ขณะที่ loop ทำงานอื่น
      ref: packages/engine/src/background.ts#BackgroundJobs.start
      fork:
        ask: build จบตอนไหน
        options:
          - id: mid-turn
            label: ระหว่างที่ turn ยังรัน
            steps:
              - lane: loop
                beat:
                  title: Model ทำงานอื่นต่อ
                  text: >-
                    model อ่านว่า bg-1 เริ่มแล้ว และเรียก tool อื่นต่อทันทีโดยไม่หยุดรอ bg-1 ระหว่างนั้น build จบด้วย exit 0
                    การ์ดข้างล่างเป็นคำตอบจริงจากการรันเดียวกับการ์ดแรก (ที่เริ่ม dev server) ในรันนั้น tool ถัดไปคือ `tool_search`
                    (tool ที่โหลด schema ของ tool อื่นก่อน model จะเรียกได้) ดู `input` ที่ไฮไลต์ จุดที่ต้องดูคือคำตอบนี้เรียก tool อื่น
                    ไม่ใช่การรอ bg-1 แล้วจบคำตอบด้วย `stop_reason: tool_use`
                  from: model
                  to: engine
                  sees:
                    kind: payload
                    source: docs/results/real-usecases/runs/A12-background-server/fix-s3-1/session.jsonl#seq=6
                    select: content
                    collapse: ['[0].thinking']
                    highlight: ['[1].input']
                at: step
                do: >-
                  `loopStep` ตัดสิน `call-model` model อ่านว่า bg-1 เริ่มแล้ว และเรียก tool อื่นต่อ
                ref: packages/core/src/loop.ts#loopStep
                emits: [call-model]
                phase: calling-model
              - lane: tool
                at: shell
                do: >-
                  ระหว่างนั้น build จบด้วย exit code 0 งานส่ง `background-end` พร้อมท้ายของผลเข้ากล่องข้อความของ session
                  (คำสั่งที่จบเองและคำสั่งที่ผู้ใช้หยุดเท่านั้นที่บอก model)
                ref: packages/core/src/background.ts#TELLS_MODEL
                emits: [background-end]
              - lane: loop
                beat:
                  title: Geno ใส่โน้ตไว้ก่อนเรียก model
                  text: >-
                    การจบของ build เข้าไปรอในกล่องข้อความของ session (คิวของสิ่งที่รอส่งให้ model) ไม่แทรกกลางงานที่รันอยู่
                    ที่จุดปลอดภัย คือจังหวะก่อนเรียก model ครั้งถัดไปตอนที่ไม่มี tool กำลังรัน Geno บันทึกโน้ตว่า build จบ
                    พร้อมท้ายของ output ลงใน log โน้ตนี้ถึง model ตอนเรียกครั้งถัดไป
                  from: engine
                  to: engine
                at: drive
                do: >-
                  ที่จุดปลอดภัยก่อนเรียก model ครั้งถัดไป `deliver()` บันทึก event `background-end` ลง log
                  และวนอีกรอบก่อนเรียก model เพื่อให้ `loopStep` เห็น log ใหม่
                ref: packages/engine/src/drive.ts#deliver
                emits: [background-end]
              - lane: model
                beat:
                  title: Model รู้ว่า build ผ่าน
                  text: >-
                    คำขอถัดไปมีโน้ต "Background command bg-1 (`pnpm build`) exited with code 0." model รู้ผลใน turn เดิม ไม่ต้องรอ turn ใหม่
                    การ์ดทั้งสี่มาจากการบันทึกที่รัน Geno จริงกับ model จำลองที่ตอบตามบทที่เขียนไว้ก่อน ไม่ใช่การรันเดียวกับการ์ดก่อนหน้า
                    ในการบันทึกนั้น model อ่าน `package.json` ระหว่างที่ build รัน ในการบันทึก `pnpm` เป็นสคริปต์จำลองบน PATH ที่รันสคริปต์ใน package.json แบบ pnpm และสคริปต์ build เป็นสคริปต์เล็กๆ ที่พิมพ์ผลตามบท
                    ใบแรกและใบที่สองคือโน้ตในคำขอถัดไป ซึ่งมาต่อท้าย `tool_result` ของการอ่านไฟล์ ใบแรกแสดงช่วงที่บอก exit code
                    ใบที่สองแสดงท้ายของโน้ตเดียวกัน คือท้ายของ output ในรั้ว `command_output`
                    ใบที่สามคือคำตอบของ model ใบที่สี่คือท้าย stream ของคำตอบนั้น ในการบันทึกนี้ไม่มีงานเหลือ model จึงจบด้วย `stop_reason: end_turn`
                  from: model
                  to: engine
                  sees:
                    - kind: payload
                      source: packages/docs/src/data/recorded/bg-command-ends-wakes-mid-turn.jsonl#line=6
                      select: messages[-1].content[1]
                      highlight: [text]
                      quote: exited with code 0
                    - kind: payload
                      source: packages/docs/src/data/recorded/bg-command-ends-wakes-mid-turn.jsonl#line=6
                      select: messages[-1].content[1]
                      highlight: [text]
                      quote: Built in 0.6s
                    - kind: message
                      from: geno
                      text: "The build passed: pnpm build exited with code 0 and built dist/cli.js, dist/update.js and dist/version.js. It runs node scripts/build.mjs, as package.json says."
                    - kind: payload
                      source: packages/docs/src/data/recorded/bg-command-ends-wakes-mid-turn.jsonl#line=7
                      select: '[-2]'
                      highlight: [data.delta.stop_reason]
                  end: Model รู้ผลใน turn เดิม แล้วจบ turn
                do: >-
                  คำขอถัดไปมีโน้ตว่า "Background command bg-1 (`pnpm build`) exited with code 0." พร้อมที่อยู่ไฟล์ผลและท้ายของผล
                  ที่ล้อมไว้เป็นข้อมูล model เล่าว่า build ผ่าน แล้วจบด้วย `stop_reason: end_turn`
                ref: packages/core/src/background.ts#backgroundEndNotice
                emits: [end_turn]
                phase: calling-model
              - use: turn-ends

          - id: after-turn
            label: หลัง turn จบแล้ว
            steps:
              - lane: model
                beat:
                  title: Model บอกว่าจะแจ้งเมื่อเสร็จ แล้วจบ turn
                  text: >-
                    model ไม่วนถามสถานะ เพราะ Geno จะปลุก session ให้เอง ปลุกคือ engine เริ่ม turn ใหม่เองโดยไม่มีใครพิมพ์
                    เมื่องานเบื้องหลังรายงานกลับ คำสั่งเบื้องหลังไม่ถือ turn ไว้ และไม่ถูกฆ่าตอน turn จบ
                    การ์ดมาจากการบันทึกที่รัน Geno จริงกับ model จำลองที่ตอบตามบทที่เขียนไว้ก่อน ซึ่งเริ่ม `pnpm build` เบื้องหลังแบบเดียวกัน
                    ในการบันทึก `pnpm` เป็นสคริปต์จำลองบน PATH ที่รันสคริปต์ใน package.json แบบ pnpm และสคริปต์ build เป็นสคริปต์เล็กๆ ที่พิมพ์ผลตามบท
                    ใบแรกคือข้อความที่ model ตอบ ใบที่สองคือท้าย stream ของคำตอบนั้น ดู `stop_reason` ที่ไฮไลต์ว่าเป็น `end_turn`
                  from: model
                  to: engine
                  sees:
                    - kind: message
                      from: geno
                      text: The build is running in the background as bg-1. I will tell you when it finishes.
                    - kind: payload
                      source: packages/docs/src/data/recorded/bg-command-ends-wakes.jsonl#line=5
                      select: '[-2]'
                      highlight: [data.delta.stop_reason]
                do: >-
                  model บอกผู้ใช้ว่า build กำลังรันและจะแจ้งเมื่อเสร็จ แล้วจบด้วย `stop_reason: end_turn`
                  (system prompt บอกให้จบ turn แทนการคอยถามสถานะ เพราะ Geno จะเริ่ม turn ถัดไปให้เอง)
                ref: "packages/engine/src/gateway.ts#\"stopReason: message.stop_reason,\""
                emits: [end_turn]
                phase: calling-model
              - lane: loop
                at: step
                do: >-
                  `loopStep` ตัดสิน `done(end_turn)` turn จบแบบ done คำสั่งเบื้องหลังไม่ถือ turn ไว้ และ engine ไม่ฆ่ามันตอนจบ turn
                ref: packages/core/src/loop.ts#AFTER_STOP
                emits: [end_turn]
                phase: idle
              - lane: tool
                beat:
                  title: build จบทีหลัง
                  text: >-
                    build จบด้วย exit 0 และส่งโน้ตเข้ากล่องข้อความของ session (คิวของสิ่งที่รอส่งให้ model)
                    build ของจริงอาจใช้หลายนาที ส่วนสคริปต์ build จำลองในการบันทึกจบในไม่ถึงวินาที การ์ดถัดไปจึงเขียนว่า "Built in 0.6s"
                  from: machine
                  to: engine
                at: shell
                runs: 0
                do: >-
                  ต่อมา build จบด้วย exit code 0 งานส่ง `background-end` เข้ากล่องข้อความของ session
                ref: packages/core/src/background.ts#TELLS_MODEL
                emits: [background-end]
              - lane: server
                beat:
                  title: Geno ปลุก session
                  text: >-
                    ไม่มี turn รันอยู่ Geno บันทึกโน้ตลง log ทันที รอ 2 วินาทีให้สิ่งที่มาใกล้กันรวมเป็นชุดเดียว
                    (ในการบันทึกตั้งช่วงรอนี้ให้สั้นลงเหลือ 50 มิลลิวินาที)
                    ไม่มีการ์ด permission ค้างรอคุณ และคุณไม่ได้พิมพ์ จึงเปิด turn ใหม่ที่หัวมีกระดิ่ง
                  from: engine
                  to: panel
                  sees: 'กระดิ่งกับ "woke: 1 task finished" หัวข้อ "working"'
                at: wakes
                do: >-
                  ไม่มี turn รันอยู่ `logArrivals` จึงบันทึก event `background-end` ลง log ทันที แล้ว `wakeGate` รอ 2 วินาที
                  ไม่มีการ์ดค้าง ผู้ใช้ไม่ได้พิมพ์ จึงปลุก `logWake` เปิด turn ด้วยข้อความจาก engine เป็น event `user` ที่มี `from: 'wake'`
                  (การจบของคำสั่งไม่มี event `wake` ของตัวเอง) แล้ว `runTurn` ส่งข้อความนั้นพร้อม `WAKE_META`
                ref: packages/engine/src/background-hooks.ts#logArrivals
                emits: [background-end, user, WAKE_META]
                phase: starting
              - lane: panel
                at: rail
                do: แผงเปิด turn ใหม่ที่หัวมีกระดิ่งแทนข้อความของผู้ใช้
                sees: >-
                  กระดิ่งกับ "woke: 1 task finished" หัวข้อ "working"
                ref: packages/extension/src/chat/render.ts#turnHead
              - lane: model
                beat:
                  title: Model เล่าผล build
                  text: >-
                    model อ่านโน้ตของ bg-1 และข้อความว่า Geno เริ่ม turn นี้เอง แล้วเล่าผลให้คุณ
                    การ์ดมาจากการบันทึกเดียวกับการ์ดก่อน ใบแรกและใบที่สองคือข้อความสุดท้ายของคำขอใน turn ที่ถูกปลุก ซึ่งมีสองข้อความที่ไฮไลต์
                    ใบแรกแสดงโน้ตว่า bg-1 จบด้วย exit code 0 ใบที่สองแสดงข้อความว่า Geno เริ่ม turn นี้เอง (woke: 1 task finished)
                    ใบที่สามคือคำตอบของ model
                  from: model
                  to: engine
                  sees:
                    - kind: payload
                      source: packages/docs/src/data/recorded/bg-command-ends-wakes.jsonl#line=6
                      select: messages[-1].content
                      highlight: ['[0].text', '[1].text']
                      quote: exited with code 0
                    - kind: payload
                      source: packages/docs/src/data/recorded/bg-command-ends-wakes.jsonl#line=6
                      select: messages[-1].content
                      highlight: ['[0].text', '[1].text']
                      quote: "woke: 1 task finished"
                    - kind: message
                      from: geno
                      text: "The build passed: pnpm build exited with code 0 and built dist/cli.js, dist/update.js and dist/version.js."
                  end: Turn ที่ถูกปลุกจบ
                do: >-
                  model อ่านโน้ตของ bg-1 ตามด้วยข้อความว่า Geno เริ่ม turn นี้เอง แล้วเล่าผล build ให้ผู้ใช้ และจบด้วย `stop_reason: end_turn`
                ref: packages/core/src/background.ts#backgroundEndNotice
                emits: [end_turn]
                phase: calling-model
              - use: bg-woken-ends
---

[คำสั่งเบื้องหลัง](/start/glossary/)ต่างจากลูกเบื้องหลัง (subagent ที่รันโดยแม่ไม่รอ) ตรงที่ session ไม่ได้ค้างรายงานจากมัน
ถ้าไม่มีตัวปลุก (เช่นใน CLI) Geno ถือ turn ไว้รอรายงานของลูก ([CLI ถือ turn ไว้รอรายงาน](/scenarios/bg/cli-holds-turn/))
แต่ไม่เคยถือ turn ไว้รอคำสั่ง ใน CLI คำสั่งถูกฆ่าเมื่อรอบจบ ถ้าคำสั่งจบเอง model จะได้รู้เสมอ ไม่ว่าจะระหว่าง turn หรือหลังจากนั้น

สิ่งที่ควรสังเกต

- **คำสั่งที่ผู้ใช้หยุดไม่ปลุก** model ได้รู้ใน turn ถัดไปของผู้ใช้ แต่ไม่มี turn ที่ถูกปลุก เพราะผู้ใช้รู้อยู่แล้ว
- **dev server ที่ `preview_start` เริ่มไม่ปลุก** คำสั่งที่ tool `preview_start` เริ่ม (dev server ที่ Geno เปิดให้ดูหน้าเว็บ)
  ตั้งใจให้รันต่อ การจบของมันไปกับ turn ถัดไปแทน ส่วน `pnpm dev` ที่รันด้วย `bash` เบื้องหลังยังปลุกตามปกติ
- **ผลยาวไม่เข้า context ทั้งหมด** โน้ตมีแค่ท้ายของผล ที่เหลืออยู่ในไฟล์ `bg-1.log` ให้อ่านด้วย `bash_output` หรือ `read`
- **ใน CLI ไม่มีการปลุก** `gcode agent` ฆ่าคำสั่งเบื้องหลังเมื่อรอบจบ
