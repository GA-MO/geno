---
title: "คำสั่งที่ปลอดภัยรันโดยไม่ถาม"
description: model ขอรัน pnpm test ซึ่งอยู่ใน safe list Geno รันใน sandbox ทันทีโดยไม่ถาม แล้วส่งผลกลับ ไม่ว่าคำสั่งจะผ่าน ล้มเหลว หรือเกินเวลา
scenario:
  surface: vscode
  given:
    - turn กำลังทำงานในโหมด Ask หรือ Auto
    - ไม่มี hook ที่ตั้งไว้ และไม่มีกฎของ workspace ที่ตรงกับคำสั่ง
  trigger: >-
    model ขอเรียก `bash` ด้วยคำสั่ง `pnpm test`
  covers: [tool.bash-safe-runs, tool.bash-nonzero-exit, tool.bash-timeout]
  related: [perm.ask-allow, perm.auto-classifier-allows, tool.parallel-read-batch, sec.sandbox-blocks-network]
  steps:
    - id: asks
      lane: model
      beat:
        title: "Model ขอรัน pnpm test"
        text: >-
          model อยากรู้ว่าเทสต์ผ่านไหม จึงขอรันคำสั่งด้วย tool `bash` และจบคำตอบด้วย `stop_reason: tool_use`
          การ์ดข้างล่างมาจาก run จริงที่ขอรัน `npm test` แบบเดียวกัน ดู `command` ใน `input` ที่ไฮไลต์ไว้
        from: model
        to: engine
        sees:
          kind: payload
          source: docs/results/real-usecases/runs/A01-fix-failing-test/1/session.jsonl#seq=4
          select: content
          highlight:
            - "[2].input"
          collapse:
            - "[0].thinking"
      do: >-
        model ขอเรียก `bash` ด้วยคำสั่ง `pnpm test` และจบคำตอบด้วย `stop_reason: tool_use`
      ref: "packages/engine/src/gateway.ts#\"stopReason: message.stop_reason,\""
      emits: [tool_use]
      phase: calling-model

    - id: logged
      lane: loop
      at: drive
      do: >-
        `drive` บันทึก event `assistant` ที่มีบล็อก `tool_use` ของ `bash` ลง log
      ref: "packages/engine/src/drive.ts#\"await record({ kind: 'assistant', seq: nextSeq(events), at, ...result.turn\""
      emits: [assistant]

    - use: tool-call-opens
      beat:
        title: "แชตขึ้นขั้น pnpm test"
        text: >-
          Geno จัดคิว `bash` ให้รันเป็นชุดของตัวเอง แชตขึ้นขั้นใหม่พร้อมจุดหมุน
        from: engine
        to: panel
        sees: { kind: step, label: pnpm test, status: running }

    - id: checks
      lane: tool
      at: executor
      beat:
        title: "bash ตรวจว่าคำสั่งจะไม่ค้าง"
        text: >-
          คำสั่งไม่ได้ขึ้นต้นด้วย sleep นาน และไม่ได้เปิด dev server ที่ไม่จบเอง สองกรณีนั้นจะถูกปฏิเสธพร้อมคำแนะนำ
        from: engine
        to: engine
      do: >-
        `bash` ตรวจคำสั่งก่อน: ไม่ได้ขึ้นต้นด้วย `sleep` นานๆ และไม่ได้เปิด dev server ซึ่งจะค้างไม่จบ
        ทั้งสองกรณีนี้ถูกปฏิเสธพร้อมคำแนะนำให้ใช้งานเบื้องหลังแทน
      ref: "packages/engine/src/tools/agent.ts#\"const sleep = run_in_background || tools.background === undefined ? undefined : leadingSleep(command);\""

    - id: rules
      lane: policy
      at: rules
      beat:
        title: "Geno ตรวจกฎแล้วไม่ต้องถาม"
        text: >-
          ไม่มีกฎของ workspace ตรงกับคำสั่ง และ `pnpm test` เป็น script ของโปรเจกต์ที่อยู่ในรายการคำสั่งปลอดภัย (safe list)
          จึงไม่มีการ์ดถามคุณในโหมด Ask ไม่มี classifier ซึ่งเป็นการเรียก model อีกครั้งที่โหมด Auto ใช้ตัดสินคำสั่ง
          และไม่มีบันทึกการอนุญาตติดไปกับผล
        from: engine
        to: engine
      do: >-
        `approveCommand` ส่งคำสั่งให้ `ruledDenial` ไม่มีกฎ deny หรือ ask ของ workspace ตรง และ `pnpm test`
        เป็น script ของโปรเจกต์ที่อยู่ใน safe list จึงไม่มีกฎใดติดธง ผลคือไม่มี denial
        `settle` ไม่ถูกเรียก ไม่มีการ์ด ไม่มี classifier และไม่มีบันทึกการอนุญาตติดไปกับผล
      ref: packages/core/src/permission-rules.ts#ruledDenial

    - id: run
      lane: tool
      at: shell
      beat:
        title: "pnpm test รันใน sandbox"
        text: >-
          คำสั่งรันใน workspace ในกลุ่ม process ของตัวเอง นานสุด 120 วินาที ภายใน sandbox ซึ่งเป็นกรอบของระบบปฏิบัติการ
          ที่จำกัดการเขียนไว้ใน workspace กับไดเรกทอรีชั่วคราว และต่อเครือข่ายได้แค่ host ที่อนุญาต
          ค่าเริ่มต้นมี host ของ package registry และ GitHub (`PACKAGE_HOSTS`) ปิดได้ด้วย `gcode.sandbox.packageHosts`
          ถึงไม่ต้องถามคุณ sandbox ก็ยังกันอยู่
        from: engine
        to: machine
      do: >-
        sandbox ห่อคำสั่ง แล้ว `runShell` รันใน workspace ใน process group ของตัวเอง เวลาสูงสุด 120 วินาที
        sandbox ยังจำกัดการเขียนไว้ใน workspace และไดเรกทอรีชั่วคราว และต่อเครือข่ายได้แค่ host ที่อนุญาต
        ซึ่งค่าเริ่มต้นมี `PACKAGE_HOSTS` (packages/core/src/agent.ts)
      ref: "packages/engine/src/tools/agent.ts#\"const result = await tools.sandbox.run(command, {\""

    - id: exit
      lane: tool
      at: shell
      beat:
        title: "คำสั่งจบ"
        text: >-
          คำสั่งจบเองหรือถูกฆ่าเมื่อครบเวลา Geno เก็บ output ท้ายสุดไม่เกิน 4 MB และ exit code ลองเลือกว่ามันจบอย่างไร
        from: machine
        to: engine
        ask: "จบอย่างไร"
      do: คำสั่งจบเอง หรือถูกฆ่าเมื่อครบเวลา `runShell` เก็บ output ท้ายสุดไม่เกิน 4 MB และ exit code
      ref: packages/engine/src/process.ts#runShell
      fork:
        ask: คำสั่งจบอย่างไร
        options:
          - id: zero
            label: 0 (เทสต์ผ่าน)
            steps:
              - lane: tool
                at: executor
                beat:
                  title: "เทสต์ผ่าน exit code 0"
                  text: >-
                    ผลคือ output ตามด้วย `[exit code 0]` ถ้า output มีบรรทัดที่ขึ้นต้นด้วย `[Geno` Geno เปลี่ยนวงเล็บของบรรทัดนั้น
                    เพื่อไม่ให้ output ของคำสั่งแอบอ้างเป็นโน้ตของ Geno ถ้าคุณตั้ง hook ไว้ (คำสั่ง shell ที่ Geno รันเมื่อเกิดเหตุการณ์)
                    hook หลังรัน tool ได้อ่านผลก่อน call ถัดไป
                  from: machine
                  to: engine
                do: >-
                  ข้อความผลคือ output ตามด้วย `[exit code 0]` สถานะ `ok` บรรทัดที่ขึ้นต้นด้วย `[Geno` ใน output
                  ถูกเปลี่ยนวงเล็บ เพื่อไม่ให้ output แอบอ้างเป็นข้อความของ harness
                ref: packages/core/src/tools.ts#commandStatusLine
              - lane: policy
                at: hooks
                do: >-
                  PostToolUse hooks ได้อ่านผลก่อน call ถัดไปเริ่ม เมื่อไม่มี hook ก็ผ่านไป
                ref: packages/engine/src/hooks.ts#AFTER_TOOL_EVENT
                emits: [PostToolUse]
          - id: nonzero
            label: ไม่ใช่ 0 (เทสต์ล้มเหลว)
            steps:
              - lane: tool
                at: executor
                beat:
                  title: "เทสต์ล้ม exit code 1"
                  text: >-
                    ผลขึ้นต้นด้วย Exit code 1 แล้วตามด้วย output และมีสถานะ error คำสั่งที่ล้มเหลวเป็นผลธรรมดา
                    ไม่ใช่การปฏิเสธ turn จึงไม่หยุด
                  from: machine
                  to: engine
                do: >-
                  ข้อความผลขึ้นต้นด้วย `Exit code 1` ตามด้วย output และ `[exit code 1]` สถานะเป็น `error`
                  คำสั่งที่ล้มเหลวเป็นผลธรรมดา ไม่ใช่การปฏิเสธ turn จึงไม่หยุด
                ref: packages/core/src/tools.ts#commandFailureLine
              - lane: policy
                at: hooks
                do: >-
                  PostToolUseFailure hooks ได้อ่านข้อความผลเป็น `error` ก่อน call ถัดไปเริ่ม เมื่อไม่มี hook ก็ผ่านไป
                ref: packages/engine/src/hooks.ts#AFTER_TOOL_EVENT
                emits: [PostToolUseFailure]
          - id: timeout
            label: เกิน 120 วินาที
            steps:
              - lane: tool
                at: shell
                beat:
                  title: "เทสต์ค้างจนครบเวลา Geno ฆ่าทิ้ง"
                  text: >-
                    ครบ 120 วินาที (ค่าตั้งต้น model ขอเพิ่มได้ถึง 600 ด้วย `timeout_seconds`) Geno ฆ่าทั้งกลุ่ม process ผลขึ้นต้นด้วย Killed after 120 seconds ตามด้วย
                    output ที่ได้ก่อนถูกฆ่า
                  from: engine
                  to: machine
                do: >-
                  เทสต์ค้างจนครบ `timeout_seconds` (ค่าเริ่มต้น 120 วินาที model ขอได้ถึง 600) timer ของ `runShell` ส่ง SIGKILL
                  ให้ทั้ง process group คำสั่งลูกที่มันเปิดไว้จึงจบไปด้วย
                ref: "packages/engine/src/process.ts#\"options.timeoutMs === undefined\""
              - lane: tool
                at: executor
                do: >-
                  ข้อความผลขึ้นต้นด้วย `Killed after 120 seconds` ตามด้วย output ที่ได้ก่อนถูกฆ่า และปิดท้ายด้วย `[killed after 120 seconds]`
                  สถานะเป็น `error` เหมือนคำสั่งที่ล้มเหลว
                ref: packages/core/src/tools.ts#commandFailureLine
                emits: [Killed after]
              - lane: policy
                at: hooks
                do: >-
                  PostToolUseFailure hooks ได้อ่านผลก่อน call ถัดไปเริ่ม เมื่อไม่มี hook ก็ผ่านไป
                ref: packages/engine/src/hooks.ts#AFTER_TOOL_EVENT
                emits: [PostToolUseFailure]

    - use: tool-result-returns
      beat:
        title: "ผลกลับมาที่แชต"
        text: >-
          ขั้นของคำสั่งหยุดหมุน ขึ้นเครื่องหมายตามผล (ถูกเมื่อผ่าน กากบาทเมื่อล้มเหลวหรือเกินเวลา) และ output พับอยู่ข้างใต้
        from: engine
        to: panel

    - id: next
      lane: loop
      at: step
      beat:
        title: "Geno เรียก model อีกครั้ง"
        text: >-
          Geno ส่งบทสนทนาทั้งหมดไปให้ model อีกครั้งในคำขอใหม่ ท้ายคำขอคือคำขอ `bash` ของ model และผลของคำสั่ง
          ถ้าคำสั่งล้มเหลว `tool_result` มี `is_error: true` ด้วย การ์ดข้างล่างเป็นคำขอจริงจากการรันเดียวกับการ์ดแรก
          ดูบล็อก `tool_use` ในข้อความ `assistant` และ `tool_result` ในข้อความ `user` ที่ไฮไลต์ไว้ `content` คือ output ของเทสต์
          ในการ์ดนี้ไม่มี `is_error` เพราะคำสั่งจบด้วย exit code 0
        from: engine
        to: model
        sees:
          kind: payload
          source: docs/results/real-usecases/runs/A01-fix-failing-test/1/requests.jsonl#seq=7
          select: messages
          collapse: ['[0]']
          highlight: ['[1].content[2]', '[2].content[0]']
          quote: "[exit code 0]"
      do: >-
        `loopStep` เห็น `tool-result` ล่าสุดจึงตัดสิน `call-model` ผลของคำสั่งที่ล้มเหลวไปถึง model เป็น `tool_result`
        ที่มี `is_error: true`
      ref: packages/core/src/loop.ts#loopStep
      emits: [call-model, is_error]
      phase: calling-model

    - id: reply
      lane: model
      beat:
        title: "Model อ่านผลแล้วทำต่อ"
        text: >-
          model ตอบหลังได้คำขอนี้เท่านั้น ในการรันจริงนี้คำสั่งต่อท้ายด้วย `| tail -30` exit code จึงเป็น 0
          แต่ output บอกว่าเทสต์ล้ม 4 ตัว model อ่าน output แล้วขอรัน `bash` อีกครั้งเพื่อดูว่าตัวไหนล้ม
          ดู `command` ใน `input` ที่ไฮไลต์ไว้
        from: model
        to: engine
        sees:
          kind: payload
          source: docs/results/real-usecases/runs/A01-fix-failing-test/1/session.jsonl#seq=7
          select: content
          collapse: ['[0].thinking']
          highlight: ['[1].input']
        end: "model ทำต่อ"
      do: >-
        model อ่าน `tool_result` ของ `bash` แล้วตอบด้วยคำขอใหม่ ในการรันนี้คือ `bash` อีกตัว
        และจบคำตอบด้วย `stop_reason: tool_use`
      ref: "packages/engine/src/gateway.ts#\"stopReason: message.stop_reason,\""
      emits: [tool_use]
      end: { turn: continues, reason: run-tools }
