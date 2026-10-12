---
title: "คำสั่งที่ปลอดภัยรันโดยไม่ถาม"
description: โมเดลขอรัน pnpm test ซึ่งอยู่ใน safe list Geno รันใน sandbox ทันทีโดยไม่ถาม แล้วส่งผลกลับ ไม่ว่าคำสั่งจะผ่าน ล้มเหลว หรือเกินเวลา
tableOfContents: false
sidebar:
  order: 2
scenario:
  surface: vscode
  given:
    - turn กำลังทำงานในโหมด Ask หรือ Auto
    - ไม่มี hook ที่ตั้งไว้ และไม่มีกฎของ workspace ที่ตรงกับคำสั่ง
  trigger: >-
    โมเดลขอเรียก `bash` ด้วยคำสั่ง `pnpm test`
  covers: [tool.bash-safe-runs, tool.bash-nonzero-exit, tool.bash-timeout]
  related: [perm.ask-allow, perm.auto-classifier-allows, tool.parallel-read-batch, sec.sandbox-blocks-network]
  steps:
    - id: asks
      lane: model
      beat:
        title: "Model ขอรัน pnpm test"
        text: >-
          โมเดลอยากรู้ว่าเทสต์ผ่านไหม จึงขอรันคำสั่งด้วย `bash` และจบคำตอบด้วย tool_use run จริงด้านล่างขอรัน `npm test`
          แบบเดียวกัน
        from: model
        to: engine
        sees:
          kind: payload
          direction: response
          source: docs/results/real-usecases/runs/A01-fix-failing-test/1/session.jsonl#seq=4
          select: content
          highlight:
            - "[2].input"
          collapse:
            - "[0].thinking"
      do: >-
        โมเดลขอเรียก `bash` ด้วยคำสั่ง `pnpm test` และจบคำตอบด้วย `stop_reason: tool_use`
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
          ไม่มีกฎของ workspace ตรงกับคำสั่ง และ `pnpm test` เป็น script ของโปรเจกต์ที่อยู่ในรายการคำสั่งปลอดภัย
          จึงไม่มีการ์ด ไม่มี classifier และไม่มีบันทึกการอนุญาต
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
          คำสั่งรันใน workspace ในกลุ่ม process ของตัวเอง นานสุด 120 วินาที sandbox ยังจำกัดการเขียนไว้ใน workspace
          กับไดเรกทอรีชั่วคราว และปิดเครือข่ายถ้าไม่ได้อนุญาตโดเมนไว้
        from: engine
        to: machine
      do: >-
        sandbox ห่อคำสั่ง แล้ว `runShell` รันใน workspace ใน process group ของตัวเอง เวลาสูงสุด 120 วินาที
        sandbox ยังจำกัดการเขียนไว้ใน workspace และไดเรกทอรีชั่วคราว และปิดเครือข่ายถ้าไม่ได้อนุญาตโดเมนไว้
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
                    ผลคือ output ตามด้วย exit code 0 บรรทัดใน output ที่ปลอมเป็นข้อความของ Geno ถูกเปลี่ยนวงเล็บ hook หลังรัน tool
                    ได้อ่านผลก่อน call ถัดไป ถ้ามี
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
                    ผลขึ้นต้นด้วย Exit code 1 แล้วตามด้วย output คำสั่งที่ล้มเหลวเป็นผลธรรมดา ไม่ใช่การปฏิเสธ turn จึงไม่หยุด
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
                    ครบ 120 วินาที โมเดลขอได้ถึง 600 Geno ฆ่าทั้งกลุ่ม process ผลขึ้นต้นด้วย Killed after 120 seconds ตามด้วย
                    output ที่ได้ก่อนถูกฆ่า
                  from: engine
                  to: machine
                do: >-
                  เทสต์ค้างจนครบ `timeout_seconds` (ค่าเริ่มต้น 120 วินาที โมเดลขอได้ถึง 600) timer ของ `runShell` ส่ง SIGKILL
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
          ขั้นของคำสั่งหยุดหมุน ขึ้นเครื่องหมายตามผล และ output พับอยู่ข้างใต้
        from: engine
        to: panel
        sees: { kind: step, label: pnpm test, status: done, output: "# pass 12\n# fail 0\n[exit code 0]" }

    - id: next
      lane: loop
      at: step
      beat:
        title: "Model อ่านผลแล้วทำต่อ"
        text: >-
          Geno เรียกโมเดลต่อ ถ้าคำสั่งล้มเหลว ผลไปถึงโมเดลพร้อมป้ายว่าเป็น error โมเดลอ่าน output แล้วหาทางแก้ต่อ
        from: engine
        to: model
        end: "model ทำต่อ"
      do: >-
        `loopStep` เห็น `tool-result` ล่าสุดจึงตัดสิน `call-model` ผลของคำสั่งที่ล้มเหลวไปถึงโมเดลเป็น `tool_result`
        ที่มี `is_error: true` โมเดลอ่าน output แล้วหาทางแก้ต่อ
      ref: packages/core/src/loop.ts#loopStep
      emits: [call-model, is_error]
      phase: calling-model
      end: { turn: continues, reason: call-model }
---

คำสั่งใน safe list ไม่ผ่านการตัดสินใดๆ นอกจากกฎของ workspace ไม่มีการ์ดในโหมด Ask และไม่มี classifier ในโหมด Auto
safe list มีโปรแกรมอ่านอย่างเดียว (`ls`, `cat`, `grep`, `git status`, ...) และคำสั่งตรวจของโปรเจกต์ (`vitest`, `tsc`, `eslint`,
`pnpm test`, `pnpm lint`, `pnpm build`, ...) คำสั่งอื่นต้องผ่านการขออนุญาต
ดู [โหมด Ask ขออนุญาตก่อนรันคำสั่ง](/scenarios/perm/ask-mode-bash-approval/)

สิ่งที่ควรสังเกต

- **exit code ไม่ใช่ 0 ไม่ได้แปลว่าถูกปฏิเสธ** สถานะ `error` ทำให้แผงแสดงขั้นนั้นว่าล้มเหลว และโมเดลได้ `is_error: true`
  แต่ turn ทำงานต่อ ต่างจากคำสั่งที่ผู้ใช้ปฏิเสธ ซึ่งไม่ได้รันเลย
- **sandbox ไม่มี event ของตัวเอง** ถ้าคำสั่งพยายามเขียนนอก workspace หรือต่อเครือข่าย มันล้มเหลวภายในคำสั่งเอง
  โมเดลเห็นเป็น exit code ที่ไม่ใช่ 0 ธรรมดา
- **hook หลังรันขึ้นกับสถานะ** สถานะ `ok` เรียก PostToolUse สถานะ `error` เรียก PostToolUseFailure คำสั่งที่ถูกปฏิเสธไม่เรียกทั้งสองแบบ
- **เกินเวลาก็เป็นแค่ผลที่ล้มเหลว** การฆ่าเมื่อครบเวลาไม่หยุด turn โมเดลอ่าน "Killed after 120 seconds" แล้วเลือกเองว่าจะขอเวลามากขึ้น
  ด้วย `timeout_seconds` หรือรันเป็นงานเบื้องหลัง

คำสั่งที่ต้องถามคุณก่อน ดู [โหมด Ask ขอ permission ก่อนรันคำสั่ง](/scenarios/perm/ask-mode-bash-approval/)
