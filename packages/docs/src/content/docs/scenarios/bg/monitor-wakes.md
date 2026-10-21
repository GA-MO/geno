---
title: monitor จับ pattern แล้วปลุก
description: model เริ่ม dev server ผ่าน monitor ให้เฝ้าบรรทัดที่ตรง pattern แล้วจบ turn เมื่อบรรทัดนั้นพิมพ์ออกมา engine เปิด turn ใหม่ให้ model ทำต่อ
scenario:
  surface: vscode
  given:
    - การปลุกอัตโนมัติ (`gcode.wake.auto`) เปิดอยู่ตามค่าเริ่มต้น หน้าต่างที่แสดง session นี้ยังเปิดอยู่
    - workspace มีกฎ allow `pnpm dev` คำสั่งนี้จึงรันโดยไม่ต้องถาม
  trigger: >-
    ผู้ใช้ขอให้เปิด dev server แล้วลองหน้าแรก model ไม่อยากวนรอ จึงเรียก `monitor`
  covers: [bg.monitor-wakes]
  related: [bg.command-ends-wakes, bg.schedule-wakeup, bg.task-stop-or-list, bg.wake-held-or-paused, bg.user-cancels-wakes]
  steps:
    - id: wants
      beat:
        title: Model ขอ monitor เฝ้า `pnpm dev`
        text: >-
          model ไม่อยากวนรอ dev server มันเรียก tool `monitor` ขอให้ Geno รันคำสั่งเบื้องหลัง เฝ้า output
          แล้วปลุก session เมื่อมีบรรทัดตรง "ready on" ปลุกคือ engine เริ่ม turn ใหม่เองโดยไม่มีใครพิมพ์
          model รู้ข้อความนี้เพราะอ่าน `scripts/dev.mjs` (สคริปต์ที่ `pnpm dev` รัน) ก่อน และเห็นว่ามันพิมพ์ "ready on" เมื่อพร้อม
          การ์ดเป็นบล็อก `tool_use` จริงจากการรันหนึ่ง ซึ่งเฝ้างานเบื้องหลังที่เริ่มไว้แล้วแทนการเริ่มคำสั่งเอง
          ดู `pattern` ที่ไฮไลต์ นั่นคือ regex ที่ Geno ใช้จับบรรทัด ในการรันนั้น pattern คือ `listening on` และเวลาเฝ้าต่างจากเรื่องนี้
        from: model
        to: engine
        sees:
          kind: payload
          source: docs/results/real-usecases/runs/A12-background-server/fix-a1/session.jsonl#seq=12
          select: content[1]
          highlight:
            - input.pattern
      lane: model
      do: >-
        หลังอ่าน `scripts/dev.mjs` model ขอเรียก `monitor` ด้วย `command: "pnpm dev"`, `pattern: "ready on"` และ `timeout_s: 300`
        จบคำตอบด้วย `stop_reason: tool_use`
      ref: packages/core/src/wake.ts#MONITOR_TOOL_DEFINITION
      emits: [tool_use, monitor]
      phase: calling-model

    - use: tool-call-opens
      beat:
        title: "`pnpm dev` เริ่มรันเบื้องหลัง"
        text: แชตขึ้นขั้นของ monitor คำสั่งผ่านกฎ allow ของ workspace แล้วรันเป็นงานเบื้องหลัง `bg-1`
        from: engine
        to: machine
        sees:
          kind: step
          label: monitor pnpm dev
          status: running

    - id: start
      lane: tool
      at: shell
      do: >-
        executor ของ `monitor` รับ `command` หรือ `background_job_id` อย่างใดอย่างหนึ่ง และ pattern ต้องเป็น regex ของ JavaScript
        `command` เริ่มเป็นงานเบื้องหลังผ่านการขออนุญาตและ sandbox เดียวกับ `bash` ได้ id `bg-1`
        (ถ้าการปลุกปิดอยู่ หรือ run นี้จบพร้อม call ได้ error `NO_WAKES` แทน)
      ref: packages/engine/src/tools/wake.ts#wakeExecutors
      emits: [bg-1]

    - id: watch
      beat:
        title: Geno เริ่มดู output
        text: Geno ดู output ตั้งแต่ตอนนี้ และดูส่วนที่พิมพ์ไปแล้วด้วย
        from: engine
        to: engine
        ask: บรรทัดนั้นมาหรือยัง
      lane: server
      at: wakes
      do: >-
        `Wakes.monitor` เริ่มดู output ของ `bg-1` ตั้งแต่ตอนนี้ และดูส่วนที่พิมพ์ไปแล้วด้วย
      ref: packages/engine/src/wakes.ts#Wakes.monitor
      fork:
        ask: บรรทัดที่ตรง pattern พิมพ์ออกมาแล้วหรือยัง
        options:
          - id: not-yet
            label: ยัง
            then: armed

          - id: already
            label: พิมพ์แล้ว (เฝ้างานที่เริ่มไว้ก่อน)
            steps:
              - lane: server
                beat:
                  title: บรรทัดนั้นพิมพ์ไปแล้ว
                  text: >-
                    ทางนี้เกิดเมื่อ model ส่ง `background_job_id` ของงานที่เริ่มไว้ก่อนแล้วแทน `command`
                    เมื่อส่ง `command` แบบในเรื่องนี้ Geno เริ่มดูทันทีหลังเริ่มคำสั่ง ก่อนที่คำสั่งใหม่จะทันพิมพ์อะไร
                    ถ้างานที่เริ่มไว้ก่อนพิมพ์ "ready on http://localhost:3000" ไปแล้ว ก็ไม่มีอะไรต้องรอ
                  from: machine
                  to: engine
                at: wakes
                do: >-
                  `monitor` ได้ `background_job_id: bg-1` ของงานที่เริ่มไว้ก่อน (เมื่อได้ `command` มันเรียก `Wakes.monitor` ทันทีหลัง `startCommand`)
                  `bg-1` พิมพ์ "ready on http://localhost:3000" ไปก่อน monitor เริ่มดู ไม่มีอะไรต้องรอ
                  ผลของ call คือ "bg-1 already printed a matching line, so nothing was set up to wait for:" ตามด้วยบรรทัดนั้น
                ref: "packages/engine/src/tools/wake.ts#\"already printed a matching line, so nothing was set up to wait for\""
              - use: tool-result-returns
              - lane: loop
                at: step
                do: >-
                  `loopStep` ตัดสิน `call-model` model อ่านผลใน turn เดิมโดยไม่ต้องจบ turn เพื่อรอ
                ref: packages/core/src/loop.ts#loopStep
                emits: [call-model]
                phase: calling-model
              - lane: model
                beat:
                  title: Model ตอบใน turn เดิม
                  text: >-
                    model อ่านว่าบรรทัดมาแล้ว จึงตอบได้เลยใน turn เดิม ไม่ต้องจบ turn เพื่อรอการปลุก
                    การ์ดมาจากการบันทึกที่รัน Geno จริงกับ model จำลองที่ตอบตามบทที่เขียนไว้ก่อน ในการบันทึกนั้น model อ่าน `scripts/dev.mjs` แล้วเริ่ม `pnpm dev` ด้วย `bash` เบื้องหลังก่อน
                    แล้วจึงเรียก `monitor` กับ `background_job_id: bg-1` ตอนที่บรรทัดพิมพ์ไปแล้ว
                    ในการบันทึก `pnpm` เป็นสคริปต์จำลองบน PATH ที่รันสคริปต์ใน package.json แบบ pnpm และ dev server เป็นสคริปต์เล็กๆ ที่พิมพ์บรรทัดตามบทแล้วเปิดหน้าเว็บที่ port 3000
                    ใบแรกคือ `tool_result` ในคำขอถัดไป ดูข้อความที่ไฮไลต์ว่าไม่ได้ตั้งอะไรรอ ใบที่สองคือคำตอบของ model ใน turn เดิม ซึ่งเป็นคำตอบสุดท้ายของ turn
                  from: model
                  to: engine
                  sees:
                    - kind: payload
                      source: packages/docs/src/data/recorded/bg-monitor-wakes-already.jsonl#line=10
                      select: messages[-1].content[0]
                      highlight: [content]
                    - kind: message
                      from: geno
                      text: 'The dev server is already up: bg-1 printed "ready on http://localhost:3000".'
                  end: Model ตอบใน turn เดิม แล้วจบ turn
                do: >-
                  model ตอบว่า dev server พร้อมแล้ว และจบด้วย `stop_reason: end_turn`
                ref: "packages/engine/src/gateway.ts#\"stopReason: message.stop_reason,\""
                emits: [end_turn]
                phase: calling-model
              - use: turn-ends

    - id: armed
      beat:
        title: Geno ตั้ง monitor พร้อมนาฬิกา 300 วินาที
        text: >-
          Geno จด monitor `wake-1` ไว้ในรายการสิ่งที่ session รอ และนับเวลาถอยหลัง 300 วินาทีที่ model ขอใน `timeout_s`
          (ถ้าไม่ระบุคือ 10 นาที ตั้งได้ถึง 3600 วินาที)
          แล้วเขียน `tool_result` ลง log ผลบอก model ให้จบ turn ตอนนี้ เพราะ Geno จะปลุกเมื่อบรรทัดตรง หมดเวลา หรือคำสั่งจบ
          ผลนี้ถึง model ตอนเรียกครั้งถัดไป
        from: engine
        to: engine
      lane: server
      at: wakes
      do: >-
        `Wakes.monitor` จด monitor `wake-1` ไว้ในการรอของ session พร้อมนาฬิกา 300 วินาที แล้วคืนผลว่า
        "Monitoring bg-1 for /ready on/ as wake-1, for up to 300s. End your turn now: Geno wakes you with the line when one matches, or when bg-1 ends."
      ref: "packages/engine/src/tools/wake.ts#\"End your turn now: Geno wakes you with the line when one matches\""
      emits: [wake-1]

    - use: tool-result-returns
    - use: model-call

    - id: says
      beat:
        title: Model บอกว่ารอ dev server แล้วจบ turn
        text: >-
          model ตอบสั้นๆ ว่าเปิด dev server แล้วและจะรอให้พร้อม แล้วจบ turn
          การ์ดมาจากการบันทึกที่รัน Geno จริงกับ model จำลองที่ตอบตามบทที่เขียนไว้ก่อน ซึ่งเรียก `monitor` กับ `pnpm dev` แบบเดียวกัน
          ในการบันทึก `pnpm` เป็นสคริปต์จำลองบน PATH ที่รันสคริปต์ใน package.json แบบ pnpm ในการบันทึกที่บรรทัดตรง dev server เป็นสคริปต์เล็กๆ ที่พิมพ์บรรทัดตามบทแล้วเปิดหน้าเว็บที่ port 3000
          ใบแรกคือข้อความที่ model ตอบ ใบที่สองคือท้าย stream ของคำตอบนั้น ดู `stop_reason` ที่ไฮไลต์ว่าเป็น `end_turn`
        from: model
        to: engine
        sees:
          - kind: message
            from: geno
            text: 'The dev server is starting as bg-1. I will try the home page once it prints "ready on".'
          - kind: payload
            source: packages/docs/src/data/recorded/bg-monitor-wakes.jsonl#line=9
            select: '[-2]'
            highlight: [data.delta.stop_reason]
      lane: model
      do: >-
        model ตอบสั้นๆ ว่าเปิด dev server แล้วและรอให้พร้อม จบด้วย `stop_reason: end_turn`
      ref: "packages/engine/src/gateway.ts#\"stopReason: message.stop_reason,\""
      emits: [end_turn]

    - use: bg-turn-lets-go
      beat:
        title: Geno จบ turn แผง Tasks บอกว่ารออะไร
        text: ปุ่ม Send กลับมา แผง Tasks (รายการงานของทุกแชตพร้อมสถานะ) บอกว่า session นี้รออะไร พร้อมปุ่ม Cancel
        from: engine
        to: panel
        sees: แถวของ session บอก "Wakes on ..." พร้อมปุ่ม [Cancel]

    - id: fires
      beat:
        title: Geno อ่าน output ทีละบรรทัด
        text: Geno ตรวจทุกบรรทัดที่จบแล้วกับ pattern
        from: engine
        to: engine
        ask: อะไรเกิดก่อน
      lane: server
      at: wakes
      do: >-
        `Wakes.monitor` อ่าน output ทีละบรรทัดที่จบแล้ว
      ref: packages/engine/src/wakes.ts#Wakes.monitor
      fork:
        ask: อะไรเกิดก่อน
        options:
          - id: matched
            label: บรรทัดตรง pattern
            then: arrives

          - id: timed-out
            label: ครบ 300 วินาทีโดยไม่ตรง
            steps:
              - lane: server
                beat:
                  title: ครบ 300 วินาทีโดยไม่ตรง
                  text: >-
                    monitor เลิกดู แต่ dev server ยังรันต่อ Geno ใส่โน้ตว่าหมดเวลาลงกล่องข้อความของ session
                    (คิวของสิ่งที่รอส่งให้ model) แล้วโน้ตนั้นถูกบันทึกลง log
                  from: machine
                  to: engine
                at: wakes
                do: >-
                  นาฬิกาครบ monitor เลิกดู (`dev server` ยังรันต่อ) แล้วใส่โน้ต `wake` ชนิด `monitor` ผล `timed-out` ลงกล่องข้อความของ session
                  โน้ตนี้ถูกบันทึกลง log เป็น event `wake` ในขั้นถัดไป
                ref: packages/engine/src/wakes.ts#Wakes.monitor
                emits: [wake, monitor, timed-out]
              - use: bg-wake-starts
                beat:
                  title: Geno ปลุก session
                  text: แชตเปิด turn ใหม่ที่หัวมีกระดิ่งกับเหตุที่ปลุก
                  from: engine
                  to: panel
                  sees: 'กระดิ่งกับ "woke: monitor timed out" หัวข้อ "working"'
              - use: model-call
              - lane: model
                beat:
                  title: Model ไปดูว่า dev server ติดตรงไหน
                  text: >-
                    model อ่านว่า monitor หมดเวลา แล้วอ่าน output ของ `bg-1` และเล่าให้คุณ
                    การ์ดมาจากการบันทึกที่รัน Geno จริงกับ model จำลองที่ตอบตามบทที่เขียนไว้ก่อน ซึ่ง dev server ค้างอยู่ที่บรรทัด "Waiting for src/routes.ts to be written"
                    ในการบันทึกนี้ dev server จำลองรอไฟล์ `src/routes.ts` ที่ไม่มีใน workspace จึงไม่เคยพร้อมและไม่เคยเปิด port
                    และการบันทึกรันด้วยนาฬิกาที่เร็วขึ้น 300 วินาทีจึงหมดในราวหนึ่งวินาทีครึ่ง แต่ model ยังเห็นตัวเลขจริงคือ 300 วินาที
                    ใบแรกคือโน้ตในคำขอของ turn ที่ถูกปลุก ดูข้อความที่ไฮไลต์ว่า monitor หมดเวลาโดยไม่มีบรรทัดตรง
                    ใบที่สองคือ event ของ stream ที่เปิดบล็อก `tool_use` ดู `name` ว่าเป็น `bash_output`
                    ใบที่สามคือชิ้นท้ายของ input ที่บอกว่าอ่านของ `bg-1`
                  from: model
                  to: engine
                  sees:
                    - kind: payload
                      source: packages/docs/src/data/recorded/bg-monitor-wakes-timeout.jsonl#line=10
                      select: messages[-1].content[0]
                      highlight: [text]
                    - kind: payload
                      source: packages/docs/src/data/recorded/bg-monitor-wakes-timeout.jsonl#line=11
                      select: '[4]'
                      highlight: [data.content_block.name]
                    - kind: payload
                      source: packages/docs/src/data/recorded/bg-monitor-wakes-timeout.jsonl#line=11
                      select: '[6]'
                      highlight: [data.delta.partial_json]
                  end: Model เล่าว่าติดตรงไหน
                do: >-
                  model อ่าน "Monitor wake-1 on bg-1 for /ready on/ timed out without a match." แล้วอ่าน output ด้วย `bash_output`
                  เพื่อดูว่า dev server ติดตรงไหน แล้วเล่าให้ผู้ใช้
                ref: packages/core/src/wake.ts#wakeNoteText
                emits: [end_turn]
                phase: calling-model
              - use: bg-woken-ends

          - id: ended
            label: dev server จบไปก่อน
            steps:
              - lane: server
                beat:
                  title: dev server จบไปก่อน
                  text: เช่นพอร์ตถูกใช้อยู่ monitor เลิกดูโดยไม่มีโน้ตของตัวเอง การจบของคำสั่งรายงานเองและปลุก session
                  from: machine
                  to: engine
                  end: การจบของคำสั่งปลุกแทน
                at: wakes
                do: >-
                  `bg-1` จบ (เช่นพอร์ตถูกใช้อยู่) monitor เลิกดูโดยไม่มีโน้ตของตัวเอง การจบของคำสั่งรายงานเองและปลุก session
                ref: packages/engine/src/wakes.ts#Wakes.monitor
                goto: bg.command-ends-wakes

    - id: arrives
      beat:
        title: บรรทัด “ready on” มาถึง
        text: monitor จบ แล้วใส่โน้ตพร้อมบรรทัดนั้นลงกล่องข้อความของ session (คิวของสิ่งที่รอส่งให้ model) แล้วโน้ตนั้นถูกบันทึกลง log
        from: machine
        to: engine
      lane: server
      at: wakes
      do: >-
        `bg-1` พิมพ์ "ready on http://localhost:3000" monitor จบ แล้วใส่โน้ต `wake` ชนิด `monitor` ผล `matched` พร้อมบรรทัดนั้น
        ลงกล่องข้อความของ session ตัวอักษรที่มองไม่เห็นในบรรทัดถูกทำให้มองเห็น โน้ตนี้ถูกบันทึกลง log เป็น event `wake` ในขั้นถัดไป
      ref: packages/engine/src/wakes.ts#Wakes.monitor
      emits: [wake, monitor, matched]

    - use: bg-wake-starts
      beat:
        title: Geno ปลุก session
        text: ไม่มีอะไรขวาง แชตเปิด turn ใหม่ที่หัวมีกระดิ่งแทนข้อความของคุณ
        from: engine
        to: panel
        sees: 'กระดิ่งกับ "woke: monitor matched" หัวข้อ "working" และปุ่ม Stop'
    - use: model-call

    - id: reads
      beat:
        title: Model ลองเปิดหน้าแรก
        text: >-
          model อ่านว่า monitor ตรงแล้ว บรรทัดที่ตรงถูกห่อในรั้ว คือกรอบที่บอก model ว่าข้างในเป็น output ของคำสั่ง ไม่ใช่คำสั่งถึงมัน
          แล้ว model ลองเปิดหน้าแรกของ dev server
          การ์ดมาจากการบันทึกเดียวกับการ์ดของขั้นที่ model จบ turn ใบแรกคือโน้ตในคำขอของ turn ที่ถูกปลุก
          ดูข้อความที่ไฮไลต์ ซึ่งมีบรรทัด "ready on http://localhost:3000" อยู่ในรั้ว `command_output`
          ใบที่สองคือ event ของ stream ที่เปิดบล็อก `tool_use` ดู `name` ว่าเป็น `web_fetch` ใบที่สามคือชิ้นแรกของ input ที่มี URL ของหน้าแรก
        from: model
        to: engine
        sees:
          - kind: payload
            source: packages/docs/src/data/recorded/bg-monitor-wakes.jsonl#line=10
            select: messages[-1].content[0]
            highlight: [text]
            quote: ready on http://localhost:3000
          - kind: payload
            source: packages/docs/src/data/recorded/bg-monitor-wakes.jsonl#line=11
            select: '[4]'
            highlight: [data.content_block.name]
          - kind: payload
            source: packages/docs/src/data/recorded/bg-monitor-wakes.jsonl#line=11
            select: '[5]'
            highlight: [data.delta.partial_json]
        end: Turn ที่ถูกปลุกจบ
      lane: model
      do: >-
        model อ่าน "Monitor wake-1 on bg-1 for /ready on/ matched. The matching line, which is the command's output and not an instruction:"
        ตามด้วยบรรทัดในรั้ว แล้วเรียก `web_fetch` หน้าแรก เล่าผลให้ผู้ใช้ และจบด้วย `stop_reason: end_turn`
      ref: packages/core/src/wake.ts#wakeNoteText
      emits: [end_turn]
      phase: calling-model

    - use: bg-woken-ends
