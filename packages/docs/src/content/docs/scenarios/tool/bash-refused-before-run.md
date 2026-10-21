---
title: "bash ปฏิเสธคำสั่งก่อนรัน แล้วบอกทางที่ถูก"
description: bash ไม่รันคำสั่งที่ขึ้นต้นด้วย sleep นานๆ คำสั่งที่เปิด dev server ไว้ข้างหน้าหรือด้วย & หรือคำสั่งที่ออกนอก lane แต่ตอบ model ว่าควรใช้ tool ไหนแทน
scenario:
  surface: vscode
  given:
    - turn กำลังทำงานในแผงแชตของ VS Code ซึ่งมีงานเบื้องหลัง (`run_in_background`) และ `monitor` ให้ใช้
    - ไม่มี hook ที่ตั้งไว้
  trigger: >-
    model ขอเรียก `bash` ด้วยคำสั่งที่จะค้างจนหมดเวลา หรือที่ออกไปนอก lane ของ session
  covers: [tool.bash-refused-before-run]
  related: [tool.bash-background, tool.bash-safe-runs, bg.monitor-wakes, wf.lane-apply]
  steps:
    - id: asks
      lane: model
      beat:
        title: "Model ขอรันคำสั่งด้วย bash"
        text: >-
          model ขอรันคำสั่งที่จะค้างจนหมดเวลา หรือคำสั่งที่ออกไปนอก lane ของ session
          (lane คือโฟลเดอร์ git worktree แยกที่ session บางตัวทำงานอยู่)
          การ์ดข้างล่างเป็นคำตอบจริงจากการรันหนึ่ง ดู `command` ใน `input` ที่ไฮไลต์ไว้
          model ขอเปิด `npm run dev` ไว้ด้วย `&` แล้วรอให้ server ตอบในคำสั่งเดียว
        from: model
        to: engine
        sees:
          kind: payload
          source: docs/results/real-usecases/runs/A12-background-server/sonnet-1/session.jsonl#seq=9
          select: content
          highlight: ['[1].input']
      do: >-
        model ขอเรียก `bash` และจบคำตอบด้วย `stop_reason: tool_use`
      ref: "packages/engine/src/gateway.ts#\"stopReason: message.stop_reason,\""
      emits: [tool_use]
      phase: calling-model

    - use: tool-call-opens
      beat:
        title: "แชตขึ้นขั้นของคำสั่ง"
        text: >-
          Geno จัดคิว `bash` ให้รันทีละตัว แชตขึ้นขั้นใหม่พร้อมจุดหมุน
        from: engine
        to: panel

    - id: checks
      lane: tool
      at: executor
      beat:
        title: "bash ตรวจคำสั่งก่อนถามกฎสิทธิ์"
        text: >-
          ก่อนถามกฎสิทธิ์และก่อนรันอะไร `bash` ตรวจคำสั่งเอง สองข้อแรกตรวจเฉพาะคำสั่งที่รอผล คือคำสั่งที่ Geno รอจนจบก่อนตอบ model
          และเฉพาะเมื่อมีงานเบื้องหลังให้ใช้แทน งานเบื้องหลังคือคำสั่งที่รันต่อไปโดย turn ไม่รอ (`run_in_background: true`)
          ลองเลือกว่าคำสั่งติดข้อไหน
        from: engine
        to: engine
        ask: "ติดข้อไหน"
      runs: 0
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
                beat:
                  title: "คำสั่งขึ้นต้นด้วย sleep นาน"
                  text: >-
                    `sleep 30 && curl -s localhost:3000/health` รอ 2 วินาทีขึ้นไปแล้วมีคำสั่งตามหลัง bash บอกให้ใช้ `monitor`
                    (tool ที่เฝ้า output แล้วปลุก session เมื่อเจอบรรทัดที่ต้องการ) รอเงื่อนไข หรือรันแบบเบื้องหลังแล้วจบ turn
                    และห้ามต่อ sleep สั้นๆ หลบ ข้อความนี้เป็นผลของ call ถึง model ตอนเรียกครั้งถัดไป
                    การ์ดข้างล่างเป็นผลจริงจากการรันที่ model ต่อ `sleep 5` หน้า `curl` ดู `status` ที่เป็น `error`
                    และ `output` ที่ขึ้นต้นด้วย "Blocked" แล้วบอกทางที่ถูก
                  from: engine
                  to: engine
                  sees:
                    kind: payload
                    source: docs/results/real-usecases/runs/A12-background-server/fix-a2/session.jsonl#seq=11
                    highlight: [status, output]
                do: >-
                  `leadingSleep` จับ `sleep 30 && curl -s localhost:3000/health` ได้ การรอ 2 วินาทีขึ้นไปที่มีคำสั่งตามหลังถูกปฏิเสธ
                  `sleepRefusal` บอกให้ใช้ `monitor` รอเงื่อนไข หรือรันคำสั่งด้วย `run_in_background: true` แล้วจบ turn
                  และห้ามต่อ sleep สั้นๆ หลบ
                ref: packages/core/src/tools.ts#sleepRefusal
                emits: [Blocked]
          - id: server
            label: เปิด dev server ไว้ข้างหน้าหรือด้วย &
            then: result
            steps:
              - lane: tool
                at: executor
                beat:
                  title: "คำสั่งเปิด dev server ไว้ข้างหน้าหรือด้วย &"
                  text: >-
                    bash อ่าน script ใน `package.json` แล้วเห็นว่า `npm run dev` เปิด server ถ้ารันไว้ข้างหน้า call จะค้างจนหมดเวลา ถ้าต่อท้ายด้วย `&` server จะค้างอยู่หลัง call และ session จบ คำสั่งในการ์ดมี `&` ผลจึงบอกเหตุผลข้อหลัง
                    มันบอกคำสั่งที่ควรรันเบื้องหลัง วิธีรอให้ server พร้อม และวิธีหยุด ข้อความนี้เป็นผลของ call
                    ถึง model ตอนเรียกครั้งถัดไป วิธีรอขึ้นกับว่ามีอะไรปลุก session ได้ไหม ในแผงแชตของ VS Code ซึ่งปลุกได้
                    ผลบอกให้รอด้วย `monitor` ที่ดักบรรทัด ready ของ server แล้วจบ turn
                    การ์ดข้างล่างเป็นผลจริงของคำขอในการ์ดแรก แต่การรันนั้นสั่งจาก command line โดยไม่มีคนดู
                    ซึ่ง `monitor` ปลุก session ไม่ได้ ผลในการ์ดจึงบอกให้รอด้วยคำสั่ง `bash` ธรรมดาหนึ่งคำสั่งที่ Geno รอจนจบ
                    ซึ่งวน `curl` จนกว่า server จะตอบ `npm run dev` ที่มี `&` ก็ถูกจับแบบเดียวกัน
                    ดู `status` ที่เป็น `error` และ `output` ที่บอกให้เริ่ม server แยกต่างหาก โดยเรียก `bash` ใหม่ด้วย `"run_in_background": true`
                    การ์ดของขั้นถัดๆ ไปบนหน้านี้มาจากการรันเดียวกันนี้
                  from: engine
                  to: engine
                  sees:
                    kind: payload
                    source: docs/results/real-usecases/runs/A12-background-server/sonnet-1/session.jsonl#seq=10
                    quote: "Start it on its own instead: call bash with {\"command\": \"npm run dev\", \"run_in_background\": true}"
                    highlight: [status, output]
                do: >-
                  `serverStartOf` อ่าน script ของ `package.json` แล้วเห็นว่า `npm run dev` เปิด server `serverRefusal` บอกเหตุผลตาม `background` (ค้างจนหมดเวลา หรือค้างอยู่หลัง call)
                  `serverRefusal` บอกคำสั่งที่ควรส่งด้วย `run_in_background: true` วิธีรอ (บรรทัด ready ด้วย `monitor`
                  เมื่อ `tools.wakes` มี ไม่อย่างนั้นวน `until curl -sf ...` ข้างหน้าด้วย `timeout_seconds`)
                  วิธีหยุดด้วย `task_stop` และ `preview_start` ถ้ามีไฟล์ launch config
                ref: packages/core/src/shell-intent.ts#serverRefusal
                emits: [Blocked]
          - id: lane
            label: session อยู่ใน lane แต่คำสั่งชี้ออกไป
            then: result
            steps:
              - lane: tool
                at: executor
                beat:
                  title: "คำสั่งออกไปนอก lane"
                  text: >-
                    session นี้ทำงานใน lane ซึ่งเป็น git worktree แยก `cd ../main && git status` ออกไปนอก lane
                    จึงถูกปฏิเสธก่อนถึงกฎของ workspace ข้อความปฏิเสธเป็นผลของ call ถึง model ตอนเรียกครั้งถัดไป
                  from: engine
                  to: engine
                do: >-
                  session นี้ทำงานใน lane (git worktree แยก) `approveCommand` ให้ `laneCommandDenial` อ่านคำสั่ง
                  `cd ../main && git status` เปลี่ยนไปโฟลเดอร์นอก lane จึงถูกปฏิเสธก่อนถึงกฎของ workspace
                ref: packages/core/src/lanes.ts#laneCommandDenial
                emits: [cd-outside-lane]

    - id: result
      lane: tool
      at: executor
      beat:
        title: "bash ไม่รัน แต่ตอบว่าควรทำอะไรแทน"
        text: >-
          ไม่มีอะไรรัน ไม่มีการ์ดถามคุณ ผลของ call เป็น error ที่มีวิธีที่ถูก ขั้นในแชตขึ้นเครื่องหมายล้มเหลว
        from: engine
        to: panel
        sees: { kind: step, label: bash, status: failed }
      do: >-
        executor โยน `ToolError` `runExecutor` แปลงเป็นผลสถานะ `error` ด้วยข้อความของมัน ไม่มีอะไรรัน ไม่มีการ์ด
        และไม่มีบันทึกการอนุญาต
      ref: "packages/engine/src/tools/index.ts#\"if (error instanceof ToolError) return { status: 'error', text: error.message };\""

    - use: tool-result-returns

    - id: next
      lane: loop
      at: step
      beat:
        title: "Geno เรียก model ต่อพร้อมคำแนะนำ"
        text: >-
          turn ไม่หยุด Geno ส่งบทสนทนาทั้งหมดไปให้ model อีกครั้งในคำขอใหม่ ท้ายคำขอคือผลที่บอกว่าเป็น error
          พร้อมวิธีที่ถูก ทุกทางมาถึงขั้นนี้แบบเดียวกัน การ์ดข้างล่างเป็นข้อความสุดท้ายของคำขอจริงจากการรันเดียวกับการ์ดแรก
          (ทาง dev server) ดู `is_error: true` ซึ่งบอก model ว่า call นี้ล้มเหลว และ `content` ที่มีวิธีที่ถูก
        from: engine
        to: model
        sees:
          kind: payload
          source: docs/results/real-usecases/runs/A12-background-server/sonnet-1/wire.jsonl#line=7
          quote: "Start it on its own instead: call bash with {\"command\": \"npm run dev\", \"run_in_background\": true}"
          select: messages[6].content
          highlight: ['[0].is_error', '[0].content']
      do: >-
        `loopStep` เห็น `tool-result` ล่าสุดจึงตัดสิน `call-model` turn ไม่หยุด model ได้ `tool_result` ที่มี `is_error: true`
        พร้อมวิธีที่ถูก
      ref: packages/core/src/loop.ts#loopStep
      emits: [call-model]
      phase: calling-model

    - use: model-call

    - id: retry
      lane: model
      beat:
        title: "Model ทำตามคำแนะนำ"
        text: >-
          model ตอบหลังได้คำขอนี้เท่านั้น และทำตามวิธีที่ผลบอก ทาง `sleep` ผลบอกให้ใช้ `monitor` หรือรันแบบเบื้องหลังแล้วจบ turn
          ทาง lane ผลบอกให้ทำงานใน lane เท่านั้นและไม่ลองคำสั่งนั้นซ้ำ model มักทำงานต่อใน lane ในทาง dev server มันขอรัน `npm run dev` แบบเบื้องหลังแทน
          ซึ่งจะได้ชื่องานกลับมาทันที
          การ์ดข้างล่างเป็นคำตอบจริงต่อคำขอในการ์ดก่อนหน้า ดู `input` ที่ไม่มี `&` แล้ว และมี `run_in_background: true`
        from: model
        to: engine
        sees:
          kind: payload
          source: docs/results/real-usecases/runs/A12-background-server/sonnet-1/session.jsonl#seq=12
          select: content
          highlight: ['[0].input']
        end: "model ทำตามคำแนะนำ"
      do: >-
        model เรียกตามคำแนะนำ เช่น `bash` ด้วย `npm run dev` และ `run_in_background: true` ซึ่งได้ job id กลับมาทันที
      ref: "packages/engine/src/gateway.ts#\"stopReason: message.stop_reason,\""
      emits: [tool_use]
      end: { turn: continues, reason: run-tools }
