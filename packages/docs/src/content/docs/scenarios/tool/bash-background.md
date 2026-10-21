---
title: "Model รันคำสั่งเบื้องหลัง"
description: model รันคำสั่งที่ไม่จบเองด้วย run_in_background harness เปิดงาน bg-1 ใน sandbox แล้วคืนผลทันที งานรันต่อขณะที่ turn ทำงานอื่น
scenario:
  surface: vscode
  given:
    - turn กำลังทำงานในโหมด Ask หรือ Auto
    - session นี้ยังไม่มีงานเบื้องหลัง ไม่มี hook และไม่มีกฎของ workspace ที่ตรงกับคำสั่ง
  trigger: >-
    model ขอเรียก `bash` ด้วย `pnpm tsc --watch` และ `run_in_background: true`
  covers: [tool.bash-background]
  related: [tool.bash-safe-runs, bg.command-ends-wakes, perm.plan-edit-refused]
  steps:
    - id: asks
      lane: model
      beat:
        title: "Model ขอรันคำสั่งที่ไม่จบเองเบื้องหลัง"
        text: >-
          `pnpm tsc --watch` เฝ้าไฟล์และไม่จบเอง model จึงขอรันเป็นงานเบื้องหลัง คือคำสั่งที่รันต่อไปโดย turn ไม่รอให้จบ
          การ์ดข้างล่างมาจาก run จริงที่ขอรัน dev server แบบเดียวกัน ดู `input` ของ `tool_use` ที่ไฮไลต์ไว้
          มี `command` และ `run_in_background: true` ซึ่งเป็นตัวบอกว่าให้รันเบื้องหลัง
        from: model
        to: engine
        sees:
          kind: payload
          source: docs/results/real-usecases/runs/A12-background-server/1/session.jsonl#seq=7
          select: content
          highlight:
            - "[2].input"
          collapse:
            - "[0].thinking"
      do: >-
        model ขอรัน `pnpm tsc --watch` เป็นงานเบื้องหลัง เพราะคำสั่งนี้เฝ้าไฟล์และไม่จบเอง จบคำตอบด้วย `stop_reason: tool_use`
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
        title: "แชตขึ้นขั้นของคำสั่ง"
        text: >-
          Geno จัดคิว `bash` ให้รันทีละตัว แชตขึ้นขั้นใหม่พร้อมจุดหมุน
        from: engine
        to: panel
        sees: { kind: step, label: pnpm tsc --watch, status: running }

    - id: checks
      lane: tool
      at: executor
      beat:
        title: "Geno ตรวจคำสั่งเบื้องหลังด้วยกฎชุดเดิม"
        text: >-
          คำสั่งปกติเป็นแบบรอผล Geno รอให้จบก่อนตอบ model จึงปฏิเสธคำสั่งรอผลที่ขึ้นต้นด้วย `sleep` หรือเปิด dev server
          เพราะจะทำให้ turn ค้าง คำสั่งเบื้องหลังข้ามการตรวจสองข้อนี้ แต่ยังผ่านกฎ permission ชุดเดียวกับคำสั่งปกติ
          ต่างกันข้อเดียวคือโหมด Plan ซึ่งเป็นโหมดอ่านอย่างเดียว ปฏิเสธงานเบื้องหลังทั้งหมด
          คำสั่งนี้ไม่ติดกฎใด จึงไม่มีการ์ดถามคุณ
        from: engine
        to: engine
      do: >-
        `bash` เห็น `run_in_background` จึงข้ามการตรวจ `sleep` นำหน้าและการเปิด dev server ซึ่งปฏิเสธเฉพาะคำสั่งที่รันแบบรอผล
      ref: "packages/engine/src/tools/agent.ts#\"const background = run_in_background ? tools.background : undefined;\""

    - id: rules
      lane: policy
      at: rules
      do: >-
        `approveCommand` ตรวจคำสั่งเบื้องหลังด้วยกฎชุดเดียวกับคำสั่งปกติ ต่างกันข้อเดียวคือโหมด Plan ปฏิเสธงานเบื้องหลังทั้งหมด
        `pnpm tsc --watch` ไม่ติดกฎใด จึงไม่มีการ์ดและไม่มี classifier
      ref: "packages/engine/src/tools/agent.ts#\"const approveCommand = async (command: string, ctx: ToolContext, background: boolean\""

    - id: start
      lane: tool
      at: sandbox
      beat:
        title: "Geno เปิดงาน bg-1 ใน sandbox"
        text: >-
          Geno ตั้งชื่องานว่า bg-1 แล้วเปิดคำสั่งใน sandbox ซึ่งเป็นกรอบของระบบปฏิบัติการที่จำกัดว่าคำสั่งเขียนไฟล์และต่อเครือข่ายได้แค่ไหน
          งานนี้ไม่มีเวลาสูงสุด รันพร้อมกันได้ 4 งานต่อ session output
          ส่วนท้ายไม่เกิน 1 MB ถูกเก็บไว้ในหน่วยความจำและในไฟล์ log ของงาน
        from: engine
        to: machine
      do: >-
        `BackgroundJobs.start` ตั้งชื่องานเป็น `bg-1` (รันพร้อมกันได้สูงสุด 4 งานต่อ session) เปิดคำสั่งใน sandbox
        โดยไม่มีเวลาสูงสุด และเก็บ output ส่วนท้ายสุดไม่เกิน 1 MB (`BACKGROUND_OUTPUT_CAP`) ไว้ในหน่วยความจำและในไฟล์ `background/bg-1.log` ในโฟลเดอร์ spill ของ session
      ref: packages/engine/src/background.ts#BackgroundJobs.start
      emits: [bg-1]

    - id: changed
      lane: server
      at: updates
      do: >-
        `backgroundShared` ส่งสถานะของงานไปที่แผง Tasks และส่ง `tool_call_update` ที่มี `BACKGROUND_META`
        ให้หน้าต่างที่แสดง session นี้ ทุกครั้งที่งานเปลี่ยนสถานะหรือพิมพ์ output
      ref: packages/engine/src/background-hooks.ts#backgroundShared
      emits: [tool_call_update, BACKGROUND_META]

    - id: action
      lane: editor
      at: chat
      alongside: true
      do: >-
        `updateActions` เห็น `BACKGROUND_META` จึงส่ง action `background` ที่ผูกกับ call ของ `bash`
      ref: packages/extension/src/chat/session-updates.ts#updateActions
      emits: [background]

    - id: row
      lane: panel
      at: rail
      beat:
        title: "แชตขึ้นแถว Running in background"
        text: >-
          ทุกครั้งที่งานเปลี่ยนสถานะหรือพิมพ์ output แผง Tasks ซึ่งเป็นรายการงานของ Geno และแชตได้รับแจ้ง
          ใต้กล่องของคำสั่งมีแถวสถานะ และปุ่ม Stop ของงานนั้นเอง ซึ่งไม่ใช่ปุ่ม Stop ของ turn
        from: panel
        to: you
        sees: "แถว \"Running in background as bg-1\" ไอคอนจุดทึบ และปุ่ม Stop ที่ชี้แล้วขึ้น \"Stop bg-1: SIGTERM, then SIGKILL\""
      alongside: true
      do: >-
        ใต้กล่องของคำสั่งขึ้นแถวสถานะงานพร้อมปุ่ม Stop ของงานนั้นเอง ซึ่งไม่ใช่ปุ่ม Stop ของ turn
      sees: >-
        แถว "Running in background as bg-1" ไอคอนจุดทึบ และปุ่ม [Stop] (ชี้แล้วขึ้น "Stop bg-1: SIGTERM, then SIGKILL")
      ref: packages/extension/src/chat/render.ts#jobRow

    - id: returns
      lane: tool
      at: executor
      beat:
        title: "bash คืนผลทันทีโดยไม่รอ"
        text: >-
          Geno เขียนข้อความผลไว้ใน log ผลนี้ถึง model ตอนเรียกครั้งถัดไป ระหว่างนี้ model ไม่ได้ตอบอะไร
          ในการ์ด ดู `content` ของ `tool_result` ผลบอกชื่องาน bg-1 และที่อยู่ไฟล์ output และบอก model ว่าไม่ต้องคอยถาม
          Geno จะบอกเองเมื่องานจบ
        from: engine
        to: engine
        sees:
          kind: payload
          source: docs/results/real-usecases/runs/A12-background-server/1/requests.jsonl#seq=10
          select: messages[-1].content[0]
          highlight:
            - content
          quote: Geno tells you when it ends, so do not poll it
      do: >-
        `bash` คืนผลทันทีโดยไม่รอคำสั่ง ข้อความผลบอกชื่องาน ที่อยู่ไฟล์ output และบอก model ว่าไม่ต้องคอยถาม
        ("Started background command bg-1. ... Geno tells you when it ends, so do not poll it.")
      ref: packages/core/src/background.ts#backgroundStartText

    - use: tool-result-returns

    - id: next
      lane: loop
      at: step
      beat:
        title: "Geno เรียก model อีกครั้ง"
        text: >-
          Geno ส่งบทสนทนาทั้งหมดไปให้ model อีกครั้งในคำขอใหม่ ท้ายคำขอคือคำขอ `bash` ของ model และผลที่บอกว่างานเริ่มแล้ว
          ขณะที่ bg-1 ยังรันอยู่ การ์ดข้างล่างเป็นคำขอจริงจากการรันเดียวกับการ์ดแรก
        from: engine
        to: model
        sees:
          kind: payload
          source: docs/results/real-usecases/runs/A12-background-server/1/requests.jsonl#seq=10
          select: messages
          collapse: ['[0]', '[1]', '[2]']
          highlight: ['[3].content[2]', '[4].content[0]']
      do: >-
        `loopStep` เห็น `tool-result` ล่าสุดจึงตัดสิน `call-model` ขณะที่ `bg-1` ยังรันอยู่
      ref: packages/core/src/loop.ts#loopStep
      emits: [call-model]
      phase: calling-model

    - id: reply
      lane: model
      beat:
        title: "Model ทำงานอื่นต่อ"
        text: >-
          model ตอบหลังได้คำขอนี้เท่านั้น ในการรันจริงนี้ model ไม่รอ server แต่ขอรัน `bash` อีกตัว
          ดู `command` ใน `input` ที่ไฮไลต์ไว้ เป็นลูปที่เรียก /health ซ้ำจนกว่า server จะพร้อม ขณะที่ bg-1 ยังรันอยู่
        from: model
        to: engine
        sees:
          kind: payload
          source: docs/results/real-usecases/runs/A12-background-server/1/session.jsonl#seq=10
          select: content
          collapse: ['[0].thinking']
          highlight: ['[1].input']
        end: "งานรันต่อเบื้องหลัง"
      do: >-
        model อ่าน `tool_result` ที่บอกว่า `bg-1` เริ่มแล้ว และตอบด้วยคำขอใหม่ ในการรันนี้คือ `bash` อีกตัว
        จบคำตอบด้วย `stop_reason: tool_use` turn วนต่อขณะที่ `bg-1` ยังรันอยู่
      ref: "packages/engine/src/gateway.ts#\"stopReason: message.stop_reason,\""
      emits: [tool_use]
      end: { turn: continues, reason: run-tools }
