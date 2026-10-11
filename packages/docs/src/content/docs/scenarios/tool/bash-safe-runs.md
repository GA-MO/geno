---
title: คำสั่งปลอดภัยรันโดยไม่ถาม
description: โมเดลขอรัน pnpm test ซึ่งอยู่ใน safe list Geno รันใน sandbox ทันทีโดยไม่ถาม แล้วส่งผลกลับ ไม่ว่าคำสั่งจะผ่านหรือล้มเหลว
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
  covers: [tool.bash-safe-runs, tool.bash-nonzero-exit]
  related: [perm.ask-allow, perm.auto-classifier-allows, tool.parallel-read-batch, sec.sandbox-blocks-network]
  steps:
    - id: asks
      lane: model
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

    - id: checks
      lane: tool
      at: executor
      do: >-
        `bash` ตรวจคำสั่งก่อน: ไม่ได้ขึ้นต้นด้วย `sleep` นานๆ และไม่ได้เปิด dev server ซึ่งจะค้างไม่จบ
        ทั้งสองกรณีนี้ถูกปฏิเสธพร้อมคำแนะนำให้ใช้งานเบื้องหลังแทน
      ref: "packages/engine/src/tools/agent.ts#\"const sleep = run_in_background || tools.background === undefined ? undefined : leadingSleep(command);\""

    - id: rules
      lane: policy
      at: rules
      do: >-
        `approveCommand` ส่งคำสั่งให้ `ruledDenial` ไม่มีกฎ deny หรือ ask ของ workspace ตรง และ `pnpm test`
        เป็น script ของโปรเจกต์ที่อยู่ใน safe list จึงไม่มีกฎใดติดธง ผลคือไม่มี denial
        `settle` ไม่ถูกเรียก ไม่มีการ์ด ไม่มี classifier และไม่มีบันทึกการอนุญาตติดไปกับผล
      ref: packages/core/src/permission-rules.ts#ruledDenial

    - id: run
      lane: tool
      at: shell
      do: >-
        sandbox ห่อคำสั่ง แล้ว `runShell` รันใน workspace ใน process group ของตัวเอง เวลาสูงสุด 120 วินาที
        sandbox ยังจำกัดการเขียนไว้ใน workspace และไดเรกทอรีชั่วคราว และปิดเครือข่ายถ้าไม่ได้อนุญาตโดเมนไว้
      ref: "packages/engine/src/tools/agent.ts#\"const result = await tools.sandbox.run(command, {\""

    - id: exit
      lane: tool
      at: shell
      do: คำสั่งจบ `runShell` เก็บ output ท้ายสุดไม่เกิน 4 MB และ exit code
      ref: packages/engine/src/process.ts#runShell
      fork:
        ask: คำสั่งจบด้วย exit code อะไร
        options:
          - id: zero
            label: 0 (เทสต์ผ่าน)
            steps:
              - lane: tool
                at: executor
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

    - use: tool-result-returns

    - id: next
      lane: loop
      at: step
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