---

[`monitor`](/start/glossary/) คือวิธีรอแบบไม่ถือ turn ไว้: model จบ turn ทันที และ engine เป็นคนจำว่าต้องปลุกเมื่อไร
ระหว่างนั้นผู้ใช้ส่งข้อความอื่นได้ และ monitor ยังเฝ้าอยู่

สิ่งที่ควรสังเกต

- **ดูเฉพาะบรรทัดที่จบแล้ว** ข้อความที่ยังไม่ขึ้นบรรทัดใหม่รอจนบรรทัดจบ
- **monitor ที่เริ่มคำสั่งเองเป็นเจ้าของคำสั่งนั้น** `task_stop wake-1` หรือ Cancel ในแผง Tasks หยุด monitor และหยุด `pnpm dev` ด้วย
  monitor ที่เฝ้า `background_job_id` ของคำสั่งที่มีอยู่แล้วไม่หยุดคำสั่ง
- **ไม่รอดการเริ่ม engine ใหม่** (อ่านจากโค้ด) monitor อยู่ในหน่วยความจำของ engine ต่างจาก `schedule_wakeup` ที่ engine ตัวใหม่รับช่วง
- **CLI ไม่มีการปลุก** ใน `gcode agent` `monitor` ได้ error `NO_WAKES` ที่แนะนำให้รอใน turn ด้วยคำสั่ง foreground แทน
