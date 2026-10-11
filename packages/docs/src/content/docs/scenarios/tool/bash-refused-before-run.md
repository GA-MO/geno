---
title: คำสั่งถูกปฏิเสธก่อนรัน
description: bash ไม่รันคำสั่งที่ขึ้นต้นด้วย sleep นานๆ คำสั่งที่เปิด dev server ไว้ข้างหน้า หรือคำสั่งที่ออกนอก lane แต่ตอบโมเดลว่าควรใช้เครื่องมือไหนแทน
tableOfContents: false
sidebar:
  order: 3
scenario:
  surface: vscode
  given:
    - turn กำลังทำงานในแผงแชตของ VS Code ซึ่งมีงานเบื้องหลัง (`run_in_background`) และ `monitor` ให้ใช้
    - ไม่มี hook ที่ตั้งไว้
  trigger: >-
    โมเดลขอเรียก `bash` ด้วยคำสั่งที่จะค้างจนหมดเวลา หรือที่ออกไปนอก lane ของ session
  covers: [tool.bash-refused-before-run]
  related: [tool.bash-background, tool.bash-safe-runs, bg.monitor-wakes, wf.lane-apply]
  steps:
    - id: asks
      lane: model
      do: >-
        โมเดลขอเรียก `bash` และจบคำตอบด้วย `stop_reason: tool_use`
      ref: "packages/engine/src/gateway.ts#\"stopReason: message.stop_reason,\""
      emits: [tool_use]
      phase: calling-model

    - use: tool-call-opens

    - id: checks
      lane: tool
      at: executor
      do: >-
        `bash` ตรวจคำสั่งก่อนถามนโยบายและก่อนรันอะไร การตรวจสองข้อแรกทำเฉพาะคำสั่งที่ไม่ได้ขอ `run_in_background`
        และเฉพาะที่มีงานเบื้องหลังให้ใช้แทน
      ref: "packages/engine/src/tools/agent.ts#\"const sleep = run_in_background || tools.background === undefined ? undefined : leadingSleep(command);\""
      fork:
        ask: คำสั่งติดการตรวจข้อไหน
        options:
          - id: sleep
            label: ขึ้นต้นด้วย sleep
            then: result
            steps:
              - lane: tool
                at: executor
                do: >-
                  `leadingSleep` จับ `sleep 30 && curl -s localhost:3000/health` ได้ การรอ 2 วินาทีขึ้นไปที่มีคำสั่งตามหลังถูกปฏิเสธ
                  `sleepRefusal` บอกให้ใช้ `monitor` รอเงื่อนไข หรือรันคำสั่งด้วย `run_in_background: true` แล้วจบ turn
                  และห้ามต่อ sleep สั้นๆ หลบ
                ref: packages/core/src/tools.ts#sleepRefusal
                emits: [Blocked]
          - id: server
            label: เปิด dev server ไว้ข้างหน้า
            then: result
            steps:
              - lane: tool
                at: executor
                do: >-
                  `serverStartOf` อ่าน script ของ `package.json` แล้วเห็นว่า `npm run dev` เปิด server ซึ่งจะค้างจนหมดเวลา
                  `serverRefusal` บอกคำสั่งที่ควรส่งด้วย `run_in_background: true` วิธีรอบรรทัด ready ด้วย `monitor`
                  วิธีหยุดด้วย `task_stop` และ `preview_start` ถ้ามีไฟล์ launch config
                ref: packages/core/src/shell-intent.ts#serverRefusal
                emits: [Blocked]
          - id: lane
            label: session อยู่ใน lane แต่คำสั่งชี้ออกไป
            then: result
            steps:
              - lane: tool
                at: executor
                do: >-
                  session นี้ทำงานใน lane (git worktree แยก) `approveCommand` ให้ `laneCommandDenial` อ่านคำสั่ง
                  `cd ../main && git status` เปลี่ยนไปโฟลเดอร์นอก lane จึงถูกปฏิเสธก่อนถึงกฎของ workspace
                ref: packages/core/src/lanes.ts#laneCommandDenial
                emits: [cd-outside-lane]

    - id: result
      lane: tool
      at: executor
      do: >-
        executor โยน `ToolError` `runExecutor` แปลงเป็นผลสถานะ `error` ด้วยข้อความของมัน ไม่มีอะไรรัน ไม่มีการ์ด
        และไม่มีบันทึกการอนุญาต
      ref: "packages/engine/src/tools/index.ts#\"if (error instanceof ToolError) return { status: 'error', text: error.message };\""

    - use: tool-result-returns

    - id: next
      lane: loop
      at: step
      do: >-
        `loopStep` เห็น `tool-result` ล่าสุดจึงตัดสิน `call-model` turn ไม่หยุด โมเดลได้ `tool_result` ที่มี `is_error: true`
        พร้อมวิธีที่ถูก
      ref: packages/core/src/loop.ts#loopStep
      emits: [call-model]
      phase: calling-model

    - use: model-call

    - id: retry
      lane: model
      do: >-
        โมเดลเรียกตามคำแนะนำ เช่น `bash` ด้วย `npm run dev` และ `run_in_background: true` ซึ่งได้ job id กลับมาทันที
      ref: "packages/engine/src/gateway.ts#\"stopReason: message.stop_reason,\""
      emits: [tool_use]
      end: { turn: continues, reason: tool_use }
---

การตรวจเหล่านี้กันไม่ให้ call หนึ่งตัวค้างจนถึง timeout 120 วินาทีโดยไม่ได้อะไร
ข้อความปฏิเสธจึงไม่ได้บอกแค่ว่าไม่ได้ แต่บอกเครื่องมือที่ใช้แทนได้

| คำสั่ง | ถูกจับโดย | ให้ใช้แทน |
| --- | --- | --- |
| `sleep 30 && ...` | `leadingSleep` | `monitor` หรือ `run_in_background` |
| `npm run dev`, `vite`, `... &` | `serverStartOf` | `run_in_background` แล้ว `monitor` หรือ `preview_start` |
| `cd ../main`, `git -C ../main`, `GIT_DIR=...` | `laneCommandDenial` | ทำงานใน lane เท่านั้น |

สิ่งที่ควรสังเกต

- **ไม่ใช่การปฏิเสธของผู้ใช้** ผลมีสถานะ `error` ไม่ใช่ `rejected` หรือ `denied` turn ทำงานต่อ และแผงแสดงขั้นนั้นว่าล้มเหลว
- **เกิดก่อนนโยบาย** คำสั่งเหล่านี้ไม่ไปถึง `ruledDenial` การ์ด หรือ classifier แม้กฎของ workspace จะอนุญาตคำสั่งนั้นไว้
- **ไม่มีงานเบื้องหลังก็ไม่ตรวจ** ที่ที่ไม่มี `run_in_background` ให้ใช้ เช่นเอเจนต์ลูกบางตัว `sleep` และ dev server รันได้ตามปกติ
  และจะถูกฆ่าเมื่อครบเวลา ดู [คำสั่งปลอดภัยรันโดยไม่ถาม](/scenarios/tool/bash-safe-runs/)