---

การตรวจเหล่านี้กันไม่ให้ call หนึ่งตัวค้างจนถึง timeout 120 วินาทีโดยไม่ได้อะไร
ข้อความปฏิเสธจึงไม่ได้บอกแค่ว่าไม่ได้ แต่บอก tool ที่ใช้แทนได้

| คำสั่ง | ถูกจับโดย | ให้ใช้แทน |
| --- | --- | --- |
| `sleep 30 && ...` | `leadingSleep` | `monitor` หรือ `run_in_background` |
| `npm run dev`, `vite`, `... &` | `serverStartOf` | `run_in_background` แล้ว `monitor` หรือ `preview_start` |
| `cd ../main`, `git -C ../main`, `GIT_DIR=...` | `laneCommandDenial` | ทำงานใน lane เท่านั้น |

สิ่งที่ควรสังเกต

- **ไม่ใช่การปฏิเสธของผู้ใช้** ผลมีสถานะ `error` ไม่ใช่ `rejected` หรือ `denied` turn ทำงานต่อ และแผงแสดงขั้นนั้นว่าล้มเหลว
- **เกิดก่อนนโยบาย** คำสั่งเหล่านี้ไม่ไปถึง `ruledDenial` การ์ด หรือ classifier แม้กฎของ workspace จะอนุญาตคำสั่งนั้นไว้
- **ไม่มีงานเบื้องหลังก็ไม่ตรวจ** ที่ที่ไม่มี `run_in_background` ให้ใช้ เช่น subagent บางตัว `sleep` และ dev server รันได้ตามปกติ
  และจะถูกฆ่าเมื่อครบเวลา ดู [คำสั่งที่ปลอดภัยรันโดยไม่ถาม](/scenarios/tool/bash-safe-runs/)

อ่านต่อที่ [Model รันคำสั่งเบื้องหลัง](/scenarios/tool/bash-background/)