---

งานเบื้องหลังเป็นของ engine ไม่ใช่ของ turn มันรันต่อหลัง turn จบ และแสดงในแผง Tasks จนกว่าจะจบหรือถูกหยุด

| ทำอะไรกับงาน | ใช้อะไร |
| --- | --- |
| อ่าน output | `bash_output` หรือ `read` ไฟล์ output |
| รอบรรทัดที่ต้องการ เช่น "listening" | `monitor` |
| หยุดงาน | `task_stop` (model) หรือปุ่ม Stop ใต้กล่องคำสั่ง (ผู้ใช้) |

สิ่งที่ควรสังเกต

- **sandbox เดียวกับคำสั่งปกติ** งานเบื้องหลังเขียนได้เฉพาะใน workspace และไดเรกทอรีชั่วคราว และใช้เครือข่ายไม่ได้ถ้าไม่ได้อนุญาตโดเมนไว้
  ความต่างคือไม่มีเวลาสูงสุด
- **การจบของงานกลับมาหา model เอง** เมื่อ `bg-1` จบ engine ส่งข่าวเข้า inbox ของ session ซึ่งเป็นคิวข่าวที่รอส่งให้ model `deliver()` บันทึกข่าวนั้นลง log ที่จุดปลอดภัยถัดไป คือหลังผลของ tool ชุดล่าสุดและก่อนเรียก model ครั้งถัดไป
  หรือปลุก session ขึ้นมาใหม่ถ้าไม่มี turn ทำงาน
- **โหมด Plan ไม่มีงานเบื้องหลัง** `approveCommand` ปฏิเสธด้วย `ToolError` ก่อนดูกฎใดๆ
  ("background commands are not available: ...")

คำสั่งที่รอผลจนจบ ดู [คำสั่งที่ปลอดภัยรันโดยไม่ถาม](/scenarios/tool/bash-safe-runs/)