---

คำสั่งใน safe list ไม่ผ่านการตัดสินใดๆ นอกจากกฎของ workspace ไม่มีการ์ดในโหมด Ask และไม่มี classifier ในโหมด Auto
safe list มีโปรแกรมอ่านอย่างเดียว (`ls`, `cat`, `grep`, `git status`, ...) และคำสั่งตรวจของโปรเจกต์ (`vitest`, `tsc`, `eslint`,
`pnpm test`, `pnpm lint`, `pnpm build`, `node --version`, `node --check`, `node --test`, ...) คำสั่งอื่นต้องผ่านการขออนุญาตในโหมด Ask
ส่วนโหมด Auto รันคำสั่งอื่นใน sandbox เองถ้าไม่มีกฎอื่นจับ เช่น `pnpm add zod` และส่งที่กฎจับ เช่น `rm -rf dist` ให้ classifier
ตัวแปรที่ยังไม่ได้แทนค่า เช่น `$?` อยู่ได้เฉพาะใน argument ของ `echo`, `printf`, `test`, `[`, `true`, `false` และ `for` อย่าง `echo "exit: $?"`
ถ้าตัวแปรเป็นชื่อโปรแกรม ไฟล์ของ redirect หรือ argument อื่น คำสั่งนั้นไม่นับว่าอยู่ใน safe list และ `printf -v` ที่ตั้งค่าตัวแปรก็ไม่นับ
ดู [โหมด Ask ขออนุญาตก่อนรันคำสั่ง](/scenarios/perm/ask-mode-bash-approval/)

สิ่งที่ควรสังเกต

- **exit code ไม่ใช่ 0 ไม่ได้แปลว่าถูกปฏิเสธ** สถานะ `error` ทำให้แผงแสดงขั้นนั้นว่าล้มเหลว และ model ได้ `is_error: true`
  แต่ turn ทำงานต่อ ต่างจากคำสั่งที่ผู้ใช้ปฏิเสธ ซึ่งไม่ได้รันเลย
- **sandbox ไม่มี event ของตัวเอง** ถ้าคำสั่งพยายามเขียนนอก workspace หรือต่อเครือข่าย มันล้มเหลวภายในคำสั่งเอง
  model เห็นเป็น exit code ที่ไม่ใช่ 0 ธรรมดา
- **hook หลังรันขึ้นกับสถานะ** สถานะ `ok` เรียก PostToolUse สถานะ `error` เรียก PostToolUseFailure คำสั่งที่ถูกปฏิเสธไม่เรียกทั้งสองแบบ
- **เกินเวลาก็เป็นแค่ผลที่ล้มเหลว** การฆ่าเมื่อครบเวลาไม่หยุด turn model อ่าน "Killed after 120 seconds" แล้วเลือกเองว่าจะขอเวลามากขึ้น
  ด้วย `timeout_seconds` หรือรันเป็นงานเบื้องหลัง

คำสั่งที่ต้องถามคุณก่อน ดู [โหมด Ask ขอ permission ก่อนรันคำสั่ง](/scenarios/perm/ask-mode-bash-approval/)
